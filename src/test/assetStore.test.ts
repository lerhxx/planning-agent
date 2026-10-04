/**
 * `AssetStore` 落盘实现（T02 的 J1 落地）。
 *
 * 证明六件事：
 * 1. `put` → `get` 往返（字节与描述符都对得上）；
 * 2. TTL 过期 → `get` 给出 **`EXPIRED`**（调用方转 `ASSET_EXPIRED`，**不静默当成"图没了"**）；
 * 3. `sweepExpired` 真的清掉了过期条目并**报数**；
 * 4. **路径穿越防护**：非 UUID 的 assetId 一律拒（落盘路径由 assetId 拼出）；
 * 5. ★ **"没有"和"坏了"必须走两条路**：存储 I/O 故障必须报 `IO_ERROR`，
 *    绝不能被压扁成 `NOT_FOUND` / `EXPIRED`（那会让用户收到"附件已过期"的错误诊断）；
 * 6. ★ 对照组：描述符**内容**写坏仍然判 `NOT_FOUND` —— 证明 ⑤ 的分类没有把
 *    "坏内容"误判成"磁盘故障"（两者现象一样，都是读不出东西）。
 *
 * ★ 全程**注入时钟**，不碰 `Date.now()`：TTL 一类的判决必须可复现，
 *   不能让"机器今天卡不卡"影响结论。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSET_TTL_MS,
  AssetStoreIoError,
  createFileAssetStore,
  isWellFormedAssetId,
  makeAssetRef,
  parseAssetRef,
  type AssetLookup,
  type AssetStore,
} from '@/app/api/assets/store';

/** 固定纪元（2026-01-01 附近）。全文件共用，杜绝真实时钟。 */
const NOW = 1_766_000_000_000;

let tmpRoot = '';
let store: AssetStore;
const clock = NOW;

/** 读到才算数；读不到就把 reason 抛出来（比 `!` 非空断言更响：能看出是"过期"还是"磁盘坏了"）。 */
async function mustGet(target: AssetStore, assetId: string): Promise<Extract<AssetLookup, { ok: true }>> {
  const found = await target.get(assetId);
  if (!found.ok) throw new Error(`期望读到 ${assetId}，实际 reason=${found.reason}`);
  return found;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'asset-store-'));
  store = createFileAssetStore(path.join(tmpRoot, 'assets'), {
    ttlMs: ASSET_TTL_MS,
    now: () => clock,
  });
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('FileAssetStore', () => {
  it('put → get 往返：字节与描述符都对得上', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const record = await store.put({ bytes, name: 'a.png', mime: 'image/png' });

    expect(isWellFormedAssetId(record.assetId)).toBe(true);
    expect(record.byteSize).toBe(5);
    // ★ 不再对比 `Date.now()`：注入时钟下这是**等值**断言，比"大于"强，且不依赖真实时间。
    expect(record.expiresAt).toBe(NOW + ASSET_TTL_MS);

    const stored = await mustGet(store, record.assetId);
    expect(stored.value.record.name).toBe('a.png');
    expect([...stored.value.bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it('不存在的 assetId → NOT_FOUND（不是 IO_ERROR）', async () => {
    const found = await store.get('6f1d3f10-0000-4000-8000-000000000000');
    expect(found).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('TTL 过期 → get 给出 EXPIRED（显式 ASSET_EXPIRED 的依据）', async () => {
    // 用注入的时钟而不是 sleep：落盘 I/O 有抖动，真实 sleep 会测出假阴性。
    let localClock = NOW;
    const shortLived = createFileAssetStore(path.join(tmpRoot, 'ttl'), {
      ttlMs: 1000,
      now: () => localClock,
    });
    const record = await shortLived.put({ bytes: new Uint8Array([9]), name: 'b.png', mime: 'image/png' });
    expect((await shortLived.get(record.assetId)).ok).toBe(true);
    localClock += 1001;
    // ★ 精确判据：不是"null"，而是"过期"。
    expect(await shortLived.get(record.assetId)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('sweepExpired 清掉过期条目并报数', async () => {
    let localClock = NOW;
    const target = createFileAssetStore(path.join(tmpRoot, 'sweep'), {
      ttlMs: 1000,
      now: () => localClock,
    });
    await target.put({ bytes: new Uint8Array([1]), name: 'c.png', mime: 'image/png' });
    await target.put({ bytes: new Uint8Array([2]), name: 'd.png', mime: 'image/png' });
    localClock += 1001;

    expect(await target.sweepExpired()).toBe(2);
    // 清过之后再扫一次：已经没有了。
    expect(await target.sweepExpired()).toBe(0);
  });

  it('sweepExpired 在过期前不误删', async () => {
    const localClock = NOW;
    const target = createFileAssetStore(path.join(tmpRoot, 'fresh'), {
      ttlMs: 60_000,
      now: () => localClock,
    });
    const record = await target.put({ bytes: new Uint8Array([1]), name: 'e.png', mime: 'image/png' });
    expect(await target.sweepExpired()).toBe(0);
    expect((await target.get(record.assetId)).ok).toBe(true);
  });

  it('★ lazy sweep 节流：窗口内的 put 不重复全目录扫描，TTL 语义不变', async () => {
    let localClock = NOW;
    const throttled = createFileAssetStore(path.join(tmpRoot, 'throttled'), {
      ttlMs: 1000,
      now: () => localClock,
    });

    const older = await throttled.put({ bytes: new Uint8Array([1]), name: 'old.png', mime: 'image/png' });
    localClock += 1001; // older 已过期
    await throttled.put({ bytes: new Uint8Array([2]), name: 'new.png', mime: 'image/png' }); // 节流 → 不扫

    // ★ 节流只是**推迟清理**：older 没有被这次 put 顺手清掉（否则下面会是 0）。
    expect(await throttled.sweepExpired()).toBe(1);
    // 但过期判定不受影响：get 拿不到它。
    // ★ 此刻磁盘上的描述符已被上一次 sweepExpired 删掉，所以原因是 NOT_FOUND 而不是 EXPIRED
    // —— "被清掉了"和"当时就过期了"是两件事，如实区分；route 对两者都回 410。
    expect(await throttled.get(older.assetId)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('★ 对照组：interval=0 时每次 put 都扫（证明上一条的"没扫"不是因为 sweep 坏了）', async () => {
    let localClock = NOW;
    const eager = createFileAssetStore(path.join(tmpRoot, 'eager'), {
      ttlMs: 1000,
      sweepIntervalMs: 0,
      now: () => localClock,
    });

    const older = await eager.put({ bytes: new Uint8Array([1]), name: 'old.png', mime: 'image/png' });
    localClock += 1001;
    await eager.put({ bytes: new Uint8Array([2]), name: 'new.png', mime: 'image/png' }); // 每次都扫

    expect(await eager.sweepExpired()).toBe(0); // older 已被上一次 put 顺手清掉
    // 同上：描述符已不在盘上 → NOT_FOUND（不是 EXPIRED）。
    expect(await eager.get(older.assetId)).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('★ 磁盘故障必须报 IO_ERROR —— 不许被压扁成"没有 / 过期"', async () => {
    // 怎么造一次**真的** I/O 故障（不靠 mock、不靠 chmod）：
    // 把 `<assetId>.json` 变成**目录**。readFile 一个目录会拿到 EISDIR ——
    // 它不是 ENOENT，所以正好落在"故障"那一侧。跨平台稳定，也不受 root 权限影响。
    const dir = path.join(tmpRoot, 'io-error');
    const assetId = '6f1d3f10-9999-4999-8999-999999999999';
    mkdirSync(path.join(dir, `${assetId}.json`), { recursive: true });

    const broken = createFileAssetStore(dir, { ttlMs: 1000, now: () => NOW });

    // ① get：必须是 IO_ERROR。若是 NOT_FOUND / EXPIRED，route 就会回 410，
    //    用户被告知"附件过期了" —— 而真相是存储坏了，他重传一百次也没用。
    expect(await broken.get(assetId)).toEqual({ ok: false, reason: 'IO_ERROR' });
    // ② sweep：返回值是数字，没法表达失败 → 抛（返回 0 会冒充"扫过了，很干净"）。
    await expect(broken.sweepExpired()).rejects.toBeInstanceOf(AssetStoreIoError);
  });

  it('★ 对照组：描述符**内容**写坏 → NOT_FOUND，不是 IO_ERROR', async () => {
    // 上一条的"IO_ERROR"不能是"凡是读不出就报故障"的另一种说法。
    // 内容层面的读不出（旧版本写的 / 外来脏文件）必须仍然判"没有"，
    // 否则 sweep 扫目录时会因为一个脏文件就整体崩掉。
    const dir = path.join(tmpRoot, 'broken-content');
    const target = createFileAssetStore(dir, { ttlMs: 1000, now: () => NOW });
    const record = await target.put({ bytes: new Uint8Array([7]), name: 'f.png', mime: 'image/png' });

    writeFileSync(path.join(dir, `${record.assetId}.json`), '{ not json ', 'utf8');
    expect(await target.get(record.assetId)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    // sweep 遇到它也只是跳过，不崩。
    expect(await target.sweepExpired()).toBe(0);
  });

  it('路径穿越防护：非 UUID 一律拒（理由是 MALFORMED_ID）', async () => {
    expect(isWellFormedAssetId('../evil')).toBe(false);
    expect(isWellFormedAssetId('1234')).toBe(false);
    expect(await store.get('../evil')).toEqual({ ok: false, reason: 'MALFORMED_ID' });
    expect(await store.get('..%2Fevil')).toEqual({ ok: false, reason: 'MALFORMED_ID' });
  });

  it('ref 编解码：asset://<assetId>', () => {
    const assetId = '6f1d3f10-1111-4111-8111-111111111111';
    expect(parseAssetRef(makeAssetRef(assetId))).toBe(assetId);
    expect(parseAssetRef('https://evil.example/x')).toBeNull();
    expect(parseAssetRef('asset://not-a-uuid')).toBeNull();
  });
});

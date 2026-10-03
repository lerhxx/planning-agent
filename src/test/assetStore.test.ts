/**
 * `AssetStore` 落盘实现（T02 的 J1 落地）。
 *
 * 证明四件事：
 * 1. `put` → `get` 往返（字节与描述符都对得上）；
 * 2. TTL 过期 → `get` 返回 `null`（调用方转 `ASSET_EXPIRED`，**不静默当成"图没了"**）；
 * 3. `sweepExpired` 真的清掉了过期条目并**报数**；
 * 4. **路径穿越防护**：非 UUID 的 assetId 一律拒（落盘路径由 assetId 拼出）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFileAssetStore,
  isWellFormedAssetId,
  makeAssetRef,
  parseAssetRef,
  type AssetStore,
} from '@/app/api/assets/store';

let tmpRoot = '';
let store: AssetStore;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'asset-store-'));
  store = createFileAssetStore(path.join(tmpRoot, 'assets'));
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
    expect(record.expiresAt).toBeGreaterThan(Date.now());

    const stored = await store.get(record.assetId);
    expect(stored).not.toBeNull();
    expect(stored!.record.name).toBe('a.png');
    expect([...stored!.bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it('不存在的 assetId → null', async () => {
    expect(await store.get('6f1d3f10-0000-4000-8000-000000000000')).toBeNull();
  });

  it('TTL 过期 → get 返回 null（显式 ASSET_EXPIRED 的依据）', async () => {
    // 用注入的时钟而不是 sleep：落盘 I/O 有抖动，真实 sleep 会测出假阴性。
    let clock = 1_000_000;
    const shortLived = createFileAssetStore(path.join(tmpRoot, 'ttl'), {
      ttlMs: 1000,
      now: () => clock,
    });
    const record = await shortLived.put({ bytes: new Uint8Array([9]), name: 'b.png', mime: 'image/png' });
    expect(await shortLived.get(record.assetId)).not.toBeNull();
    clock += 1001;
    expect(await shortLived.get(record.assetId)).toBeNull();
  });

  it('sweepExpired 清掉过期条目并报数', async () => {
    let clock = 2_000_000;
    const target = createFileAssetStore(path.join(tmpRoot, 'sweep'), {
      ttlMs: 1000,
      now: () => clock,
    });
    await target.put({ bytes: new Uint8Array([1]), name: 'c.png', mime: 'image/png' });
    await target.put({ bytes: new Uint8Array([2]), name: 'd.png', mime: 'image/png' });
    clock += 1001;

    expect(await target.sweepExpired()).toBe(2);
    // 清过之后再扫一次：已经没有了。
    expect(await target.sweepExpired()).toBe(0);
  });

  it('sweepExpired 在过期前不误删', async () => {
    const target = createFileAssetStore(path.join(tmpRoot, 'fresh'), { ttlMs: 60_000 });
    const record = await target.put({ bytes: new Uint8Array([1]), name: 'e.png', mime: 'image/png' });
    expect(await target.sweepExpired()).toBe(0);
    expect(await target.get(record.assetId)).not.toBeNull();
  });

  it('★ lazy sweep 节流：窗口内的 put 不重复全目录扫描，TTL 语义不变', async () => {
    let clock = 9_000_000;
    const throttled = createFileAssetStore(path.join(tmpRoot, 'throttled'), {
      ttlMs: 1000,
      now: () => clock,
    });

    const older = await throttled.put({ bytes: new Uint8Array([1]), name: 'old.png', mime: 'image/png' });
    clock += 1001; // older 已过期
    await throttled.put({ bytes: new Uint8Array([2]), name: 'new.png', mime: 'image/png' }); // 节流 → 不扫

    // ★ 节流只是**推迟清理**：older 没有被这次 put 顺手清掉（否则下面会是 0）。
    expect(await throttled.sweepExpired()).toBe(1);
    // 但过期判定不受影响：get 仍按 expiresAt 判。
    expect(await throttled.get(older.assetId)).toBeNull();
  });

  it('★ 对照组：interval=0 时每次 put 都扫（证明上一条的"没扫"不是因为 sweep 坏了）', async () => {
    let clock = 10_000_000;
    const eager = createFileAssetStore(path.join(tmpRoot, 'eager'), {
      ttlMs: 1000,
      sweepIntervalMs: 0,
      now: () => clock,
    });

    const older = await eager.put({ bytes: new Uint8Array([1]), name: 'old.png', mime: 'image/png' });
    clock += 1001;
    await eager.put({ bytes: new Uint8Array([2]), name: 'new.png', mime: 'image/png' }); // 每次都扫

    expect(await eager.sweepExpired()).toBe(0); // older 已被上一次 put 顺手清掉
    expect(await eager.get(older.assetId)).toBeNull();
  });

  it('路径穿越防护：非 UUID 一律拒', async () => {
    expect(isWellFormedAssetId('../evil')).toBe(false);
    expect(isWellFormedAssetId('1234')).toBe(false);
    expect(await store.get('../evil')).toBeNull();
    expect(await store.get('..%2Fevil')).toBeNull();
  });

  it('ref 编解码：asset://<assetId>', () => {
    const assetId = '6f1d3f10-1111-4111-8111-111111111111';
    expect(parseAssetRef(makeAssetRef(assetId))).toBe(assetId);
    expect(parseAssetRef('https://evil.example/x')).toBeNull();
    expect(parseAssetRef('asset://not-a-uuid')).toBeNull();
  });
});

/**
 * travel v2 · T01/T02 **独立验证**（QA：严过关）。
 *
 * 与实现方已有三套用例（assetStore / attachmentChannel / clarifyForm）**刻意错位**：
 * 那里证明"功能在"，这里只打**新边界**与**静默类问题** ——
 * 系统的头号敌人不是报错，而是"悄悄做了个决定，谁都不知道"。
 *
 * 挑四条主线：
 *
 * ① **判据的机器复核**：破 0（shared / src/core 无领域词）用**带对照组的扫描器**跑，
 *    而不是靠人肉 grep。理由很实在：扫描器扫到一个空目录、或读不到文件、或词本身拼错了，
 *    返回的都是同一个「0 条命中」—— 和真正的"干净"在现象上完全一样。
 *    所以这里先证明"这台秤能称出重量"，再拿它去过闸门。
 *
 * ② **数量上限的三道门必须重合**：同一个"20 张"被三处独立实现
 *    （`precheckFiles` 客户端预检 / `zRunRequest` 服务端 schema / `POST /api/assets` 计数）。
 *    任意一处错位，都会变成"前端说成功、后端只收到 18 张"的静默裁剪。
 *
 * ③ **「半成功」必须不可达**：混合批次里只要有一个不合格，就必须一个都不落盘。
 *    半成功最难发现 —— 它在 UI 上是"部分成功"。
 *
 * ④ **回灌能不能真的让玩家脱身**：`submit_form` / `select_option` 之后，
 *    步骤必须真的能重新被执行到。这条没法“肉眼看得出来”，只能靠跑两轮 prove。
 *
 * ★ 纪律：**锁语义，不锁文案**。凡是精确字串/数量/内部实现细节，都不进断言；
 *   断言只表达"用户能不能察觉 / 判决是不是确定的 / 会不会重复做一件事"。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '@/app/api/assets/route';
import { createFileAssetStore, type AssetStore } from '@/app/api/assets/store';
import {
  ATTACHMENT_MAX_COUNT,
  makeFormKey,
  parseFormKey,
  zClarifyQuestion,
  type Attachment,
  type Plan,
  type Step,
} from '@/shared/plan/types';
import { zRunRequest, type RunContext } from '@/shared/run/types';
import type { StreamEvent } from '@/shared/stream/events';
import { applyAnswers, buildClarifyQuestions, needsClarification } from '@/src/core/goal/clarify';
import { parseGoal } from '@/src/core/goal/parse';
import { getDomainPack, registerDomainPack } from '@/src/core/registry/domainRegistry';
import { createMockRuntime } from '@/src/core/runtime/mock';
import { runGoal, type EngineDeps, type EngineResult } from '@/src/core/run/engine';
import { registerAllDomains } from '@/src/domains';
import { precheckFiles } from '@/src/features/attachment/uploadAssets';
import { applyNodeEvent, initialNodeState, toNodeList } from '@/src/features/run/nodeReducer';

/* ================================================================== *
 * 工具
 * ================================================================== */

const GOAL = '三路素材汇总成一版结论，预算不超过 500 元，三天内完成';

function pngFile(name: string, size = 8): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

function attachment(index: number): Attachment {
  return {
    id: `asset-${index}`,
    kind: 'image',
    name: `shot-${index}.png`,
    mimeType: 'image/png',
    byteSize: 1024,
    ref: `asset://asset-${index}`,
  };
}

function attachmentList(count: number): Attachment[] {
  return Array.from({ length: count }, (_, index) => attachment(index));
}

/** 把一组事件喂给**真实的** nodeReducer，还原前端会拿到的节点。 */
function reduceNodes(events: readonly StreamEvent[]): ReturnType<typeof toNodeList> {
  let state = initialNodeState;
  for (const event of events) state = applyNodeEvent(state, event);
  return toNodeList(state);
}

/* ================================================================== *
 * ① 破 0 判据的机器复核（自带对照组）
 * ================================================================== */

describe('判据复核：shared / src/core 无领域词（机械扫描 + 对照组）', () => {
  /** 领域词抽样。覆盖英文 id、中文词、驼峰组件名三种写法。 */
  const DOMAIN_WORDS = ['travel', '旅游', '行程', '航班', '酒店', '景点'];

  function scan(dir: string): { files: string[]; hits: Array<{ file: string; word: string }> } {
    const files: string[] = [];
    const hits: Array<{ file: string; word: string }> = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = nodePath.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        files.push(full);
        const text = readFileSync(full, 'utf8');
        for (const word of DOMAIN_WORDS) {
          if (text.includes(word)) hits.push({ file: full, word });
        }
      }
    };
    if (existsSync(dir)) walk(dir);
    return { files, hits };
  }

  // 全仓递归读盘在满载并行下会超过默认 5s：扫一次，三条断言共用。
  let sharedScan: ReturnType<typeof scan>;
  let coreScan: ReturnType<typeof scan>;

  beforeAll(() => {
    sharedScan = scan(nodePath.resolve(process.cwd(), 'shared'));
    coreScan = scan(nodePath.resolve(process.cwd(), 'src/core'));
  }, 60_000);

  it('★ 对照组：**扫描器本身是好的**（同样的门 fake 领域文件上必须命中）', () => {
    const root = mkdtempSyncScoped('scanner-control');
    writeFileSync(nodePath.join(root, 'fake-domain.ts'), 'export const id = "travel"; // 旅游 行程');
    writeFileSync(nodePath.join(root, 'clean.ts'), 'export const id = "generic";');

    const controlled = scan(root);
    expect(controlled.files).toHaveLength(2); // 扫描器真的读了文件，不是空集
    expect(controlled.hits.length).toBeGreaterThan(0); // ★ 同样的门，脏文件上必须是红的

    rmSync(root, { recursive: true, force: true });
  });

  it('★ 对照组2：扫描范围非空（“0 命中”如果是扫了个空气，就是十足的假通过）', () => {
    expect(coreScan.files.length).toBeGreaterThan(10);
    expect(sharedScan.files.length).toBeGreaterThan(3);
  });

  it('shared/** 与 src/core/** 的领域词命中数必须为 0', () => {
    const all = [...sharedScan.hits, ...coreScan.hits];
    // 失败信息带上文件：行号需要人再落一层，这里先把「谁命中了」摊出来。
    expect(all.map((hit) => `${hit.file} :: ${hit.word}`)).toEqual([]);
  });
});

/** `mkdtemp` 的同步版（仅用于扫描器对照组，避免 async 污染 describe）。 */
function mkdtempSyncScoped(prefix: string): string {
  const base = nodePath.join(os.tmpdir(), prefix);
  mkdirSync(base, { recursive: true });
  return base;
}

/* ================================================================== *
 * ② ESM 环：冷启动的 import 顺序
 * ================================================================== */

describe('ESM 环切除后的冷启动', () => {
  it('先 import domain/types 也能起来（旧病 ReferenceError 不复发）', async () => {
    vi.resetModules();
    const domain = await import('@/shared/domain/types');
    const plan = await import('@/shared/plan/types');
    const run = await import('@/shared/run/types');

    // ★ 三个入口拿到的是**同一个**枚举对象（万一被抄成两份，":toBe" 立刻红）。
    expect(domain.zInputSignalKind).toBe(plan.zInputSignalKind);
    expect(run.zRunContext).toBeDefined();
    // 这个文件内部正在用 zInputSignalKind 构造 zDomainMeta —— 只能在**使用期**验证。
    expect(domain.zDomainMeta.safeParse({
      id: 'probe-esm',
      displayName: '探针',
      version: '1.0.0',
      schemaVersion: 1,
      description: '冷启动探针',
      matcher: {},
      requiredSignals: ['image'],
      capabilities: {},
    }).success).toBe(true);
  });

  it('反序（先 plan/types）也不分叉', async () => {
    vi.resetModules();
    const plan = await import('@/shared/plan/types');
    const domain = await import('@/shared/domain/types');
    expect(domain.zInputSignalKind).toBe(plan.zInputSignalKind);
  });

  it('冷启动后 RunContext 仍能承载 attachments（跨文件引用没断）', async () => {
    vi.resetModules();
    const { zRunContext: fresh } = await import('@/shared/run/types');
    const parsed = fresh.parse({
      runId: 'r',
      traceId: 't',
      goalId: 'g',
      domainId: 'd',
      startedAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2026-01-01T00:00:25.000Z',
      attachments: [attachment(1)],
    });
    expect(parsed.attachments).toEqual([attachment(1)]);
  });
});

/* ================================================================== *
 * ③ 数量上限：三道门必须重合（20 张）
 * ================================================================== */

describe('20 张上限：三道门必须落在同一个数', () => {
  it('门1 · precheckFiles：20 放行 / 21 显式拒（对照组：空批次放行）', () => {
    expect(precheckFiles(pngList(ATTACHMENT_MAX_COUNT))).toBe('');
    expect(precheckFiles([])).toBe(''); // ★ 对照组：0 张不是"被拒"

    const rejected = precheckFiles(pngList(ATTACHMENT_MAX_COUNT + 1));
    expect(rejected.length).toBeGreaterThan(0); // 必须给出可展示的文案，绝不静默裁剪
  });

  it('门2 · zRunRequest：20 通过 / 21 整体失败（不是丢掉多出的那一张）', () => {
    expect(zRunRequest.safeParse({ goal: GOAL, attachments: attachmentList(20) }).success).toBe(true);

    const tooMany = zRunRequest.safeParse({ goal: GOAL, attachments: attachmentList(21) });
    expect(tooMany.success).toBe(false);
    // ★ 语义：超限是整个请求失败（→ 400），不能是"留下前 20 张继续跑"。
  });

  // ★ 刻意只发**最少数量**的真文件：`FileAssetStore.put` 每次写入都要全目录 lazy sweep
  // （store.ts:151），单次成本 O(目录条目数)。目录越攒越大，这条用例也越跑越慢 ——
  // 实测：目录 100+ 条目时，20 张的一次 POST 从 5s 涨到 60s+（见报告 P2）。
  // 因此"上限内放行"由门1/门2 + 这里的单张落盘共同证明，多发几张对本次验证没有新增信息量。
  it('门3 · POST /api/assets：0 → 400 / 单张 → 200 且返回描述符 / 21 → 413', async () => {
    const empty = await POST(requestWith([]));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error?: string }).error).toBe('NO_FILE');

    const ok = await POST(requestWith(pngList(1)));
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as { assets?: Attachment[] };
    expect(payload.assets).toHaveLength(1); // 收到几个就必须返回几个描述符，不裁剪

    const tooMany = await POST(requestWith(pngList(ATTACHMENT_MAX_COUNT + 1)));
    expect(tooMany.status).toBe(413);
    expect(((await tooMany.json()) as { error?: string }).error).toBe('TOO_MANY');
  }, 120_000);

  it('★ 三道门的边界数一致（错位 = 前端报成功、后端少收，最难发现的静默裁剪）', () => {
    const gates = [
      precheckFiles(pngList(ATTACHMENT_MAX_COUNT)).length === 0,
      zRunRequest.safeParse({ goal: GOAL, attachments: attachmentList(ATTACHMENT_MAX_COUNT) }).success,
      precheckFiles(pngList(ATTACHMENT_MAX_COUNT + 1)).length > 0,
      !zRunRequest.safeParse({ goal: GOAL, attachments: attachmentList(ATTACHMENT_MAX_COUNT + 1) }).success,
    ];
    expect(gates).toEqual([true, true, true, true]);
  });

  it('★ 描述符整体不合格 → 请求整体失败，不得只丢坏的那条', () => {
    const mixed = [attachment(1), { ...attachment(2), id: '' }];
    expect(zRunRequest.safeParse({ goal: GOAL, attachments: mixed }).success).toBe(false);
  });
});

function pngList(count: number): File[] {
  return Array.from({ length: count }, (_, index) => pngFile(`shot-${index}.png`));
}

function requestWith(files: readonly File[]): Request {
  const form = new FormData();
  for (const file of files) form.append('file', file);
  return new Request('http://localhost/api/assets', { method: 'POST', body: form });
}

/* ================================================================== *
 * ④ 上传路由：边界与 "半成功必须不可达"
 * ================================================================== */

describe('POST /api/assets 的新边界', () => {
  it('白名单外 mime → 415 显式拒，且带文件名', async () => {
    const bad = new File([new Uint8Array([1])], 'spec.pdf', { type: 'application/pdf' });
    const res = await POST(requestWith([bad]));
    expect(res.status).toBe(415);
    const payload = (await res.json()) as { error?: string; name?: string };
    expect(payload.error).toBe('MIME_REJECTED');
    expect(payload.name).toBe('spec.pdf');
  });

  it(
    '★ 空 mimeType：multipart 会把它补成 octet-stream，服务端因此**显式 415**',
    async () => {
      const unknownType = new File([new Uint8Array([7, 7])], 'mystery.bin', { type: '' });
      const res = await POST(requestWith([unknownType]));

      // 实测：库层把空 type 补成了 application/octet-stream，所以 route.ts:60 的
      // `file.type.length > 0` 分支对真实 HTTP 上传**永不命中** —— 它是防御性死分支，
      // 但结果是"未知类型 → 显式 415"，没有静默。
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error?: string }).error).toBe('MIME_REJECTED');
    },
    60_000,
  );

  it('单张超限 → 413 FILE_TOO_LARGE', async () => {
    const huge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });
    const res = await POST(requestWith([huge]));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error?: string }).error).toBe('FILE_TOO_LARGE');
  });

  it(
    '0 字节文件 → 接受（不被当成"空文件已丢弃"）',
    async () => {
      const res = await POST(requestWith([pngFile('empty.png', 0)]));
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { assets?: Array<{ byteSize?: number }> };
      expect(payload.assets?.[0]?.byteSize).toBe(0);
    },
    60_000,
  );

  it(
    '★ 混合批次：第二个不合格 → **一个都不落盘**（半成功必须不可达）',
    async () => {
      const pdf = new File([new Uint8Array([1])], 'bad.pdf', { type: 'application/pdf' });
      const before = countAssetFiles();
      const res = await POST(requestWith([pngFile('good.png'), pdf]));

      expect(res.status).toBe(415);
      expect(countAssetFiles()).toBe(before); // ★ 没有任何一次 put 发生过
    },
    60_000,
  );

  it('★ 混合批次：超限的那张在**第一张之前**被判掉，同样不落盘', async () => {
    const before = countAssetFiles();
    const huge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });
    const res = await POST(requestWith([pngFile('ok.png'), huge]));
    expect(res.status).toBe(413);
    expect(countAssetFiles()).toBe(before);
  });

  it('GET 缺 id → 400；合法但不存在/已过期 → 410 ASSET_EXPIRED（都带 assetId）', async () => {
    const noId = await GET(new Request('http://localhost/api/assets'));
    expect(noId.status).toBe(400);

    const ghost = await GET(
      new Request('http://localhost/api/assets?id=6f1d3f10-0000-4000-8000-000000000000'),
    );
    expect(ghost.status).toBe(410);
    const payload = (await ghost.json()) as { error?: string; assetId?: string };
    expect(payload.error).toBe('ASSET_EXPIRED');
    expect(payload.assetId).toBe('6f1d3f10-0000-4000-8000-000000000000');
  });
});

/** 落到 `<cwd>/.tmp/assets` 的条目数（含 .json + .bin，每个资产 2 个文件）。 */
function countAssetFiles(): number {
  const dir = nodePath.resolve(process.cwd(), '.tmp/assets');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).length;
}

/* ================================================================== *
 * ⑤ FileAssetStore 的新边界（换一批，不与 assetStore.test.ts 重叠）
 * ================================================================== */

describe('FileAssetStore 的新边界', () => {
  let tmpRoot = '';
  let store: AssetStore;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(nodePath.join(os.tmpdir(), 'qa-asset-'));
    store = createFileAssetStore(nodePath.join(tmpRoot, 'store'), { ttlMs: 1000, now: () => 1_000_000 });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * ★ 显式给超时（与同文件 :300 / :318 的 60s 一致），不要依赖 vitest 默认的 5s。
   *
   * 为什么：这条用例是**纯 I/O 密集**的 —— 3 个 offset × 2 个实例 ≈ 45 次
   * `mkdir / readdir / readFile / writeFile`。实测同一条用例：
   *   单跑 442ms → 整文件跑 451ms → 全量跑 2518~2842ms → 机器更慢时 >5000ms 被判超时。
   * 而它的判决**完全由注入时钟决定**（`now: () => clock`），墙钟耗时与结论无关：
   * 用 5s 去砍它，等于让"机器今天卡不卡"来决定"TTL 语义对不对"，这是假红。
   */
  it(
    '★ TTL 边界：get 与 sweepExpired 在**同一刻**必须给出同一判决',
    async () => {
      const ttl = 1000;
      const base = 5_000_000;

      for (const offset of [-1, 0, 1]) {
        let clock = base;
        const makeProbe = (label: string): AssetStore =>
          createFileAssetStore(nodePath.join(tmpRoot, `ttl-${offset}-${label}`), {
            ttlMs: ttl,
            now: () => clock,
          });

        // ★ get 与 sweep 必须各用一份独立实例：真实实现里 `get` 命中过期会**顺手删掉**
        // （store.ts:168-171），同一实例上连续调用会让第二眼永远看不见东西。
        const reader = makeProbe('read');
        const sweeper = makeProbe('sweep');
        const recordA = await reader.put({ bytes: new Uint8Array([1]), name: 'x.png', mime: 'image/png' });
        await sweeper.put({ bytes: new Uint8Array([1]), name: 'x.png', mime: 'image/png' });
        clock = base + ttl + offset; // 恰好落在 expiresAt 上 / 前 1ms / 后 1ms

        const alive = (await reader.get(recordA.assetId)) !== null;
        const swept = (await sweeper.sweepExpired()) === 1;

        // 语义：同一时刻不该出现"能读出来但被判过期"或"判存活但已被删"。
        // 否则用户看到的是随 sweep 时机漂移的 ASSET_EXPIRED，不可重现。
        expect({ offset, alive, expired: swept }).toEqual({
          offset,
          alive: offset <= -1,
          expired: offset >= 0,
        });
      }
    },
    60_000,
  );

  it('同名共存：两次 put 同名 → 两个 assetId，字节不串台', async () => {
    const first = await store.put({ bytes: new Uint8Array([11]), name: 'dup.png', mime: 'image/png' });
    const second = await store.put({ bytes: new Uint8Array([22]), name: 'dup.png', mime: 'image/png' });

    expect(first.assetId).not.toBe(second.assetId);
    expect([...(await store.get(first.assetId))!.bytes]).toEqual([11]); // ★ 对照组：第二次没盖掉第一次
    expect([...(await store.get(second.assetId))!.bytes]).toEqual([22]);
  });

  it('★ 路径穿越实锤：目录外的哨兵文件读不到，也删不掉', async () => {
    const sentinelPath = nodePath.join(tmpRoot, 'secret.txt');
    writeFileSync(sentinelPath, 'TOP-SECRET');

    const probes = [
      '../secret.txt',
      '../../secret.txt',
      nodePath.join(tmpRoot, 'secret.txt'),
      '6f1d3f10-2222-4222-8222-222222222222/../../secret.txt',
      '..%2Fsecret.txt',
      '/etc/passwd',
      './secret.txt',
    ];
    for (const id of probes) {
      expect(await store.get(id)).toBeNull();
    }
    expect(readFileSync(sentinelPath, 'utf8')).toBe('TOP-SECRET');
  });

  it('★ sweep 不误删外来文件（脏/非 UUID 留在目录里也不动）', async () => {
    const dir = nodePath.join(tmpRoot, 'mixedSweep');
    let clock = 7_000_000;
    const mixed = createFileAssetStore(dir, { ttlMs: 1000, now: () => clock });
    mkdirSync(dir, { recursive: true }); // 落盘目录是 lazy 建的，放哨兵前先建出来

    writeFileSync(nodePath.join(dir, 'not-a-uuid.json'), '{"assetId":"x","expiresAt":1}');
    writeFileSync(nodePath.join(dir, 'broken.json'), '{ not json ');
    writeFileSync(nodePath.join(dir, 'orphan.bin'), 'zzz');

    expect(await mixed.sweepExpired()).toBe(0);
    expect(existsSync(nodePath.join(dir, 'not-a-uuid.json'))).toBe(true);
    expect(existsSync(nodePath.join(dir, 'broken.json'))).toBe(true);
    expect(existsSync(nodePath.join(dir, 'orphan.bin'))).toBe(true);

    // 对照组：同一目录里合法的过期条目仍然要被清掉 —— 上一条的"不删"不是因为 sweep 坏了。
    const live = await mixed.put({ bytes: new Uint8Array([1]), name: 'real.png', mime: 'image/png' });
    clock += 1001;
    expect(await mixed.sweepExpired()).toBe(1);
    expect(await mixed.get(live.assetId)).toBeNull();
  });

  it('描述符来自磁盘 → 字段缺失也能读，但 expiresAt 不是数字就判无效', async () => {
    const dir = nodePath.join(tmpRoot, 'hostile');
    const target = createFileAssetStore(dir, { ttlMs: 1000, now: () => 1_000_000 });
    const record = await target.put({ bytes: new Uint8Array([5]), name: 'a.png', mime: 'image/png' });

    // 手工改坏磁盘上的描述符：expiresAt 被换成字符串。
    writeFileSync(
      nodePath.join(dir, `${record.assetId}.json`),
      JSON.stringify({ ...record, expiresAt: 'not-a-number' }),
      'utf8',
    );
    expect(await target.get(record.assetId)).toBeNull();
  });
});

/* ================================================================== *
 * ⑥ makeFormKey / parseFormKey：换一批取值
 * ================================================================== */

describe('formKey 的新边界', () => {
  /**
   * 取值表刻意包含 `=` `@` 分隔符类符号、空白、换行、超长串与中文。
   * ★ 不含以单个 `:` 结尾的取值 —— 那种会真的解析不出来，另开一条用例摊开来写。
   */
  const VALUES = [
    'plain',
    'a=b',
    'user@example.com',
    '含空格 与制表\t',
    '换行\n也来',
    '中文、`~!@#$%^&*()_+',
    'x'.repeat(500),
    'days',
  ];

  it('★ 往返：分隔符友好的取值必须原样回来（等值，不是近似）', () => {
    for (const questionId of VALUES) {
      for (const fieldId of VALUES) {
        const key = makeFormKey(questionId, fieldId);
        expect(parseFormKey(key)).toEqual({ questionId, fieldId });
      }
    }
  });

  it('★ 冒号贴着 `::` 时，parseFormKey 会给出**错而不空**的答案', () => {
    // 根因：`lastIndexOf('::')` 在 ".q:::a." 上有两个候选位置，选中的偏右那一个。
    // 于是 userId/fieldId 里**贴着分隔符的冒号**会被含混地算到另一边去。
    expect(parseFormKey(makeFormKey('q', ':'))).toBeNull(); // 极端情形直接判空（把答案丢了）
    expect(parseFormKey(makeFormKey('q', ':a'))).toEqual({ questionId: 'q:', fieldId: 'a' }); // ★ 错而不空
    expect(parseFormKey(makeFormKey('q:', 'a'))).toEqual({ questionId: 'q:', fieldId: 'a' }); // 与上一行同键

    // 对照组：冒号不贴着分隔符时完全正常 —— 说明不是"解析器整体坏了"。
    expect(parseFormKey(makeFormKey('q', 'a:b'))).toEqual({ questionId: 'q', fieldId: 'a:b' });
    expect(parseFormKey(makeFormKey('a:b', 'c'))).toEqual({ questionId: 'a:b', fieldId: 'c' });
  });

  it('★ 键碰撞（已知缺陷）：questionId 尾冒号 与 fieldId 首冒号 撞成同一个键', () => {
    expect(makeFormKey('a:', 'b')).toBe(makeFormKey('a', ':b'));

    // 后果描出来：两个不同字段写进 answers 时后写的覆盖先写的。
    const answers: Record<string, string> = {};
    answers[makeFormKey('a:', 'b')] = '第一份';
    answers[makeFormKey('a', ':b')] = '第二份';
    expect(Object.keys(answers)).toHaveLength(1);
    expect(answers['a:::b']).toBe('第二份'); // 第一份被静默覆盖
  });

  it('同一题多字段：各自的键独立往返（顺序无关）', () => {
    const questionId = 'clarify:tool:s-1';
    const fieldIds = ['days', 'budget', 'style', 'note'];
    const keys = fieldIds.map((fieldId) => makeFormKey(questionId, fieldId));

    expect(new Set(keys).size).toBe(fieldIds.length); // ★ 对照组：没有互相覆盖
    keys.forEach((key, index) => {
      expect(parseFormKey(key)).toEqual({ questionId, fieldId: fieldIds[index] });
    });
  });

  it('questionId 里多个单冒号也回得来（之所以选 `::` 作分隔符就是这个）', () => {
    const key = makeFormKey('a:b:c:d', 'e:f');
    expect(parseFormKey(key)).toEqual({ questionId: 'a:b:c:d', fieldId: 'e:f' });
  });
});

/* ================================================================== *
 * ⑦ 回灌死循环：内核自身产出的澄清必须能收束
 * ================================================================== */

describe('回灌能不能收束（K7 与它的陷阱）', () => {
  const missingCases = ['goal.detail', 'constraint.generic', 'constraint.budget', 'constraint.deadline', '不存在的字段'];

  it('★ K7：内核自身产出的澄清问题，永远走**选项**模式（fields 恒空）', () => {
    for (const field of missingCases) {
      const goal = { ...parseGoal({ runId: 'r', raw: '一句话目标，但用于构造缺失字段' }).goal, missingFields: [field] };
      const questions = buildClarifyQuestions(goal);
      expect(questions.length).toBeGreaterThan(0); // ★ 对照组：这个分支真产出了东西

      for (const question of questions) {
        expect(question.fields).toEqual([]);
        expect(question.options.length).toBeGreaterThan(0);
      }
    }
  });

  it('走 UI 的选项回灌（select_option 的键约定）后必须收束', () => {
    for (const field of missingCases) {
      const base = parseGoal({ runId: 'r', raw: '一句话目标，但用于构造缺失字段' }).goal;
      const goal = { ...base, missingFields: [field] };
      const question = buildClarifyQuestions(goal)[0];
      expect(question).toBeDefined();

      // page.tsx:117 —— select_option 的回灌形状
      const answers: Record<string, string> = { [question!.id]: question!.options[0]!.id };
      const after = applyAnswers(goal, answers);
      expect(needsClarification(after)).toBe(false); // ★ 收束：不再追问
    }
  });

  it('★ 陷阱守卫：一旦内核也开始产 fields，表单回灌就会**永不收束**', () => {
    const base = parseGoal({ runId: 'r', raw: '一句话目标，但用于构造缺失字段' }).goal;
    const goal = { ...base, missingFields: ['constraint.generic'] };

    // 假设某天内核模板也带上了表单字段（K7 被违反）
    const hypothetical = zClarifyQuestion.parse({
      id: 'clarify:constraint.generic',
      prompt: '要表单吗？',
      options: [],
      fields: [{ id: 'budget', kind: 'number', label: '预算', required: true }],
      multi: false,
    });

    // page.tsx:104-105 —— submit_form 的回灌形状
    const answers: Record<string, string> = {
      [makeFormKey(hypothetical.id, 'budget')]: '500',
    };
    const after = applyAnswers(goal, answers);

    // ★ 当下这不是"预期的正确行为"，而是**把陷阱钉死在红灯上**：
    // applyAnswers 只认 `clarify:<field>`，认不出 `qid::fid`，所以 missingFields 原样保留
    // → needsClarification 恒 true → 同一个表单无限重问。
    // 谁去给 buildClarifyQuestions 加 fields，这条立刻变红，也就是 K7 的自动告警器。
    expect(needsClarification(after)).toBe(true);
    expect(after.missingFields).toEqual(goal.missingFields);
  });
});

/* ================================================================== *
 * ⑧ 工具澄清回灌：一条 NOTE 里最贵的那件事 —— 填完到底动不动
 * ================================================================== */

describe('工具澄清（表单真正被用到的路径）回灌后必须真的重跑', () => {
  const [BASE_DOMAIN_ID] = registerAllDomains();
  const PROBE_DOMAIN_ID = 'probe-tool-clarify';

  function registerProbe(): void {
    const base = getDomainPack(BASE_DOMAIN_ID);
    if (!base) throw new Error('基线领域包未注册：无法构造探针');
    const result = registerDomainPack({ ...base, meta: { ...base.meta, id: PROBE_DOMAIN_ID } });
    if (!result.ok) throw new Error(`探针领域包注册失败：${result.issues.join('; ')}`);
  }

  function depsOf(events: StreamEvent[]): EngineDeps {
    return {
      runtime: createMockRuntime({ latencyMs: 0 }),
      emit: (event) => events.push(event),
      sleep: async () => undefined,
      streamDelayMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    };
  }

  async function resume(extra: {
    resumePlan: Plan | null;
    answers: Record<string, string>;
    /** page.tsx:112 的取值：`stepId ? retryStep : null`。 */
    edit: { kind: 'retryStep'; stepId: string } | null;
  }): Promise<{ result: EngineResult; events: StreamEvent[] }> {
    registerProbe();
    const events: StreamEvent[] = [];
    const result = await runGoal(
      {
        goal: GOAL,
        domainId: PROBE_DOMAIN_ID,
        simulate: 'none', // page.tsx:109 在回灌时强制 none
        answers: extra.answers,
        resumePlan: extra.resumePlan,
        edit: extra.edit,
      },
      depsOf(events),
    );
    return { result, events };
  }

  it('★ 第一轮：确实进入 awaiting_user，并下发了 ClarifyOptions', async () => {
    registerProbe();
    const events: StreamEvent[] = [];
    const result = await runGoal(
      { goal: GOAL, domainId: PROBE_DOMAIN_ID, simulate: 'clarify' },
      depsOf(events),
    );

    expect(result.status).toBe('awaiting_user');
    const node = reduceNodes(events).find((item) => item.component === 'ClarifyOptions');
    expect(node).toBeDefined();
    expect(node!.props['prompt']).toBeDefined();
  });

  it('★ 澄清节点**不带 stepId** —— 这决定了前端能不能拼出 retryStep', async () => {
    registerProbe();
    const events: StreamEvent[] = [];
    await runGoal({ goal: GOAL, domainId: PROBE_DOMAIN_ID, simulate: 'clarify' }, depsOf(events));

    const node = reduceNodes(events).find((item) => item.component === 'ClarifyOptions');
    expect(node).toBeDefined();
    // page.tsx:262 → onAction(action, node.stepId)；stepId 缺席 ⇒ edit 恒为 null
    expect(node!.stepId).toBeUndefined();
  });

  it('★ 第二轮：按 page.tsx 的形状回灌（stepId 缺席 ⇒ edit:null），步骤必须动起来', async () => {
    registerProbe();

    const firstEvents: StreamEvent[] = [];
    const first = await runGoal(
      { goal: GOAL, domainId: PROBE_DOMAIN_ID, simulate: 'clarify' },
      depsOf(firstEvents),
    );
    const awaitingStep = first.plan?.steps.find((step) => step.status === 'awaiting_user');
    expect(awaitingStep).toBeDefined(); // ★ 对照组：第一轮真的冻结了一个步骤

    // MockRuntime 认的答案键（script.ts:83）
    const answers = { [`clarify:tool:${awaitingStep!.id}`]: 'opt-a' };

    const second = await resume({ resumePlan: first.plan, answers, edit: null });

    // 语义：用户已经回答了，那个步骤不该再停在原地要同一样东西 —— "填完了没反应"是硬伤。
    const stillStuck = second.result.plan?.steps.find((step) => step.id === awaitingStep!.id);
    const doneAgain = second.events.some(
      (event) => event.type === 'step_status' && event.stepId === awaitingStep!.id && event.status === 'done',
    );

    expect({ stuckAt: stillStuck?.status ?? 'gone', rerunToDone: doneAgain }).toEqual({
      stuckAt: 'done',
      rerunToDone: true,
    });
  });

  it('★ 对照组：显式带 retryStep 时也必须同样收束（两条路都得通）', async () => {
    registerProbe();
    const firstEvents: StreamEvent[] = [];
    const first = await runGoal(
      { goal: GOAL, domainId: PROBE_DOMAIN_ID, simulate: 'clarify' },
      depsOf(firstEvents),
    );
    const awaitingStep = first.plan?.steps.find((step) => step.status === 'awaiting_user');
    expect(awaitingStep).toBeDefined();

    const second = await resume({
      resumePlan: first.plan,
      answers: { [`clarify:tool:${awaitingStep!.id}`]: 'opt-a' },
      edit: { kind: 'retryStep', stepId: awaitingStep!.id },
    });

    expect(second.result.plan?.steps.find((step) => step.id === awaitingStep!.id)?.status).toBe('done');
  });
});

/* ================================================================== *
 * ⑨ signals 派生：换一批 kind 组合（attachChannel.test.ts 只测过全 image）
 * ================================================================== */

describe('signals 派生的新边界', () => {
  const [BASE_DOMAIN_ID] = registerAllDomains();
  const PROBE_DOMAIN_ID = 'probe-signals';
  let captured: RunContext | null = null;

  function registerProbe(): void {
    const base = getDomainPack(BASE_DOMAIN_ID);
    if (!base) throw new Error('基线领域包未注册：无法构造探针');
    const result = registerDomainPack({
      ...base,
      meta: { ...base.meta, id: PROBE_DOMAIN_ID },
      planning: {
        ...base.planning,
        validateStep: (step: Step, ctx: RunContext) => {
          captured = ctx;
          return base.planning.validateStep(step, ctx);
        },
      },
    });
    if (!result.ok) throw new Error(`探针领域包注册失败：${result.issues.join('; ')}`);
  }

  async function runWith(attachments: readonly Attachment[]): Promise<void> {
    captured = null;
    registerProbe();
    await runGoal(
      { goal: GOAL, domainId: PROBE_DOMAIN_ID, simulate: 'none', attachments: [...attachments] },
      {
        runtime: createMockRuntime({ latencyMs: 0 }),
        emit: () => undefined,
        sleep: async () => undefined,
        streamDelayMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      },
    );
  }

  it('多 kind 混合：每种信号各出现一次，text 打头', async () => {
    await runWith([
      { id: 'a1', kind: 'image', name: 'a.png' },
      { id: 'a2', kind: 'link', name: 'b.url' },
      { id: 'a3', kind: 'geo', name: 'c.geo' },
      { id: 'a4', kind: 'file', name: 'd.bin' },
      { id: 'a5', kind: 'image', name: 'e.png' },
    ]);
    expect(captured).not.toBeNull();
    expect(captured!.signals.filter((signal) => signal === 'image')).toHaveLength(1);
    expect(new Set(captured!.signals)).toEqual(new Set(['text', 'image', 'link', 'geo', 'file']));
    expect(captured!.signals[0]).toBe('text');
  });

  // ★ 防回流锁：这里曾是**红灯**（engine.ts 把字面量 'text' 放在 Set 外面，
  // 于是 kind='text' 的附件会产出 ['text','text']）。修法是把 'text' 一起塞进 Set。
  // 用例保留、不再标"已知缺陷" —— 它是这条 bug 的防回流锁。
  it('kind 为 text 的附件：signals 里不该出现两个 text', async () => {
    await runWith([{ id: 't1', kind: 'text', name: 'note.txt' }]);
    expect(captured).not.toBeNull();
    // 语义：signals 是**集合语义**（回答"这次输入有哪些种类"）。重复元素会让任何
    // 按元素计数 / 精确比对的消费方判错 —— 本仓库自己的用例就用 toEqual(['text']) 判等。
    expect(captured!.signals).toEqual(['text']);
  });
});

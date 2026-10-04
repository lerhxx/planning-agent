/**
 * 附件存储：`AssetStore` 接口 + 落盘实现（`FileAssetStore`）。
 *
 * ★ 刻意**不用进程内 `Map`**：`next dev` 的多 worker / 热重载会让 `Map` 不是同一份，
 * 上传与 run 可能落在两个进程（这不是"只有 serverless 才会错"的问题）。
 * 落盘 + 接口抽象的成本只有十几行，却把"将来换对象存储"从**改造**变成**换实现**。
 *
 * 清理用 **lazy sweep**（每次 `put`/`get` 顺带清），**不引入定时任务**。
 *
 * ★ 本文件的头号纪律：**"没有"和"坏了"必须走两条路**。
 * 历史上 `get` 用同一个 `null` 表示"不存在 / 已过期 / 描述符坏了 / 磁盘炸了"，
 * 而调用方（`route.ts`）把 `null` 一律翻译成 `410 ASSET_EXPIRED` ——
 * 于是磁盘故障会被当成"你的附件过期了"报给用户：**错误诊断，且用户无法据此自救**
 * （他会去重传一张图，而问题在存储）。所以读取路径返回**可判别的结果**，
 * 而不是一个把四种命运压扁的 `null`。
 *
 * 位于 `app/**`（L-B）：不得出现任何领域词。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** TTL：1 小时。过期后 `get` 返回 `{ ok:false, reason:'EXPIRED' }`（调用方转 `ASSET_EXPIRED`）。 */
export const ASSET_TTL_MS = 3_600_000;

/** 单张体积上限 8MB（工程判断，需真机校准）。超限 → 413 显式报错，不静默裁剪。 */
export const ASSET_MAX_BYTES = 8 * 1024 * 1024;

/** mime 白名单；名单外一律拒收（415）。 */
export const ASSET_MIME_ALLOWLIST: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export interface AssetRecord {
  assetId: string;
  name: string;
  mime: string;
  byteSize: number;
  expiresAt: number;
}

export interface PutAssetInput {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

export interface StoredAsset {
  record: AssetRecord;
  bytes: Uint8Array;
}

/**
 * 读不到附件时的**原因**。
 *
 * ★ 前三种是"用户的附件确实取不到"，调用方可以给 `410`；
 * 最后一种是"我们的存储坏了"，给 `410` 就是说谎，必须给 `5xx`。
 */
export type AssetMissReason =
  /** assetId 不是 UUID —— 形状守卫直接拒（★ 同时是路径穿越防护）。 */
  | 'MALFORMED_ID'
  /** 没有这个条目：文件不在，或描述符不可解析（旧版本写的 / 外来脏文件）。 */
  | 'NOT_FOUND'
  /** 有，但已过期（并已顺手删掉）。 */
  | 'EXPIRED'
  /** ★ 存储本身出故障：EIO / EACCES / EISDIR / ENOTDIR / EMFILE … */
  | 'IO_ERROR';

/**
 * `get` 的结果。**不用 `null` 同时表示"没有"和"坏了"**。
 */
export type AssetLookup =
  | { ok: true; value: StoredAsset }
  | { ok: false; reason: AssetMissReason };

/**
 * 存储 I/O 故障。
 *
 * 只用于"返回值没法表达失败"的操作（如 `sweepExpired` 返回条数）——
 * 返回 `0` 会冒充成"扫过了，很干净"，那是撒谎，所以抛。
 */
export class AssetStoreIoError extends Error {
  readonly code = 'ASSET_STORE_IO_ERROR';

  constructor(
    readonly op: string,
    options?: { cause?: unknown },
  ) {
    super(`附件存储 I/O 故障：${op} 失败`, options);
    this.name = 'AssetStoreIoError';
  }
}

export interface AssetStore {
  put(input: PutAssetInput): Promise<AssetRecord>;
  /** 读不到时返回**原因**，而不是一个压扁的 `null`。 */
  get(assetId: string): Promise<AssetLookup>;
  /**
   * 清掉已过期条目，返回清理条数。
   * ★ I/O 故障时**抛 `AssetStoreIoError`**，不返回 `0`（那等于告诉调用方"很干净"）。
   */
  sweepExpired(now?: number): Promise<number>;
}

/**
 * assetId 形状守卫（`crypto.randomUUID()`）。
 * ★ 同时是**路径穿越防护**：落盘路径由 `assetId` 拼出，非 UUID 一律拒。
 */
const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWellFormedAssetId(assetId: string): boolean {
  return ASSET_ID_PATTERN.test(assetId);
}

/** `asset://<assetId>` ↔ `assetId`。 */
export function makeAssetRef(assetId: string): string {
  return `asset://${assetId}`;
}

export function parseAssetRef(ref: string): string | null {
  if (!ref.startsWith('asset://')) return null;
  const assetId = ref.slice('asset://'.length);
  return isWellFormedAssetId(assetId) ? assetId : null;
}

/**
 * lazy sweep 的最小间隔。
 * ★ 不是定时任务（设计已定无定时器），只是"上次扫过不久就先不扫"。
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export interface FileAssetStoreOptions {
  /** 便于测试 TTL：默认 1h。 */
  ttlMs?: number;
  now?: () => number;
  /** lazy sweep 节流间隔；传 0 = 每次访问都扫（老行为，仅用于对照/测试）。 */
  sweepIntervalMs?: number;
}

/**
 * 只有 `ENOENT` 才配叫"本来就可以没有"。
 *
 * ★ 其余一切（EIO / EACCES / EISDIR / ENOTDIR / EMFILE …）都是**故障**，
 * 绝不能降级成"没有" —— 那是这次要根除的病。
 */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** 落盘实现：`<dir>/<assetId>.bin`（字节）+ `<dir>/<assetId>.json`（描述符）。 */
export function createFileAssetStore(
  dir = '.tmp/assets',
  options: FileAssetStoreOptions = {},
): AssetStore {
  const root = path.resolve(process.cwd(), dir);
  const ttlMs = options.ttlMs ?? ASSET_TTL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  /** 上次清扫的时刻。初始为 −∞，保证第一次访问一定会扫一次。 */
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  const metaPath = (assetId: string): string => path.join(root, `${assetId}.json`);
  const blobPath = (assetId: string): string => path.join(root, `${assetId}.bin`);

  const ensureDir = async (): Promise<void> => {
    await mkdir(root, { recursive: true });
  };

  const drop = async (assetId: string): Promise<void> => {
    await Promise.all([
      rm(metaPath(assetId), { force: true }),
      rm(blobPath(assetId), { force: true }),
    ]);
  };

  type ReadRecordResult =
    | { ok: true; record: AssetRecord }
    | { ok: false; reason: 'NOT_FOUND' }
    | { ok: false; reason: 'IO_ERROR'; cause: unknown };

  /** 描述符来自磁盘（可能是旧版本写的），因此逐字段校验后再用。 */
  const readRecord = async (assetId: string): Promise<ReadRecordResult> => {
    let raw: string;
    try {
      raw = await readFile(metaPath(assetId), 'utf8');
    } catch (error) {
      // ENOENT = 这个 assetId 本来就没有 → 合法答案 NOT_FOUND。
      // ★ 其余（EIO / EACCES / EISDIR / ENOTDIR / EMFILE …）是**磁盘故障**，
      //   必须原样往上走；降级成 NOT_FOUND 就会变成"用户被告知附件过期了"。
      return isMissing(error)
        ? { ok: false, reason: 'NOT_FOUND' }
        : { ok: false, reason: 'IO_ERROR', cause: error };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // ★ 允许吞：这是**内容层面**的读不出（描述符被旧版本/外来文件写坏），
      //   不是 I/O 故障 —— 判成"没有"，且不会掩盖真正的磁盘问题。
      //   sweep 扫目录时会遇到这种脏文件，不能因此让整个 sweep 崩掉。
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'NOT_FOUND' };
    const record = parsed as Partial<AssetRecord>;
    if (typeof record.assetId !== 'string' || typeof record.expiresAt !== 'number') {
      return { ok: false, reason: 'NOT_FOUND' };
    }
    return {
      ok: true,
      record: {
        assetId: record.assetId,
        name: typeof record.name === 'string' ? record.name : '',
        mime: typeof record.mime === 'string' ? record.mime : 'application/octet-stream',
        byteSize: typeof record.byteSize === 'number' ? record.byteSize : 0,
        expiresAt: record.expiresAt,
      },
    };
  };

  /**
   * 清掉过期条目，返回清理条数。
   *
   * ★ `force=false` 时**惰性节流**：距上次清扫不足 `sweepIntervalMs` 就跳过。
   * 原因：单次 sweep 是 O(目录条目数) 的全目录扫描，而一批 20 张上传会调 20 次 `put`
   * —— 不节流就是 20 次全目录扫描，实测目录 100+ 条目时这一批从 5s 涨到 60s+。
   * ★ 显式调用 `sweepExpired()` 恒为 `force=true`（用户要你扫，就不能因为节流而空转）。
   * TTL 语义不受影响：节流只推迟清理，不推迟过期判定（`get` 仍按 `expiresAt` 判）。
   */
  const sweep = async (at: number, force: boolean): Promise<number> => {
    if (!force && at - lastSweepAt < sweepIntervalMs) return 0;
    lastSweepAt = at;

    await ensureDir();
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      // ENOENT = 目录还没建出来 / 被并发删掉 → 等价于"没有条目"，合法。
      // ★ 其余是 I/O 故障：返回 0 会冒充成"扫过了、很干净"，所以抛。
      if (isMissing(error)) return 0;
      throw new AssetStoreIoError('readdir', { cause: error });
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const assetId = entry.slice(0, -'.json'.length);
      if (!isWellFormedAssetId(assetId)) continue;
      const found = await readRecord(assetId);
      if (!found.ok) {
        // NOT_FOUND：脏文件 / 坏描述符 → 跳过（sweep 不该因为外来文件崩掉）。
        // ★ IO_ERROR：不许跳过，否则报数会变成"0 条"，等于骗调用方目录很干净。
        if (found.reason === 'IO_ERROR') {
          throw new AssetStoreIoError('readRecord', { cause: found.cause });
        }
        continue;
      }
      if (found.record.expiresAt > at) continue;
      await drop(assetId);
      removed += 1;
    }
    return removed;
  };

  return {
    async put(input) {
      await ensureDir();
      try {
        await sweep(now(), false); // lazy sweep（节流）：写入时顺带清过期条目
      } catch (error) {
        if (!(error instanceof AssetStoreIoError)) throw error;
        // ★ 这个 catch 是**故意**的，理由写清楚：
        // 惰性清扫只是"顺手做的最佳努力"，它的成败与这一次上传的成败无关 ——
        // 不能让清扫的磁盘故障连坐掉用户的上传（TTL 判定不依赖它，`get` 仍按 expiresAt 判）。
        // 但也不许把失败伪装成"扫过且 0 条"：复位 lastSweepAt，下次访问立刻重试，
        // 而不是让节流窗口把它再压 60s。
        lastSweepAt = Number.NEGATIVE_INFINITY;
      }
      const assetId = randomUUID();
      const record: AssetRecord = {
        assetId,
        name: input.name,
        mime: input.mime,
        byteSize: input.bytes.byteLength,
        expiresAt: now() + ttlMs,
      };
      await writeFile(metaPath(assetId), JSON.stringify(record), 'utf8');
      await writeFile(blobPath(assetId), input.bytes);
      return record;
    },
    async get(assetId): Promise<AssetLookup> {
      if (!isWellFormedAssetId(assetId)) {
        return { ok: false, reason: 'MALFORMED_ID' }; // ★ 路径穿越防护
      }
      const found = await readRecord(assetId);
      if (!found.ok) {
        return found.reason === 'IO_ERROR'
          ? { ok: false, reason: 'IO_ERROR' }
          : { ok: false, reason: 'NOT_FOUND' };
      }
      if (found.record.expiresAt <= now()) {
        try {
          await drop(assetId);
        } catch {
          // ★ 故意吞，理由：删不掉**不改变判决**（它确实已过期），下一次 sweep 会再试。
          // 这里若往外抛，用户会收到 5xx，而真相是"已过期" —— 那才是错报。
        }
        return { ok: false, reason: 'EXPIRED' };
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(blobPath(assetId));
      } catch (error) {
        // ENOENT：描述符在、字节还没落完（`put` 是两步写）→ 判"没有"，不是故障。
        // ★ 其余是 I/O 故障，不能降级成 NOT_FOUND/EXPIRED。
        return isMissing(error)
          ? { ok: false, reason: 'NOT_FOUND' }
          : { ok: false, reason: 'IO_ERROR' };
      }
      return { ok: true, value: { record: found.record, bytes: new Uint8Array(buffer) } };
    },
    async sweepExpired(at) {
      return sweep(at ?? now(), true); // 显式调用：不受节流影响
    },
  };
}

/** 进程内共享的默认实例（上传接口与后续解引用都用它，落盘目录一致）。 */
export const defaultAssetStore: AssetStore = createFileAssetStore();

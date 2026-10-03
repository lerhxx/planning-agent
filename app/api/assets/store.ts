/**
 * 附件存储：`AssetStore` 接口 + 落盘实现（`FileAssetStore`）。
 *
 * ★ 刻意**不用进程内 `Map`**：`next dev` 的多 worker / 热重载会让 `Map` 不是同一份，
 * 上传与 run 可能落在两个进程（这不是"只有 serverless 才会错"的问题）。
 * 落盘 + 接口抽象的成本只有十几行，却把"将来换对象存储"从**改造**变成**换实现**。
 *
 * 清理用 **lazy sweep**（每次 `put`/`get` 顺带清），**不引入定时任务**。
 *
 * 位于 `app/**`（L-B）：不得出现任何领域词。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** TTL：1 小时。过期后 `get` 返回 `null`（由调用方转成 `ASSET_EXPIRED`）。 */
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

export interface AssetStore {
  put(input: PutAssetInput): Promise<AssetRecord>;
  /** 不存在或已过期 → `null`（由调用方转成 `ASSET_EXPIRED`）。 */
  get(assetId: string): Promise<StoredAsset | null>;
  /** 清掉已过期条目，返回清理条数。 */
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

export interface FileAssetStoreOptions {
  /** 便于测试 TTL：默认 1h。 */
  ttlMs?: number;
  now?: () => number;
}

/** 落盘实现：`<dir>/<assetId>.bin`（字节）+ `<dir>/<assetId>.json`（描述符）。 */
export function createFileAssetStore(
  dir = '.tmp/assets',
  options: FileAssetStoreOptions = {},
): AssetStore {
  const root = path.resolve(process.cwd(), dir);
  const ttlMs = options.ttlMs ?? ASSET_TTL_MS;
  const now = options.now ?? (() => Date.now());

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

  /** 描述符来自磁盘（可能是旧版本写的），因此逐字段校验后再用。 */
  const readRecord = async (assetId: string): Promise<AssetRecord | null> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(metaPath(assetId), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Partial<AssetRecord>;
      if (typeof record.assetId !== 'string' || typeof record.expiresAt !== 'number') return null;
      return {
        assetId: record.assetId,
        name: typeof record.name === 'string' ? record.name : '',
        mime: typeof record.mime === 'string' ? record.mime : 'application/octet-stream',
        byteSize: typeof record.byteSize === 'number' ? record.byteSize : 0,
        expiresAt: record.expiresAt,
      };
    } catch {
      return null;
    }
  };

  const sweep = async (at: number): Promise<number> => {
    await ensureDir();
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const assetId = entry.slice(0, -'.json'.length);
      if (!isWellFormedAssetId(assetId)) continue;
      const record = await readRecord(assetId);
      if (!record || record.expiresAt > at) continue;
      await drop(assetId);
      removed += 1;
    }
    return removed;
  };

  return {
    async put(input) {
      await ensureDir();
      await sweep(now()); // lazy sweep：写入时顺带清过期条目
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
    async get(assetId) {
      if (!isWellFormedAssetId(assetId)) return null; // ★ 路径穿越防护
      const record = await readRecord(assetId);
      if (!record) return null;
      if (record.expiresAt <= now()) {
        await drop(assetId);
        return null;
      }
      try {
        const buffer = await readFile(blobPath(assetId));
        return { record, bytes: new Uint8Array(buffer) };
      } catch {
        return null;
      }
    },
    async sweepExpired(at) {
      return sweep(at ?? now());
    },
  };
}

/** 进程内共享的默认实例（上传接口与后续解引用都用它，落盘目录一致）。 */
export const defaultAssetStore: AssetStore = createFileAssetStore();

/**
 * 附件上传封装（客户端）。
 *
 * 三件事：
 * 1. 本地临时 id（`local-...`）→ 上传成功后**替换**成服务端 assetId（K1）；
 * 2. 超限 / 格式 / 过期一律**显式文案**，绝不静默裁剪或静默丢弃；
 * 3. 只发引用描述符，字节走 `/api/assets`。
 *
 * 位于 `src/features/**`（L-B）：不得出现任何领域词。
 */
import { ATTACHMENT_MAX_COUNT, type Attachment } from '@/shared/plan/types';

/** 单张上限（与服务端 `ASSET_MAX_BYTES` 同口径；写在客户端是为了**提前**报错）。 */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const UPLOAD_MIME_ALLOWLIST: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** 本地临时 id：上传完成前用于 React key 与 `@` 提及联想。 */
export function makeTempAttachmentId(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `local-${random}`;
}

export interface UploadAssetsResult {
  assets: Attachment[];
  /** 人类可读的错误文案（前端原样展示）。空串 = 成功。 */
  error: string;
}

/**
 * 客户端**预检**：数量、体积、格式，命中即不发请求。
 *
 * ★ 口径与服务端 `POST /api/assets` **完全一致**：空 type 也按"不在白名单"处理。
 * 真实 multipart 会把空 type 补成 `application/octet-stream`，所以不存在"真的空"，
 * 也就不需要 `file.type.length > 0` 这个永不命中的分支（留着只会让两边口径分叉）。
 */
export function precheckFiles(files: readonly File[]): string {
  if (files.length > ATTACHMENT_MAX_COUNT) {
    return `一次最多上传 ${ATTACHMENT_MAX_COUNT} 个附件，这次有 ${files.length} 个，请先删掉一些再发。`;
  }
  for (const file of files) {
    if (file.size > UPLOAD_MAX_BYTES) {
      return `「${file.name}」超过单张 ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)}MB 上限，请压缩后再上传。`;
    }
    if (!UPLOAD_MIME_ALLOWLIST.includes(file.type)) {
      return `「${file.name}」的格式不支持，只接受 PNG / JPEG / WebP / GIF。`;
    }
  }
  return '';
}

export interface PartitionedFiles {
  /** 看起来是图片的，走上传。 */
  accepted: File[];
  /** 不是图片的，**不静默丢弃** —— 由调用方显式告知用户。 */
  ignored: File[];
}

/**
 * 把用户选中的文件分成「上传」与「忽略」两堆。
 *
 * ★ 这层过滤只是**提前告知**，不是替服务端做决定：
 * 服务端的 415 才是最终判决。忽略掉的那些必须被**说出来**，
 * 否则用户拖进来一个 pdf 而界面毫无变化 —— 那是静默丢失（本项目第六次撞到同一类病）。
 */
export function partitionFiles(files: readonly File[]): PartitionedFiles {
  const accepted: File[] = [];
  const ignored: File[] = [];
  for (const file of files) {
    if (file.type.startsWith('image/')) accepted.push(file);
    else ignored.push(file);
  }
  return { accepted, ignored };
}

/** 被忽略文件的显式文案。点名被丢掉的是什么、有多少个 —— 绝不只说"已忽略"。 */
export function describeIgnoredFiles(ignored: readonly File[]): string {
  if (ignored.length === 0) return '';
  const shown = ignored
    .slice(0, 3)
    .map((file) => file.name)
    .join('、');
  const tail = ignored.length > 3 ? ' …' : '';
  return `已忽略 ${ignored.length} 个非图片文件：${shown}${tail}。目前只支持图片（PNG / JPEG / WebP / GIF）。`;
}

/** HTTP 错误 → 显式文案。服务端带 `message` 时优先用它。 */
export function describeUploadError(status: number, payload: unknown): string {
  const message =
    typeof payload === 'object' && payload !== null && typeof (payload as { message?: unknown }).message === 'string'
      ? (payload as { message: string }).message
      : '';
  if (message.length > 0) return message;
  if (status === 413) return '附件体积超限，请压缩后再上传。';
  if (status === 415) return '附件格式不支持，只接受 PNG / JPEG / WebP / GIF。';
  if (status === 410) return '附件已过期（保存 1 小时），请重新上传。';
  return `上传失败：HTTP ${status}`;
}

/** 上传一批文件 → 描述符数组。失败返回空数组 + 文案（**不抛异常**）。 */
export async function uploadAssets(files: readonly File[]): Promise<UploadAssetsResult> {
  if (files.length === 0) return { assets: [], error: '' };

  const precheck = precheckFiles(files);
  if (precheck.length > 0) return { assets: [], error: precheck };

  const form = new FormData();
  for (const file of files) form.append('file', file);

  try {
    const response = await fetch('/api/assets', { method: 'POST', body: form });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      return { assets: [], error: describeUploadError(response.status, payload) };
    }
    const payload: unknown = await response.json().catch(() => null);
    const assets = Array.isArray((payload as { assets?: unknown } | null)?.assets)
      ? ((payload as { assets: unknown[] }).assets as Attachment[])
      : [];
    if (assets.length === 0) return { assets: [], error: '上传成功但没有返回附件描述符，请重试。' };
    return { assets, error: '' };
  } catch (error) {
    return { assets: [], error: `上传失败：${error instanceof Error ? error.message : '网络异常'}` };
  }
}

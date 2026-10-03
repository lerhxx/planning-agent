/**
 * `POST /api/assets` —— 附件上传落地点（字节唯一入口）。
 * `GET  /api/assets?id=<assetId>` —— 解引用；过期返回 410 `ASSET_EXPIRED`。
 *
 * ★ 引用优先：`/api/run` 的请求体只带描述符，字节走这里先落地。
 * 位于 `app/**`（L-B）：不得出现任何领域词。
 */
import { ATTACHMENT_MAX_COUNT, type Attachment } from '@/shared/plan/types';
import {
  ASSET_MAX_BYTES,
  ASSET_MIME_ALLOWLIST,
  defaultAssetStore,
  makeAssetRef,
} from './store';

export const dynamic = 'force-dynamic';

function json(payload: Record<string, unknown>, status: number): Response {
  return Response.json(payload, { status });
}

/** 只取 File 项（`formData` 里可能混有文本字段）。 */
function pickFiles(form: FormData): File[] {
  return form
    .getAll('file')
    .filter((item): item is File => typeof item === 'object' && item !== null && 'arrayBuffer' in item);
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return json({ error: 'BAD_REQUEST', message: '请求体必须是 multipart/form-data' }, 400);
  }

  const files = pickFiles(form);
  if (files.length === 0) {
    return json({ error: 'NO_FILE', message: '没有收到任何文件' }, 400);
  }
  if (files.length > ATTACHMENT_MAX_COUNT) {
    return json(
      {
        error: 'TOO_MANY',
        message: `一次最多上传 ${ATTACHMENT_MAX_COUNT} 个附件，本次收到 ${files.length} 个`,
      },
      413,
    );
  }

  for (const file of files) {
    if (file.size > ASSET_MAX_BYTES) {
      return json(
        {
          error: 'FILE_TOO_LARGE',
          name: file.name,
          message: `「${file.name}」超过单张 ${Math.floor(ASSET_MAX_BYTES / 1024 / 1024)}MB 上限，请压缩后再上传`,
        },
        413,
      );
    }
    // ★ 不再判 `file.type.length > 0`：真实 multipart 会把空 type 补成
    // `application/octet-stream`，那个分支**永不命中**（死分支），留着只会让
    // 客户端与服务端口径分叉。空 / 未知 / 名单外一律显式 415。
    if (!ASSET_MIME_ALLOWLIST.includes(file.type)) {
      return json(
        {
          error: 'MIME_REJECTED',
          name: file.name,
          message: `「${file.name}」的格式不支持，只接受 PNG / JPEG / WebP / GIF`,
        },
        415,
      );
    }
  }

  const assets: Attachment[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const record = await defaultAssetStore.put({
      bytes,
      name: file.name,
      mime: file.type, // 走到这里必在白名单内，不可能为空
    });
    assets.push({
      id: record.assetId,
      kind: 'image',
      name: record.name,
      mimeType: record.mime,
      byteSize: record.byteSize,
      ref: makeAssetRef(record.assetId),
    });
  }

  return json({ assets }, 200);
}

export async function GET(request: Request): Promise<Response> {
  const assetId = new URL(request.url).searchParams.get('id') ?? '';
  if (assetId.length === 0) {
    return json({ error: 'BAD_REQUEST', message: '缺少 id 参数' }, 400);
  }

  const stored = await defaultAssetStore.get(assetId);
  if (!stored) {
    return json({ error: 'ASSET_EXPIRED', assetId, message: '附件不存在或已过期（1 小时），请重新上传' }, 410);
  }

  // `Uint8Array<ArrayBufferLike>` 不满足 `BodyInit`，这里显式拷进一个 `ArrayBuffer`。
  const body = new ArrayBuffer(stored.bytes.byteLength);
  new Uint8Array(body).set(stored.bytes);

  return new Response(body, {
    headers: {
      'Content-Type': stored.record.mime,
      'Cache-Control': 'no-store',
    },
  });
}

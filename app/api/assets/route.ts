/**
 * `POST /api/assets` —— 附件上传落地点（字节唯一入口）。
 * `GET  /api/assets?id=<assetId>` —— 解引用；过期返回 410 `ASSET_EXPIRED`。
 *
 * ★ 引用优先：`/api/run` 的请求体只带描述符，字节走这里先落地。
 *
 * ★ 失败分类是这里的核心职责：**存储故障 ≠ 附件过期**。
 * 磁盘/权限类故障回 `5xx` 并带可诊断的 `reason`；
 * 只有"确实不存在 / 确实已过期"才回 `410` —— 否则用户会拿着"附件已过期"
 * 去重新上传一张图，而真正的问题在存储，他再传一百次也没用。
 *
 * 位于 `app/**`（L-B）：不得出现任何领域词。
 */
import { ATTACHMENT_MAX_COUNT, type Attachment } from '@/shared/plan/types';
import {
  ASSET_MAX_BYTES,
  ASSET_MIME_ALLOWLIST,
  AssetStoreIoError,
  defaultAssetStore,
  makeAssetRef,
  type AssetStore,
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

/**
 * 造一组 handler。
 *
 * ★ 之所以是工厂而不是直接写死 `defaultAssetStore`：
 * 「存储故障必须回 5xx 而不是 410」这条只能在**注入一个坏掉的 store** 时被测到，
 * 而 `defaultAssetStore` 是模块级单例，没法从测试里换掉。
 */
export function createAssetsHandlers(store: AssetStore): {
  POST: (request: Request) => Promise<Response>;
  GET: (request: Request) => Promise<Response>;
} {
  async function POST(request: Request): Promise<Response> {
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
      let record;
      try {
        record = await store.put({
          bytes,
          name: file.name,
          mime: file.type, // 走到这里必在白名单内，不可能为空
        });
      } catch (error) {
        // ★ 落盘失败同样是存储故障，不能掉进 Next 的默认 500 HTML 里
        // （前端拿不到 reason，用户也看不懂）。这里显式分类。
        if (error instanceof AssetStoreIoError) {
          return json(
            {
              error: 'ASSET_STORE_IO_ERROR',
              reason: 'IO_ERROR',
              name: file.name,
              message: `「${file.name}」落盘失败（存储故障），请稍后重试`,
            },
            503,
          );
        }
        return json(
          {
            error: 'ASSET_STORE_WRITE_FAILED',
            name: file.name,
            message: `「${file.name}」落盘失败，请稍后重试`,
          },
          500,
        );
      }
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

  async function GET(request: Request): Promise<Response> {
    const assetId = new URL(request.url).searchParams.get('id') ?? '';
    if (assetId.length === 0) {
      return json({ error: 'BAD_REQUEST', message: '缺少 id 参数' }, 400);
    }

    const found = await store.get(assetId);
    if (!found.ok) {
      // ★ 这条 `if` 是本文件的全部意义：存储故障不能说成"附件过期了"。
      // `reason` 只取自固定枚举，不含路径等内部信息。
      if (found.reason === 'IO_ERROR') {
        return json(
          {
            error: 'ASSET_STORE_IO_ERROR',
            reason: found.reason,
            assetId,
            message: '附件读取失败（存储故障），请稍后重试',
          },
          503,
        );
      }
      return json(
        {
          error: 'ASSET_EXPIRED',
          reason: found.reason,
          assetId,
          message: '附件不存在或已过期（1 小时），请重新上传',
        },
        410,
      );
    }

    // `Uint8Array<ArrayBufferLike>` 不满足 `BodyInit`，这里显式拷进一个 `ArrayBuffer`。
    const body = new ArrayBuffer(found.value.bytes.byteLength);
    new Uint8Array(body).set(found.value.bytes);

    return new Response(body, {
      headers: {
        'Content-Type': found.value.record.mime,
        'Cache-Control': 'no-store',
      },
    });
  }

  return { POST, GET };
}

const defaultHandlers = createAssetsHandlers(defaultAssetStore);

export const POST = defaultHandlers.POST;
export const GET = defaultHandlers.GET;

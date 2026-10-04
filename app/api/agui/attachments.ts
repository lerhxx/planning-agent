/**
 * `forwardedProps.attachments` → 内核 `EngineInput.attachments` 的过桥层。
 *
 * ★ 为什么要有这一层（而不是直接在 route 里取字段）：
 *   AG-UI 的 `forwardedProps` 在 `@ag-ui/core` 里就是 `z.ZodOptional<z.ZodAny>`
 *   （见 `node_modules/@ag-ui/core/dist/schemas.d.ts`），协议层既没有附件槽位
 *   也不做任何校验；内核只认 `Attachment[]`（`shared/plan/types.ts` 的 `zAttachment`）。
 *   这一层把不可信的网络 JSON 收敛成内核认的形状。
 *
 * ★ 红线：**校验失败一律 400，绝不退化成"当没传附件"继续跑**。
 *   附件传不上来而界面毫无反应，是本项目最贵的那类故障（用户以为传了，内核根本没收到）；
 *   宁可让请求显式失败，也不要静默丢。
 *
 * ★ 附件描述符**引用优先**：字节已由 `/api/assets` 先落地，请求体里只有
 *   `id / kind / name / mimeType / byteSize / ref` 这些描述符，不搬运二进制。
 *
 * ★ 唯一真源：`zAttachment` 与 `ATTACHMENT_MAX_COUNT` 都从 `shared/plan/types`
 *   import，本文件**不重新定义第二份**——否则上限与字段口径迟早分叉。
 */
// 只把 zod 当类型用（本文件不 new 任何 schema，schema 一律来自 shared/plan/types）。
import type { z } from 'zod';
import {
  ATTACHMENT_MAX_COUNT,
  zAttachment,
  type Attachment,
} from '@/shared/plan/types';

/** 附件数组的校验器：元素形状 + 20 个硬上限（上限值来自 shared/plan/types）。 */
export const zForwardedAttachments = zAttachment.array().max(ATTACHMENT_MAX_COUNT);

/** 400 的错误码，与 `BAD_RESUME` / `BAD_FORWARDED_PROPS` 同一族。 */
export const BAD_ATTACHMENTS = 'BAD_ATTACHMENTS';

export type ForwardedAttachmentsResult =
  /** `attachments` 未定义 → 没有附件（不传给引擎，保持"有才给"的风格）。 */
  | { ok: true; attachments: Attachment[] | undefined }
  /** 字段存在但不合法 → 调用方必须返回 400。 */
  | { ok: false; message: string; issues: string[] };

/**
 * 读取 `attachments` 槽位，并区分三种状态：
 *  - 容器不是对象 / 没有这个键 → 未传；
 *  - 键在但值是 `undefined`（JSON 序列化会丢键，理论上不会到这）→ 未传；
 *  - 其余一律参与校验（包括 `null`：显式传了却不是数组，属于"类型不对"）。
 *
 * @param source `RunAgentInput.forwardedProps`（不可信）
 * @returns `present` 表示槽位是否被显式使用，`value` 是原始值
 */
function readAttachmentsSlot(source: unknown): { present: boolean; value: unknown } {
  if (source === null || typeof source !== 'object') return { present: false, value: undefined };
  if (!('attachments' in source)) return { present: false, value: undefined };

  const value = (source as Record<string, unknown>).attachments;
  if (value === undefined) return { present: false, value: undefined };
  return { present: true, value };
}

/** 把 zod issue 压成一行可读文本（带路径，方便定位到第几个附件哪个字段）。 */
function formatIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/**
 * 解析 `forwardedProps.attachments`。
 *
 * @param forwardedProps `RunAgentInput.forwardedProps`（不可信；可以传 `undefined`）
 * @returns 成功时 `attachments` 为 `undefined`（未传）或合法数组；失败时带可读原因
 */
export function parseForwardedAttachments(forwardedProps: unknown): ForwardedAttachmentsResult {
  const slot = readAttachmentsSlot(forwardedProps);
  if (!slot.present) return { ok: true, attachments: undefined };

  const parsed = zForwardedAttachments.safeParse(slot.value);
  if (!parsed.success) {
    return {
      ok: false,
      message: `forwardedProps.attachments 未通过校验：必须是 ${ATTACHMENT_MAX_COUNT} 个以内的合法附件描述符（引用优先，不搬运字节）`,
      issues: formatIssues(parsed.error),
    };
  }

  return { ok: true, attachments: parsed.data };
}

/**
 * ★ K9 兜底：**有附件时强制关闭 `requireConstraints`**。
 *
 * 依据 commit `76b77d8`「有附件时强制关闭 requireConstraints（它与图片流程互斥）」。
 * 这条兜底原本只存在于客户端，换壳（`80eb839`）时丢了；服务端必须补上，
 * 否则「带图提问」会被"还缺少约束条件"的追问卡死在澄清态，图片根本进不了内核。
 *
 * 引擎不会自己做这件事（`src/core/run/engine.ts` 里 `requireConstraints` 是原样传给
 * `parseGoal` 的），所以只能在这一层收口。
 *
 * @param requested 客户端请求的 `requireConstraints`（已过 zod 默认值）
 * @param attachments 本轮附件（`undefined` = 客户端没传这个字段）
 * @returns 实际生效的 `requireConstraints`
 */
export function resolveRequireConstraints(
  requested: boolean,
  attachments: Attachment[] | undefined,
): boolean {
  const hasAttachments = attachments !== undefined && attachments.length > 0;
  return hasAttachments ? false : requested;
}

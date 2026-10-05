/**
 * 模型返回值 → 内核类型的校验与归一化（红线 2：来自模型的 JSON 不可信）。
 *
 * ★ 为什么 `structuredOutput` 之后还要再校验一次：
 *   `agent.generate(..., { structuredOutput: zPlanDraft })` 已经让 Mastra 按 schema
 *   约束过一次输出。但"上游已经校验过"不等于"可以信任"——
 *   一旦将来换成自建 provider、换了模型、或有人图省事去掉 structuredOutput，
 *   这里就是唯一拦住脏数据的地方。**双保险，且这一层不依赖任何外部假设。**
 *
 * ★ 错误码一律取自 `KERNEL_ERROR_CODES`（红线 10：只允许内核通用码）。
 *   这里刻意**没有**引入 `MODEL_INVALID_OUTPUT` / `MODEL_UNAVAILABLE` 这类新码 ——
 *   白名单之外的码会让下游按码分支的逻辑失去穷尽性。
 */
import { zPlanDraft } from '@/src/core/runtime/adapter';
import { zToolResultBase } from '@/shared/domain/types';
import { KERNEL_ERROR_CODES, type KernelErrorCode } from '@/shared/plan/types';
import type { PlanDraft, ToolOutcome } from '@/src/core/runtime/adapter';
import type { RunContext } from '@/shared/run/types';

/** 组装一个失败的 `ToolOutcome`。`code` 必须是内核白名单里的值。 */
export function toolFailure(
  code: KernelErrorCode,
  message: string,
  retryable: boolean,
  ctx: RunContext,
  durationMs = 0,
): ToolOutcome {
  return {
    ok: false,
    sourceRefs: [],
    isEstimate: false,
    durationMs,
    error: { code, message, retryable, traceId: ctx.traceId },
  };
}

export type ParsedPlan =
  | { ok: true; draft: PlanDraft }
  | { ok: false; outcome: ToolOutcome };

/**
 * 校验模型的规划产出。
 *
 * 失败时返回 `PROVIDER_VALIDATION_FAILED`（可重试：换一次采样往往就好了），
 * 交由上游 `observer` 的既有失败路径处理 —— 本文件**不**自己决定重试策略。
 */
export function parsePlanDraft(raw: unknown, ctx: RunContext, durationMs = 0): ParsedPlan {
  const parsed = zPlanDraft.safeParse(raw);
  if (parsed.success) {
    return { ok: true, draft: parsed.data };
  }
  return {
    ok: false,
    outcome: toolFailure(
      'PROVIDER_VALIDATION_FAILED',
      `模型返回的计划未通过 schema 校验：${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('；')}`,
      true,
      ctx,
      durationMs,
    ),
  };
}

/** 把领域工具的返回值再过一遍 `zToolResultBase`，把非法返回变成可见失败。 */
export function parseToolResult(raw: unknown, ctx: RunContext, durationMs = 0): ToolOutcome {
  const parsed = zToolResultBase.safeParse(raw);
  if (parsed.success) {
    return parsed.data as ToolOutcome;
  }
  return toolFailure(
    'PROVIDER_VALIDATION_FAILED',
    `工具返回值未通过 schema 校验：${parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('；')}`,
    false,
    ctx,
    durationMs,
  );
}

/** 供测试与调用方核对：白名单长度变化时提醒同步更新本文件的映射。 */
export const KERNEL_CODE_SET: ReadonlySet<string> = new Set(KERNEL_ERROR_CODES);

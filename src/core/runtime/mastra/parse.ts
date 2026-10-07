/**
 * 模型返回值 → 内核类型的校验与归一化（红线 2：来自模型的 JSON 不可信）。
 *
 * ★ 为什么仍然要在这一层（而非依赖模型侧约束）再校验一次：
 *   上游 `agent.ts` 现在**不再**使用 json_schema 结构化输出
 *   （DeepSeek 等 OpenAI 兼容端点不支持 `response_format: { type: "json_schema" }`，
 *   传了会直接 400），而是从模型文本里抠 JSON（`extractPlanJson`）。
 *   文本抠出来的东西天然不可信，且换 provider / 换模型后形态各异 ——
 *   **这一层是拦住脏数据的唯一强制点**。即便将来重新启用 structuredOutput，
 *   这里仍是兜底（红线 2）。**双保险，且这一层不依赖任何外部假设。**
 *
 * ★ 错误码一律取自 `KERNEL_ERROR_CODES`（红线 10：只允许内核通用码）。
 *   这里刻意**没有**引入 `MODEL_INVALID_OUTPUT` / `MODEL_UNAVAILABLE` 这类新码 ——
 *   白名单之外的码会让下游按码分支的逻辑失去穷尽性。
 *
 * ★ 本文件是"校验**与归一化**"，归一化不是副业，是职责本身。
 *   归一化的边界只有一条：**只在语义映射唯一的地方归一化，且必须出声**。
 *   语义有歧义的地方（例如 `true` 也可以读成字符串 `'true'`）一律交给 schema 报错 ——
 *   越猜越不可预测，而且猜错的那次不会有任何人知道。
 *
 * ★★ 为什么 `producesFacts` 的数组**不直接拒绝**（详见 `normalizeProducesFacts`）：
 *   拒绝看起来更"严格"，但代价是把一个**稳定复现**的理解偏差变成用户的每一次重试。
 *   模型对这个字段的理解偏差是系统性的、每次重试都一样的，
 *   不是随机采样噪声 —— 所以"重试一次也许就好了"在这里不成立，
 *   而数组 → 布尔的语义映射又是唯一的（非空 = 有产出要当事实，空 = 没有）。
 *   于是这里做**窄**归一化 + `console.warn` 出声告警，
 *   而不是把 schema 放宽成 `z.union([z.boolean(), z.array(...)])` ——
 *   **放宽 schema 会把这个偏差永久固化成"合法"，那就再也没人知道模型在说什么了**，
 *   真正的反幻觉闸门也会跟着失去依据。
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

/** 只认"是普通对象"，其余（数组 / null / 原始值）一律视为不可下钻。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把模型对 `steps[i].intent.producesFacts` 的**数组**写法归一化成布尔值。
 *
 * ★ 唯一被接受的映射：**非空数组 → `true`，空数组 → `false`**。
 *   这条映射唯一且自然（"这一步会产出这些" → 确实有产出要当事实 → true），
 *   所以值得在解析层接住，而不是把整轮计划判死。
 *
 * ★ 只处理数组，**其它类型一律原样放行**，让 `zStepIntent` 去报错。
 *   `'true'` / `1` 这类"也许是布尔"的猜测一律不做：放宽它们等于自造第二套语义，
 *   而且猜错的那次不会有人知道。这条窄边界是本函数的全部价值所在 ——
 *   一旦开始"顺手多兼容一点"，它就和直接放宽 schema 没区别了。
 *
 * ★ 每次归一化都 `console.warn` 出声（步骤下标 + 原值的**类型** + 归一化结果）。
 *   本仓的核心主张是"不可静默"：悄悄把非法值改成合法值就是静默，
 *   哪怕改得对。**不打印原值本身** —— 模型原文可能很长且含用户输入。
 *
 * @param raw 模型返回的原始对象。
 * @returns 归一化后的**新对象**；入参不会被原地修改（模型返回值可能还被别处持有）。
 */
export function normalizeProducesFacts(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.steps)) {
    return raw;
  }

  let changed = false;
  const steps = raw.steps.map((step, index) => {
    if (!isRecord(step) || !isRecord(step.intent)) {
      return step;
    }
    const rawFlag = step.intent.producesFacts;
    if (!Array.isArray(rawFlag)) {
      // 已经是布尔、undefined，或其它类型 —— 不碰，交给 schema 说话。
      return step;
    }
    const normalized = rawFlag.length > 0;
    console.warn(
      `[normalizeProducesFacts] steps[${index}].intent.producesFacts 收到数组（长度 ${rawFlag.length}），` +
        `已按语义归一化为 ${normalized}`,
    );
    changed = true;
    return { ...step, intent: { ...step.intent, producesFacts: normalized } };
  });

  // 没有改动就返回原引用：调用方可以靠 `===` 判断"这次有没有被归一化过"。
  return changed ? { ...raw, steps } : raw;
}

/**
 * 校验模型的规划产出。
 *
 * 失败时返回 `PROVIDER_VALIDATION_FAILED`（可重试：换一次采样往往就好了），
 * 交由上游 `observer` 的既有失败路径处理 —— 本文件**不**自己决定重试策略。
 */
export function parsePlanDraft(raw: unknown, ctx: RunContext, durationMs = 0): ParsedPlan {
  // 归一化在 schema 之前：只处理映射唯一的数组写法，其余非法值仍由 schema 报错。
  const parsed = zPlanDraft.safeParse(normalizeProducesFacts(raw));
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

/**
 * ★ RuntimeAdapter —— **内核唯一可见的执行接口**（红线 13：内核只依赖接口，不依赖实现）。
 *
 * 模型能力（规划 / 重规划）与工具执行都收在这里。M1 只有 `MockRuntime`（连模型也 mock，零网络）。
 * 将来的 `MastraRuntime` 必须实现同一个接口，内核一行不改。
 *
 * 本文件位于 `src/core/**`：禁止出现任何领域词。
 */
import { z } from 'zod';
import {
  zGoal,
  zStep,
  zStepDraft,
  type Goal,
  type Step,
  type StepDraft,
} from '@/shared/plan/types';
import {
  zPlanTemplate,
  zStepTypeDescriptor,
  type ToolResult,
} from '@/shared/domain/types';
import { zRunContext, type RunContext } from '@/shared/run/types';
import { zReplanTrigger } from '@/src/core/replan/policy';

/* ------------------------------------------------------------------ *
 * 工具清单（**给模型看的**，不是执行契约）
 * ------------------------------------------------------------------ */

/**
 * ★ 规划请求携带的"可用工具"清单条目 —— **这是给模型看的清单，不是执行契约**。
 *
 * ## 为什么不复用 `zToolSpecMeta`
 *
 * `zToolSpecMeta`（`shared/domain/types.ts`）是**执行期**契约：它带 `inputSchema`
 * 之外的 `idempotent` / `timeoutMs` / `retryable` 这些**内核与 runtime 之间**才需要的字段，
 * 而 `ToolSpec` 还要挂 `execute` 实现。这些对模型不仅无用，还会误导 ——
 * 模型会去猜 `timeoutMs` 能不能当"耗时"填进 `estimate.durationMs`。
 *
 * 而模型**真正需要**的三样是：注册名（必须逐字照抄）、用途说明、重试上限。
 * 缺的第三样（`label`）领域工具侧本来就没有 —— 它的等价物是 `stepType`，
 * 而 `stepType` 的 `maxAttempts` 已经挂在 `zStepTypeDescriptor` 上了。
 *
 * ## 边界
 *
 * - 本清单**只读**：模型看得见，但内核不拿它当授权依据（授权由
 *   `planner.ts` 的 `buildSteps` 拿 `intent.toolName` 去注册表核对）；
 * - 清单为**空**是合法状态（领域没注册任何工具），
 *   此时 prompt 必须明确要求模型把 `intent` 设成 `null`。
 */
export const zToolBrief = z.object({
  /** 领域注册表里的注册名。`intent.toolName` 必须与它**逐字**相等。 */
  name: z.string().min(1),
  /** 一句话用途（取自 `ToolSpec.description`，给模型读的）。 */
  description: z.string().default(''),
  /**
   * 失败时最多尝试几次。★ 工具自己**不**声明这个上限，它随 `step.type` 走
   * （与 `buildSteps` 的 `maxAttemptsFor` 同一来源），所以由内核在装配清单时填。
   */
  maxAttempts: z.number().int().positive().default(2),
});
export type ToolBrief = z.infer<typeof zToolBrief>;

/* ------------------------------------------------------------------ *
 * 规划请求 / 返回
 * ------------------------------------------------------------------ */

export const zPlanRequest = z.object({
  goal: zGoal,
  /** 领域声明的 step.type 白名单（内核透传，不解析其语义）。 */
  stepTypes: z.array(zStepTypeDescriptor).default([]),
  /**
   * ★ 领域注册过的全部工具（给模型看的清单）。
   * 曾长期**缺失**：prompt 的硬性约束写着"只能使用下方『可用工具』里列出的 toolName"，
   * 而请求里根本没有这个字段、prompt 里也没有这一节 —— 模型只能猜工具名，
   * 猜错就撞上 `工具未在当前领域注册`，步骤全失败后耗尽重排次数。
   *
   * ★ **optional 而不是必填**（重排请求一侧同理，见 `zReplanRequest.tools`）：
   * 权威来源是 `RunContext.domainId` 对应的注册表，`MastraRuntime` 会在调用模型前
   * 用 `getToolBriefs(ctx.domainId)` **覆盖**这个字段。让每个调用方都手填一份
   * 必然被覆盖的清单，只会让"该填什么"变成一件需要猜的事（填错即静默失效），
   * 也会逼着所有调用点（包括编排层）各自import 装配逻辑。
   * 真正的硬约束在**校验侧**：`planner.ts` 的 `buildSteps` 直接读注册表。
   */
  tools: z.array(zToolBrief).optional(),
  templates: z.array(zPlanTemplate).default([]),
  signals: z.array(z.string()).default([]),
  revision: z.number().int().nonnegative().default(1),
});
export type PlanRequest = z.infer<typeof zPlanRequest>;

export const zPlanDraft = z.object({
  summary: z.string().default(''),
  steps: z.array(zStepDraft).default([]),
});
export type PlanDraft = z.infer<typeof zPlanDraft>;

/* ------------------------------------------------------------------ *
 * 重规划请求
 * ------------------------------------------------------------------ */

export const zReplanRequest = z.object({
  goal: zGoal,
  revision: z.number().int().nonnegative(),
  trigger: zReplanTrigger,
  /** 失败的步骤 id（种子）。 */
  failedStepIds: z.array(z.string()).default([]),
  /** 反向收集到的受影响子树（已完成步骤已被剔除）。 */
  impactedStepIds: z.array(z.string()).default([]),
  /** 被保留的步骤快照（含已完成步骤），供 runtime 重写依赖。 */
  retainedSteps: z.array(zStep).default([]),
  /** 将被替换的步骤快照。 */
  impactedSteps: z.array(zStep).default([]),
  stepTypes: z.array(zStepTypeDescriptor).default([]),
  /**
   * ★ 与 `zPlanRequest.tools` 同一个字段、同一份清单、同样的 optional 理由。
   * 重排路径**同样**要校验新步骤的 `toolName`（`planner.ts` 的 `applyReplanDraft`），
   * 所以 prompt 也必须在这里拿到真实清单 —— 否则重排就是"凭空重发一个同样的错名字"。
   * 注意重排请求是由编排层 `src/core/run/engine.ts` 组装的，它拿得到 `domainId`，
   * 却不必（也不该）知道 prompt 需要什么素材。
   */
  tools: z.array(zToolBrief).optional(),
  templates: z.array(zPlanTemplate).default([]),
});
export type ReplanRequest = z.infer<typeof zReplanRequest>;

/* ------------------------------------------------------------------ *
 * 工具调用
 * ------------------------------------------------------------------ */

export const zToolCall = z.object({
  stepId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  /** `${runId}:${stepId}:${attempt}` */
  idempotencyKey: z.string().default(''),
  attempt: z.number().int().nonnegative().default(0),
  timeoutMs: z.number().int().positive().default(10_000),
  /** 来自 ToolSpec.producesFacts：为 true 时返回必须带 SourceRef。 */
  producesFacts: z.boolean().default(false),
});
export type ToolCall = z.infer<typeof zToolCall>;

export type ToolOutcome<T = unknown> = ToolResult<T>;

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

export interface RuntimeAdapter {
  /** 人类可读的实现标识（'mock' / 'mastra'）。 */
  readonly id: string;

  /** Goal → 计划草稿（模型调用，Mock 下为脚本化 fixture）。 */
  plan(request: PlanRequest, ctx: RunContext): Promise<PlanDraft>;

  /** 受影响子树 → 新草稿。**已完成 step 的 id 由内核保留，runtime 不得复用已完成 id。** */
  replan(request: ReplanRequest, ctx: RunContext): Promise<PlanDraft>;

  /** 执行单个工具调用。 */
  runTool(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
}

export type { RunContext, Goal, Step, StepDraft };
export { zRunContext };

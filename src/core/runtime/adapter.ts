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
 * 规划请求 / 返回
 * ------------------------------------------------------------------ */

export const zPlanRequest = z.object({
  goal: zGoal,
  /** 领域声明的 step.type 白名单（内核透传，不解析其语义）。 */
  stepTypes: z.array(zStepTypeDescriptor).default([]),
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

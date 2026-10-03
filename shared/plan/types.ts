/**
 * Plan / Step / Goal 的 **唯一真源**（zod 4）。
 *
 * 纪律：
 * - 所有类型一律 `z.infer` 推导，禁止在别处手写第二份同构类型。
 * - 本文件位于 `shared/**`，因此 **禁止出现任何领域词**（领域名 / 领域概念 / 领域字段名）。
 * - 模型与网络过来的 JSON 一律 `schema.safeParse` 后再消费。
 *
 * 字段口径见 `docs/PRD.md` §8。
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */

export const zStepStatus = z.enum([
  'pending',
  'ready',
  'running',
  'done',
  'failed',
  'skipped',
  'cancelled',
  'awaiting_user',
]);
export type StepStatus = z.infer<typeof zStepStatus>;

export const zPlanStatus = z.enum([
  'draft',
  'approved',
  'running',
  'paused',
  'replanning',
  'completed',
  'failed',
  'aborted',
]);
export type PlanStatus = z.infer<typeof zPlanStatus>;

/** 终态：进入后不再参与调度。 */
export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  'done',
  'skipped',
  'cancelled',
  'failed',
  'awaiting_user',
];

export function isTerminalStepStatus(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.includes(status);
}

/* ------------------------------------------------------------------ *
 * 溯源与错误
 * ------------------------------------------------------------------ */

/** 事实数据的来源引用。任何被当作"事实"呈现的数据都必须携带它。 */
export const zSourceRef = z.object({
  providerId: z.string().min(1),
  namespace: z.string().min(1),
  uri: z.string().optional(),
  label: z.string().min(1),
  retrievedAt: z.string(),
  isEstimate: z.boolean().default(false),
});
export type SourceRef = z.infer<typeof zSourceRef>;

/**
 * 内核通用错误。**触发码必须是内核通用码**（如 `PROVIDER_VALIDATION_FAILED`），
 * 禁止出现领域专有码。
 */
export const zAgentError = z.object({
  code: z.string().min(1),
  message: z.string().default(''),
  retryable: z.boolean().default(false),
  traceId: z.string().optional(),
  detail: z.unknown().optional(),
});
export type AgentError = z.infer<typeof zAgentError>;

/** 内核通用触发码白名单（唯一允许出现在 `AgentError.code` 里的值）。 */
export const KERNEL_ERROR_CODES = [
  'PROVIDER_VALIDATION_FAILED',
  'SOURCE_MISSING',
  'TOOL_FAILED',
  'TOOL_TIMEOUT',
  'PLAN_CYCLE_DETECTED',
  'PLAN_DEPENDENCY_MISSING',
  'PLAN_PARALLEL_GROUP_DEPENDENCY',
  'PLAN_GENERATION_FAILED',
  'DOMAIN_PACK_NOT_FOUND',
  'REPLAN_GATE_BLOCKED',
  'REPLAN_NO_CONVERGENCE',
  'USER_ABORTED',
  'INTERNAL_ERROR',
] as const;
export type KernelErrorCode = (typeof KERNEL_ERROR_CODES)[number];

/* ------------------------------------------------------------------ *
 * 成本与意图
 * ------------------------------------------------------------------ */

export const zStepCostEstimate = z.object({
  durationMs: z.number().nonnegative().default(0),
  costCNY: z.number().nonnegative().default(0),
  confidence: z.number().min(0).max(1).default(1),
});
export type StepCostEstimate = z.infer<typeof zStepCostEstimate>;

/** Step 的执行意图。`null` = 纯推理步骤（不调工具）。 */
export const zStepIntent = z.object({
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  producesFacts: z.boolean().default(false),
});
export type StepIntent = z.infer<typeof zStepIntent>;

export const zStepResult = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  sourceRefs: z.array(zSourceRef).default([]),
  isEstimate: z.boolean().default(false),
  durationMs: z.number().nonnegative().default(0),
});
export type StepResult = z.infer<typeof zStepResult>;

/* ------------------------------------------------------------------ *
 * 编辑溯源
 * ------------------------------------------------------------------ */

export const zStepOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('planner'), revision: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('replan'),
    revision: z.number().int().nonnegative(),
    parentStepId: z.string().optional(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('user'),
    revision: z.number().int().nonnegative(),
    editedFromStepId: z.string(),
    editedFields: z.array(z.string()).default([]),
    editedAt: z.string(),
  }),
]);
export type StepOrigin = z.infer<typeof zStepOrigin>;

/* ------------------------------------------------------------------ *
 * Step
 * ------------------------------------------------------------------ */

export const zStep = z.object({
  /** ★ 稳定 id：重规划后已完成 step 的 id 不得改变（天然幂等键）。 */
  id: z.string().min(1),
  domainId: z.string().min(1),
  /** 必须命中 DomainPack.planning.stepTypes 白名单。 */
  type: z.string().min(1),
  order: z.number().int().nonnegative(),

  title: z.string().min(1),
  description: z.string().optional(),
  estimate: zStepCostEstimate.optional(),

  dependsOn: z.array(z.string()).default([]),
  parallelGroup: z.string().optional(),

  status: zStepStatus.default('pending'),
  intent: zStepIntent.nullable().default(null),
  idempotencyKey: z.string().default(''),
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(2),

  origin: zStepOrigin,
  result: zStepResult.optional(),
  error: zAgentError.optional(),
  /** 产出到 UI 的组件节点 id；内核只持有 id，不解析其 props。 */
  emittedNodeIds: z.array(z.string()).default([]),
  renderAs: z.string().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Step = z.infer<typeof zStep>;

/** Planner/Runtime 产出的草稿：只描述"要做什么"，运行态字段由内核补齐。 */
export const zStepDraft = z.object({
  id: z.string().min(1).optional(),
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  parallelGroup: z.string().optional(),
  intent: zStepIntent.nullable().default(null),
  estimate: zStepCostEstimate.optional(),
  renderAs: z.string().optional(),
});
export type StepDraft = z.infer<typeof zStepDraft>;

/* ------------------------------------------------------------------ *
 * Goal
 * ------------------------------------------------------------------ */

/** 约束种类是内核通用的资源/期限口径，不含任何领域语义。 */
export const zGoalConstraintKind = z.enum(['budget', 'deadline', 'count', 'avoid', 'other']);

export const zGoalConstraint = z.object({
  kind: zGoalConstraintKind,
  value: z.string().default(''),
  raw: z.string().default(''),
});
export type GoalConstraint = z.infer<typeof zGoalConstraint>;

export const zGoalResources = z.object({
  budgetCNY: z.number().nonnegative().optional(),
  maxDurationMs: z.number().nonnegative().optional(),
  maxSteps: z.number().int().nonnegative().optional(),
});
export type GoalResources = z.infer<typeof zGoalResources>;

export const zGoal = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  raw: z.string().default(''),
  summary: z.string().default(''),
  constraints: z.array(zGoalConstraint).default([]),
  resources: zGoalResources.default({}),
  successCriteria: z.array(z.string()).default([]),
  /** 信息不足的字段；非空时先走澄清，不硬猜。 */
  missingFields: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Goal = z.infer<typeof zGoal>;

/* ------------------------------------------------------------------ *
 * 澄清（内核通用容器，问题文案由内核模板生成）
 * ------------------------------------------------------------------ */

export const zClarifyOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type ClarifyOption = z.infer<typeof zClarifyOption>;

export const zClarifyQuestion = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(zClarifyOption).default([]),
  multi: z.boolean().default(false),
});
export type ClarifyQuestion = z.infer<typeof zClarifyQuestion>;

/* ------------------------------------------------------------------ *
 * 用户编辑命令（C0-08 / C0-15）
 * ------------------------------------------------------------------ */

/**
 * 计划编辑命令。**放在 shared 是因为 `/api/run` 的请求体要带它**（前后端唯一真源）。
 * 语义见 `docs/PRD.md` §6.2 / §6.3。
 */
export const zEditCommand = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('editStep'),
    stepId: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal('removeStep'), stepId: z.string().min(1) }),
  z.object({
    kind: z.literal('addStep'),
    draft: zStepDraft,
    dependsOn: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal('reorder'),
    stepId: z.string().min(1),
    toOrder: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('editGoal'), constraints: z.array(zGoalConstraint).min(1) }),
  /** 显式解冻：把该步骤及其下游打回未完成，允许再次编辑/重跑。 */
  z.object({ kind: z.literal('rollback_to_step'), stepId: z.string().min(1) }),
  /** 重试单步：解冻并清零 attempt（等价于 rollback_to_step + 重置计数）。 */
  z.object({ kind: z.literal('retryStep'), stepId: z.string().min(1) }),
  /** 跳过单步：该步转 skipped，下游重新评估（仍受"已完成步骤冻结"约束）。 */
  z.object({ kind: z.literal('skipStep'), stepId: z.string().min(1) }),
]);
export type EditCommand = z.infer<typeof zEditCommand>;

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

export const zPlan = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  goalId: z.string().min(1),
  domainId: z.string().min(1),
  /** 每次重规划 +1。 */
  revision: z.number().int().nonnegative().default(1),
  status: zPlanStatus.default('draft'),
  summary: z.string().default(''),
  steps: z.array(zStep).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Plan = z.infer<typeof zPlan>;

/* ------------------------------------------------------------------ *
 * id 工具
 * ------------------------------------------------------------------ */

/** 首版计划的 step id。 */
export function makeStepId(index: number): string {
  return `s-${index + 1}`;
}

/** 重规划新生成 step 的 id：带 revision，天然与历史步骤区分。 */
export function makeReplanStepId(revision: number, index: number, suffix = ''): string {
  return `r${revision}-${index + 1}${suffix ? `-${suffix}` : ''}`;
}

/** `${runId}:${step.id}:${attempt}` —— 每个 step 可独立重试的幂等键。 */
export function makeIdempotencyKey(runId: string, stepId: string, attempt: number): string {
  return `${runId}:${stepId}:${attempt}`;
}

/**
 * 计划签名，用于重规划**收敛判定**（delta）。
 *
 * ★ **刻意不含 `id`**：重排必然生成新 id（否则无法与历史步骤区分），
 * 若把 id 计入签名，delta 恒等于 1，收敛判定永远不可能触发 —— 那是个数学上的死规则。
 * 只比"这一步**做什么**"（类型 + 归一化标题），不比"它是谁"。
 */
export function stepSignature(step: Pick<Step, 'type' | 'title'>): string {
  return `${step.type}|${normalizeTitle(step.title)}`;
}

/** 标题归一：去空白 + 转小写，避免大小写/空格差异被当成实质改动。 */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

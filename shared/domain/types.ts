/**
 * ★ Domain Pack 契约（zod 4 唯一真源）—— 见 `docs/PRD.md` §7。
 *
 * 设计约定：
 * - **数据段**（meta / ui 元数据 / prompts / planning 元数据 / evaluation 元数据）用 zod 定义，类型一律 `z.infer`。
 * - **可调用段**（工具执行、Provider 查询、stepRenderer 的 toProps、validator）本质上是函数，
 *   zod 无法表达其行为契约，因此采用「zod 管数据 + interface 组合可调用成员」的写法：
 *   `interface X extends z.infer<typeof zXMeta> { ...函数 }`。**同一份类型只有一处定义**，不存在手抄副本。
 * - 本文件位于 `shared/**`，禁止出现任何领域词（这里只能有"槽位"）。
 */
import type { ComponentType } from 'react';
import { z } from 'zod';
import {
  zAgentError,
  zClarifyQuestion,
  zSourceRef,
  zStep,
  zStepDraft,
  type AgentError,
  type ClarifyQuestion,
  type Plan,
  type SourceRef,
  type Step,
  type StepDraft,
} from '../plan/types';
import { zRunContext, type RunContext } from '../run/types';

/* ------------------------------------------------------------------ *
 * 通用形状
 * ------------------------------------------------------------------ */

export const zDomainId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, '领域 id 必须匹配 /^[a-z][a-z0-9-]{1,31}$/');

export const zSemver = z.string().regex(/^\d+\.\d+\.\d+$/, '必须是 x.y.z 形式的 semver');

export const zInputSignalKind = z.enum(['image', 'text', 'geo', 'link', 'file']);
export type InputSignalKind = z.infer<typeof zInputSignalKind>;

/* ------------------------------------------------------------------ *
 * ① meta
 * ------------------------------------------------------------------ */

export const zDomainMatcher = z.object({
  keywords: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
  negativeKeywords: z.array(z.string()).default([]),
  scoreBySignals: z.record(z.string(), z.number()).default({}),
});
export type DomainMatcher = z.infer<typeof zDomainMatcher>;

export const zDomainCapabilities = z.object({
  vision: z.boolean().default(false),
  geo: z.boolean().default(false),
  /** ★ false 时禁止模型产出事实，只能给观点。 */
  providers: z.boolean().default(false),
  timeSequence: z.boolean().default(false),
});
export type DomainCapabilities = z.infer<typeof zDomainCapabilities>;

export const zDomainMeta = z.object({
  id: zDomainId,
  displayName: z.string().min(1),
  version: zSemver,
  schemaVersion: z.literal(1),
  description: z.string().min(1),
  matcher: zDomainMatcher,
  requiredSignals: z.array(zInputSignalKind).default([]),
  capabilities: zDomainCapabilities,
});
export type DomainMeta = z.infer<typeof zDomainMeta>;

/* ------------------------------------------------------------------ *
 * ② tools
 * ------------------------------------------------------------------ */

export const zToolSpecMeta = z.object({
  name: z.string().min(1),
  /** ★ 给模型看的说明。 */
  description: z.string().min(1),
  /** ★ true = 产出被视为事实，模型不得编造，必须带 SourceRef。 */
  producesFacts: z.boolean().default(false),
  idempotent: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(10_000),
  retryable: z.boolean().default(true),
  /** 供 Planner 反推 step.type。 */
  stepType: z.string().optional(),
});
export type ToolSpecMeta = z.infer<typeof zToolSpecMeta>;

/** 工具统一返回体。`producesFacts=true` 的工具必须填 `sourceRefs`。 */
export const zToolResultBase = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  sourceRefs: z.array(zSourceRef).default([]),
  isEstimate: z.boolean().default(false),
  durationMs: z.number().nonnegative().default(0),
  error: zAgentError.optional(),
  /** 需要用户决策时置 true。缺省即 false，因此这里用 optional 而不是 default。 */
  needsClarification: z.boolean().optional(),
  question: zClarifyQuestion.optional(),
  disclaimer: z.string().optional(),
});
export type ToolResultBase = z.infer<typeof zToolResultBase>;
export type ToolResult<T = unknown> = ToolResultBase & { data?: T };

export interface ToolSpec<I = unknown, T = unknown> extends ToolSpecMeta {
  /** zod 4：同时产出 TS 类型与 JSON Schema。 */
  inputSchema: z.ZodType;
  execute(input: I, ctx: RunContext): Promise<ToolResult<T>> | ToolResult<T>;
}

export type ToolSet = Record<string, ToolSpec<never, unknown>>;

/* ------------------------------------------------------------------ *
 * ③ providers（反幻觉强制点）
 * ------------------------------------------------------------------ */

export const zProviderResultBase = z.object({
  ok: z.boolean(),
  source: zSourceRef,
  isEstimate: z.boolean().default(false),
  disclaimer: z.string().optional(),
  error: zAgentError.optional(),
  durationMs: z.number().nonnegative().default(0),
});
export type ProviderResultBase = z.infer<typeof zProviderResultBase>;
export type ProviderResult<T = unknown> = ProviderResultBase & { data?: T };

export interface ProviderAdapter<Q = Record<string, unknown>, R = unknown> {
  id: string;
  search(query: Q, ctx: RunContext): Promise<ProviderResult<R[]>>;
  detail?(id: string, ctx: RunContext): Promise<ProviderResult<R | null>>;
}

/**
 * ★ 校验型 Provider 的返回值。**内核只消费 `ok` 与 `violations[].severity`**，
 * `code / message / suggestion / evidence` 对内核不可读（类型上是 `unknown`，语义上禁止解析）。
 */
export const zViolation = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.unknown().optional(),
  message: z.unknown().optional(),
  suggestion: z.unknown().optional(),
  evidence: z.unknown().optional(),
});
export type Violation = z.infer<typeof zViolation>;

export const zValidationResult = z.object({
  ok: z.boolean(),
  violations: z.array(zViolation).default([]),
});
export type ValidationResult = z.infer<typeof zValidationResult>;

export interface ValidatingProvider {
  id: string;
  validate(plan: Plan, ctx: RunContext): Promise<ValidationResult> | ValidationResult;
}

export interface DomainProviders {
  /** 用于 SourceRef 溯源。 */
  namespace: string;
  create(ctx: RunContext): Record<string, ProviderAdapter>;
  createValidator?(ctx: RunContext): ValidatingProvider | undefined;
}

/* ------------------------------------------------------------------ *
 * ④ ui
 * ------------------------------------------------------------------ */

export const zComponentDefinitionMeta = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  modelCallable: z.boolean().default(false),
  lazy: z.boolean().default(true),
  /** props 未补齐这些键 → 渲染骨架，不报错。 */
  requiredProps: z.array(z.string()).default([]),
});
export type ComponentDefinitionMeta = z.infer<typeof zComponentDefinitionMeta>;

export interface ComponentDefinition extends ComponentDefinitionMeta {
  /** 组件 props 的 zod schema；`ComponentRenderer` 校验失败即降级。 */
  schema: z.ZodType;
  /**
   * React.lazy 懒加载入口。
   *
   * 领域包在 `ui` 段只声明元数据与 schema（服务端安全），`load` 由前端注册表补齐，
   * 因此这里是可选的。类型用 `any` 是因为注册表要在**未知 props 形状**下统一存放
   * 各领域的组件，具体校验交给各自的 `schema`（这里是唯一允许 `any` 的地方）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 组件 props 形状由各领域 schema 校验，注册表刻意不约束
  load?: () => Promise<{ default: ComponentType<any> }>;
}

export const zDegradeChain = z.object({
  /** schema 校验失败 → 展示原始载荷。 */
  rawPayload: z.string().min(1),
  /** 置信度不足 → 让用户点选。 */
  clarify: z.string().min(1),
  /** 彻底失败 → 错误态 + traceId。 */
  error: z.string().min(1),
  /** 等待首个组件 → 骨架。 */
  skeleton: z.string().min(1),
});
export type DegradeChain = z.infer<typeof zDegradeChain>;

export const zStepRendererMeta = z.object({ component: z.string().min(1) });

export const zUIContributionMeta = z.object({
  components: z.array(zComponentDefinitionMeta).default([]),
  degradeChain: zDegradeChain,
  stepRendererNames: z.record(z.string(), zStepRendererMeta).default({}),
});

/** `stepRenderers[type].toProps` 必须是纯函数。 */
export interface StepRenderer {
  component: string;
  toProps(result: unknown, step: Step, ctx: RunContext): Record<string, unknown>;
}

export interface DomainUIContribution {
  components: ComponentDefinition[];
  degradeChain: DegradeChain;
  stepRenderers: Record<string, StepRenderer>;
}

/* ------------------------------------------------------------------ *
 * ⑤ prompts
 * ------------------------------------------------------------------ */

export const zDomainPrompts = z.object({
  worldview: z.string().min(1),
  constraints: z.string().min(1),
  /** ★ 内核强制注入的反幻觉硬插槽。 */
  antiHallucination: z.string().min(1),
  planning: z.string().default(''),
});
export type DomainPrompts = z.infer<typeof zDomainPrompts>;

/* ------------------------------------------------------------------ *
 * ⑥ planning
 * ------------------------------------------------------------------ */

export const zStepTypeDescriptor = z.object({
  type: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(''),
  maxAttempts: z.number().int().positive().default(2),
});
export type StepTypeDescriptor = z.infer<typeof zStepTypeDescriptor>;

export const zPlanTemplate = z.object({
  id: z.string().min(1),
  description: z.string().default(''),
  steps: z.array(zStepDraft).min(1),
});
export type PlanTemplate = z.infer<typeof zPlanTemplate>;

export const zPlanningContributionMeta = z.object({
  stepTypes: z.array(zStepTypeDescriptor).min(1),
  templates: z.array(zPlanTemplate).default([]),
});

export interface DomainPlanningContribution {
  /** step.type 白名单。 */
  stepTypes: StepTypeDescriptor[];
  templates: PlanTemplate[];
  validateStep(step: Step, ctx: RunContext): Promise<ValidationResult> | ValidationResult;
}

/* ------------------------------------------------------------------ *
 * ⑦ evaluation
 * ------------------------------------------------------------------ */

export const zEvaluationCase = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  expect: z.array(z.string()).default([]),
});
export type EvaluationCase = z.infer<typeof zEvaluationCase>;

export const zEvaluationContributionMeta = z.object({
  cases: z.array(zEvaluationCase).default([]),
  metricIds: z.array(z.string()).default([]),
});

export interface DomainEvaluationContribution {
  cases: EvaluationCase[];
  metricIds: string[];
  score?(caseId: string, actual: unknown): number;
}

/* ------------------------------------------------------------------ *
 * ⑧ lifecycle（可选）
 * ------------------------------------------------------------------ */

export const zDomainLifecycleMeta = z.object({});

export interface DomainLifecycle {
  init?(ctx: RunContext): Promise<void> | void;
  dispose?(ctx: RunContext): Promise<void> | void;
}

/* ------------------------------------------------------------------ *
 * DomainPack 本体
 * ------------------------------------------------------------------ */

export interface DomainPack {
  meta: DomainMeta;
  tools: ToolSet;
  providers: DomainProviders;
  ui: DomainUIContribution;
  prompts: DomainPrompts;
  planning: DomainPlanningContribution;
  evaluation: DomainEvaluationContribution;
  lifecycle?: DomainLifecycle;
}

/** 必填段：缺一段则注册失败（PRD §7 / C0-11）。`lifecycle` 可选。 */
export const REQUIRED_DOMAIN_PACK_SEGMENTS = [
  'meta',
  'tools',
  'providers',
  'ui',
  'prompts',
  'planning',
  'evaluation',
] as const;
export type RequiredDomainPackSegment = (typeof REQUIRED_DOMAIN_PACK_SEGMENTS)[number];

/** 兜底降级链：领域未声明时使用内核通用组件。 */
export const CORE_DEGRADE_CHAIN: DegradeChain = {
  rawPayload: 'RawPayloadCard',
  clarify: 'ClarifyOptions',
  error: 'ErrorState',
  skeleton: 'SkeletonList',
};

export type { RunContext, Plan, Step, StepDraft, SourceRef, AgentError, ClarifyQuestion };
export { zRunContext, zStep, zStepDraft, zSourceRef, zAgentError, zClarifyQuestion };

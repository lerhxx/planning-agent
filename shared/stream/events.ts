/**
 * 流式事件契约（zod 4 唯一真源）—— AI SDK 自定义 data part 风格。
 *
 * 纪律：
 * - 新增事件必须同步改 4 处：本文件 / 服务端 `writer` / 前端 `nodeReducer` / 组件注册表。
 * - 列表追加用 JSON Patch `/items/-`，**禁止整包重发 props**。
 * - 前端收到任何事件都要 `zStreamEvent.safeParse`，失败即丢弃该事件（绝不白屏）。
 */
import { z } from 'zod';
import { zPlan, zPlanStatus, zStep, zStepStatus } from '../plan/types';
import { zRunTerminalStatus } from '../run/types';

/** RFC 6902 JSON Patch 的最小子集。`add /items/-` = 列表追加。 */
export const zJsonPatchOperation = z.object({
  op: z.enum(['add', 'replace', 'remove']),
  path: z.string().min(1),
  value: z.unknown().optional(),
});
export type JsonPatchOperation = z.infer<typeof zJsonPatchOperation>;

export const zPlanStartEvent = z.object({
  type: z.literal('plan_start'),
  planId: z.string().min(1),
  runId: z.string().min(1),
  goalId: z.string().min(1),
  domainId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  status: zPlanStatus,
  summary: z.string().default(''),
});

export const zPlanStatusEvent = z.object({
  type: z.literal('plan_status'),
  planId: z.string().min(1),
  status: zPlanStatus,
  revision: z.number().int().nonnegative(),
});

/** 逐条长出：前端收到后 append 到 step 列表。 */
export const zStepAddEvent = z.object({
  type: z.literal('step_add'),
  planId: z.string().min(1),
  step: zStep,
});

export const zStepStatusEvent = z.object({
  type: z.literal('step_status'),
  planId: z.string().min(1),
  stepId: z.string().min(1),
  status: zStepStatus,
  attempt: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

export const zComponentStartEvent = z.object({
  type: z.literal('component_start'),
  nodeId: z.string().min(1),
  component: z.string().min(1),
  stepId: z.string().optional(),
  traceId: z.string().optional(),
});

export const zComponentPropsDeltaEvent = z.object({
  type: z.literal('component_props_delta'),
  nodeId: z.string().min(1),
  patch: z.array(zJsonPatchOperation).min(1),
});

export const zComponentEndEvent = z.object({
  type: z.literal('component_end'),
  nodeId: z.string().min(1),
  status: z.enum(['ready', 'degraded', 'error']),
});

export const zErrorEvent = z.object({
  type: z.literal('error'),
  traceId: z.string().default(''),
  message: z.string().default(''),
  recoverable: z.boolean().default(true),
});

export const zDoneEvent = z.object({
  type: z.literal('done'),
  traceId: z.string().min(1),
  status: zRunTerminalStatus,
  planId: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

export const zStreamEvent = z.discriminatedUnion('type', [
  zPlanStartEvent,
  zPlanStatusEvent,
  zStepAddEvent,
  zStepStatusEvent,
  zComponentStartEvent,
  zComponentPropsDeltaEvent,
  zComponentEndEvent,
  zErrorEvent,
  zDoneEvent,
]);
export type StreamEvent = z.infer<typeof zStreamEvent>;
export type StreamEventType = StreamEvent['type'];

/** 一次 plan 的完整快照（供 UI 直接渲染，避免前端重建状态机）。 */
export const zPlanSnapshot = z.object({
  plan: zPlan.nullable(),
});
export type PlanSnapshot = z.infer<typeof zPlanSnapshot>;

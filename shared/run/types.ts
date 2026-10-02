/**
 * 一次 run 的上下文与请求体契约（zod 4 唯一真源）。
 *
 * 位于 `shared/**`：禁止出现任何领域词。
 * `RunContext` 刻意保持 **纯数据**（不含函数），这样它能被 zod 完整校验并安全跨端传输；
 * 时钟、随机数等副作用由调用方注入。
 */
import { z } from 'zod';
import { zEditCommand, zPlan } from '../plan/types';

export const zRunContext = z.object({
  runId: z.string().min(1),
  traceId: z.string().min(1),
  goalId: z.string().min(1),
  domainId: z.string().min(1),
  revision: z.number().int().nonnegative().default(1),
  startedAt: z.string(),
  /** 单轮硬约束（PRD §11：≤25s）。 */
  deadlineAt: z.string(),
  /** 单轮成本闸门余量（PRD §9.3：≤¥2）。 */
  budgetRemainingCNY: z.number().nonnegative().default(2),
  signals: z.array(z.string()).default([]),
  /** 领域无关的自由挂载点；内核不解析其内容（类似 domainExtras）。 */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type RunContext = z.infer<typeof zRunContext>;

/** 编排结束时的终态。 */
export const zRunTerminalStatus = z.enum([
  'completed',
  'failed',
  'aborted',
  'paused',
  'awaiting_user',
]);
export type RunTerminalStatus = z.infer<typeof zRunTerminalStatus>;

/** `POST /api/run` 的请求体。 */
export const zRunRequest = z.object({
  goal: z.string().min(1).max(2000),
  /** 省略则取注册表中的第一个领域包。 */
  domainId: z.string().optional(),
  /** 故障注入开关（MockRuntime 脚本用）：none | retryable | fatal | clarify。 */
  simulate: z.enum(['none', 'retryable', 'fatal', 'clarify']).default('none'),
  /**
   * 脚本化"模型"的重排行为（与 `simulate` 同属 MockRuntime 的调试旋钮）：
   * - `diverge`：重排时换方案（默认），闭环能继续跑完；
   * - `stagnant`：重排时原样重发，用来现场观察 `NO_CONVERGENCE` 闸门。
   */
  replanMode: z.enum(['diverge', 'stagnant']).default('diverge'),
  /** 强制走目标澄清（用于观察 C0-01 路径）。 */
  requireConstraints: z.boolean().default(false),
  /** 用户对澄清问题的回答：`questionId -> optionId`。 */
  answers: z.record(z.string(), z.string()).default({}),
  /**
   * 续跑：带上一次的 plan 快照（来自客户端，因此**不可信**，引擎会重新校验并归一状态）。
   * 不传 = 从目标重新规划一轮。
   */
  plan: zPlan.nullish(),
  /** 续跑前要应用的编辑命令（在 run 终态生效：paused / failed / awaiting_user）。 */
  edit: zEditCommand.nullish(),
});
export type RunRequest = z.infer<typeof zRunRequest>;

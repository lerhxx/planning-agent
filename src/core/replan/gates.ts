/**
 * 重规划三重闸门 + 收敛判定（PRD §9.3）—— 纯函数。
 *
 * | 闸门 | 上限 |
 * |------|------|
 * | 重规划次数 | ≤ 5 |
 * | 单轮成本   | ≤ ¥2 |
 * | 单轮时长   | ≤ 25s |
 *
 * **收敛判定**：新旧计划 delta < 0.15 → 判定为原地打转，**强制转人工**。
 */
import { z } from 'zod';
import { stepSignature, type Plan, type Step } from '@/shared/plan/types';

export const zGateConfig = z.object({
  maxReplans: z.number().int().positive().default(5),
  maxCostCNY: z.number().positive().default(2),
  maxDurationMs: z.number().positive().default(25_000),
  /** delta 低于该值 = 没实质变化 = 原地打转。 */
  minDelta: z.number().nonnegative().default(0.15),
});
export type GateConfig = z.infer<typeof zGateConfig>;

export const DEFAULT_GATE_CONFIG: GateConfig = zGateConfig.parse({});

export const zReplanBudget = z.object({
  replanCount: z.number().int().nonnegative().default(0),
  costCNY: z.number().nonnegative().default(0),
  startedAtMs: z.number().nonnegative().default(0),
});
export type ReplanBudget = z.infer<typeof zReplanBudget>;

export const zGateReason = z.enum([
  'MAX_REPLANS',
  'MAX_COST',
  'MAX_DURATION',
  'NO_CONVERGENCE',
]);
export type GateReason = z.infer<typeof zGateReason>;

export type GateOutcome = { allowed: true } | { allowed: false; reason: GateReason };

/**
 * 检查是否还允许再来一轮重规划。**每次重规划前必须调用**（红线 17）。
 */
export function checkGates(
  budget: ReplanBudget,
  nowMs: number,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): GateOutcome {
  if (budget.replanCount >= config.maxReplans) {
    return { allowed: false, reason: 'MAX_REPLANS' };
  }
  if (budget.costCNY > config.maxCostCNY) {
    return { allowed: false, reason: 'MAX_COST' };
  }
  if (nowMs - budget.startedAtMs > config.maxDurationMs) {
    return { allowed: false, reason: 'MAX_DURATION' };
  }
  return { allowed: true };
}

/**
 * 计划差异度：`1 - Jaccard(步骤签名集合)`。
 *
 * - 完全相同 → 0（判定为原地打转）
 * - 两边都为空 → 0
 * - 完全不同 → 1
 */
/**
 * 步骤集合的差异度（= 收敛判定的度量）。
 *
 * ★ 注意比较域：调用方应传**受影响子树**（被替换的步骤 vs 本次新生成的步骤），
 * 而不是整个计划 —— 否则"25 步计划只重排 1 步"会因 delta 过小被误判为原地打转。
 */
export function computePlanDelta(
  before: readonly Pick<Step, 'type' | 'title'>[],
  after: readonly Pick<Step, 'type' | 'title'>[],
): number {
  const a = new Set(before.map(stepSignature));
  const b = new Set(after.map(stepSignature));
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const sig of a) if (b.has(sig)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

/** 整个计划层面的 delta（供测试与诊断用；闭环里用的是子树 delta）。 */
export function planDelta(before: Pick<Plan, 'steps'>, after: Pick<Plan, 'steps'>): number {
  return computePlanDelta(before.steps, after.steps);
}

/**
 * ★ 子树 delta：只比"被替换掉的那几步"与"本次新生成的那几步"。
 * 这样"大计划只动一小撮"不会被误判为原地打转，而"重排结果和上次一模一样"会被判为不收敛。
 */
export function subtreeDelta(
  replaced: readonly Pick<Step, 'type' | 'title'>[],
  generated: readonly Pick<Step, 'type' | 'title'>[],
): number {
  return computePlanDelta(replaced, generated);
}

/** delta 是否低于阈值（= 未收敛 = 原地打转）。 */
export function isStagnant(delta: number, config: GateConfig = DEFAULT_GATE_CONFIG): boolean {
  return delta < config.minDelta;
}

/**
 * 收敛判定：把「闸门」与「delta」合起来判断这一轮能不能继续。
 * 顺序：先闸门（硬约束），再收敛（软约束）。
 */
export function evaluateReplan(input: {
  budget: ReplanBudget;
  nowMs: number;
  delta: number;
  config?: GateConfig;
}): GateOutcome {
  const config = input.config ?? DEFAULT_GATE_CONFIG;
  const gated = checkGates(input.budget, input.nowMs, config);
  if (!gated.allowed) return gated;
  if (isStagnant(input.delta, config)) {
    return { allowed: false, reason: 'NO_CONVERGENCE' };
  }
  return { allowed: true };
}

/** 闸门拒绝原因 → 人类可读说明（内核通用表述，不含领域语义）。 */
export function describeGateReason(reason: GateReason): string {
  switch (reason) {
    case 'MAX_REPLANS':
      return '重规划次数已达上限，停止自动修复';
    case 'MAX_COST':
      return '本轮成本已达上限，停止自动修复';
    case 'MAX_DURATION':
      return '本轮时长已达上限，停止自动修复';
    case 'NO_CONVERGENCE':
      return '重规划结果与原计划几乎一致，判定为原地打转';
    default:
      return '重规划被闸门拦截';
  }
}

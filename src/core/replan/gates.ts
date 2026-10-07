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
 *
 * ★ 两者语义不同，职责不同，见下面各自的不变式注释：
 *   - `checkGates` —— **事前**：现在还该不该开始新一轮重排（唯一职责）。
 *   - `judgeConvergence` —— **事后**：这一轮重排的结果有没有实质变化（唯一职责）。
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
 * ★ 事前闸门：检查是否**还允许开始新一轮**重规划。**每轮重排起飞前必须调用**（红线 17）。
 *
 * 三个上限约束的都是**未来的工作量**（还要再跑几轮、还要再花多少钱、还剩多少时间），
 * 所以它们只有在"还没开始"这个时点上问才有意义 —— 拦住的是"不要再开了"，
 * 而不是"把已经开完的那一轮扔掉"。
 *
 * ⚠️ 事后**不要**再复查本函数：那钱已经付了、时间已经花了，拦下来也退不回去，
 * 只会把正确的结果丢掉。事后唯一有意义的判断是收敛判定，见 `judgeConvergence`。
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
 * ★ 事后判定（收敛）：这一轮重排**算出来的计划有没有实质变化**。
 *
 * 回答的是"结果是不是等于没换"（`delta` 太小 = 原地打转 → 强制转人工），
 * **不**回答"现在还该不该重排"—— 后者是事前 `checkGates` 的职责，两者不得混用。
 *
 * ## 不变式：预算类闸门是**事前**判断，绝不放在这里复查
 *
 * 预算类闸门（`MAX_REPLANS` / `MAX_COST` / `MAX_DURATION`）约束的是**未来的工作量**，
 * 作用是拦住"不要再开始新一轮"；事后丢弃已完成的工作毫无意义 —— 钱已经付了、
 * 时间已经花了，拦下来也退不回去，候选计划却已经算好了。
 *
 * 事后唯一有意义的是收敛判定，因为 `delta` **只有事后才算得出来**（要比"被替换的
 * 那几步"与"本次新生成的那几步"，而它们都是这一轮的产物）。
 *
 * ★ 把 `MAX_DURATION` 放在事后，等于让"干活花了时间"本身成为丢弃正确结果的理由：
 *   调用点从起飞前走到这里只隔了一次模型调用（真模型 10–30s），而 `maxDurationMs`
 *   只有 25s —— 于是**每一次**耗时较长的重排都会在算完之后被自己耗时打死，
 *   自动修复事实上必然失效。真模型路径上观测到的正是这个故障。
 *
 * 因此本函数**不接收** `budget` / `nowMs`：它们在事后已无判据意义，不给参数
 * 就是最强的保证 —— 想要复查预算的人拿不到数据，只能回去改 `checkGates` 的调用时机。
 */
export function judgeConvergence(input: {
  /** 受影响子树的差异度，由 `subtreeDelta` 产出。 */
  delta: number;
  config?: GateConfig;
}): GateOutcome {
  const config = input.config ?? DEFAULT_GATE_CONFIG;
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

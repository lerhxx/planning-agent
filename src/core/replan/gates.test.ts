import { describe, expect, it } from 'vitest';
import {
  checkGates,
  computePlanDelta,
  DEFAULT_GATE_CONFIG,
  evaluateReplan,
  isStagnant,
  planDelta,
  subtreeDelta,
  type ReplanBudget,
} from './gates';
import { makePlan, makeStep } from '@/src/test/fixtures';

const budget = (overrides: Partial<ReplanBudget> = {}): ReplanBudget => ({
  replanCount: 0,
  costCNY: 0,
  startedAtMs: 0,
  ...overrides,
});

describe('checkGates（三重闸门）', () => {
  it('未触闸门 → 放行', () => {
    expect(checkGates(budget(), 1_000)).toEqual({ allowed: true });
  });

  it('次数闸门：已达 5 次 → MAX_REPLANS', () => {
    const outcome = checkGates(budget({ replanCount: 5 }), 1_000);
    expect(outcome).toEqual({ allowed: false, reason: 'MAX_REPLANS' });
  });

  it('成本闸门：超过 ¥2 → MAX_COST', () => {
    const outcome = checkGates(budget({ costCNY: 2.01 }), 1_000);
    expect(outcome).toEqual({ allowed: false, reason: 'MAX_COST' });
  });

  it('时长闸门：超过 25s → MAX_DURATION', () => {
    const outcome = checkGates(budget(), 25_001);
    expect(outcome).toEqual({ allowed: false, reason: 'MAX_DURATION' });
  });

  it('边界值：恰好等于上限仍放行（上限语义是"不超过"）', () => {
    expect(checkGates(budget({ replanCount: 4, costCNY: 2 }), 25_000)).toEqual({ allowed: true });
  });
});

describe('computePlanDelta（收敛判定）', () => {
  const a = makeStep({ id: 's-1', title: '第一步' });
  const b = makeStep({ id: 's-2', title: '第二步' });
  const c = makeStep({ id: 's-3', title: '第三步' });

  it('完全相同 → 0（判定为原地打转）', () => {
    expect(computePlanDelta([a, b], [a, b])).toBe(0);
  });

  it('两边都为空 → 0', () => {
    expect(computePlanDelta([], [])).toBe(0);
  });

  it('完全不同 → 1', () => {
    expect(computePlanDelta([a], [b])).toBe(1);
  });

  it('替换三分之一 → 0.5', () => {
    const before = [a, b, c];
    const after = [a, b, makeStep({ id: 's-9', title: '新步骤' })];
    expect(computePlanDelta(before, after)).toBeCloseTo(0.5, 5);
  });

  it('只改标题也算变化', () => {
    expect(computePlanDelta([a], [makeStep({ id: 's-1', title: '改过的第一步' })])).toBe(1);
  });

  it('planDelta 走 Plan 入参', () => {
    expect(planDelta(makePlan([a]), makePlan([a]))).toBe(0);
  });
});

describe('★ 收敛判定的比较域：受影响子树 vs 整个计划', () => {
  /** 25 步计划，标题各不相同。 */
  const big = Array.from({ length: 25 }, (_, index) =>
    makeStep({ id: `b-${index + 1}`, order: index, title: `步骤 ${index + 1}` }),
  );
  /** 只重排最后一步：新步骤换了标题。 */
  const replaced = [big[24]];
  const generated = [makeStep({ id: 'r2-0', title: '步骤 25 · 重排后的新写法' })];
  const whole = [...big.slice(0, 24), generated[0]];

  it('只改 id 不算变化：同 type + 同 title → delta 0（stepSignature 不含 id）', () => {
    const before = makeStep({ id: 's-1', title: '同一步' });
    const after = makeStep({ id: 'r2-0', title: '同一步' });
    expect(computePlanDelta([before], [after])).toBe(0);
    expect(subtreeDelta([before], [after])).toBe(0);
  });

  it('25 步计划只重排 1 步：子树 delta = 1 → 判定为已收敛', () => {
    const delta = subtreeDelta(replaced, generated);
    expect(delta).toBe(1);
    expect(isStagnant(delta)).toBe(false);
    expect(evaluateReplan({ budget: budget(), nowMs: 1_000, delta })).toEqual({ allowed: true });
  });

  it('★ 反例：若按整个计划比，delta < 0.15 会被误判成原地打转（旧 bug）', () => {
    const wholeDelta = planDelta({ steps: big }, { steps: whole });
    expect(wholeDelta).toBeCloseTo(1 - 24 / 26, 5);
    expect(wholeDelta).toBeLessThan(DEFAULT_GATE_CONFIG.minDelta);
    expect(isStagnant(wholeDelta)).toBe(true);
    // 因此闭环里必须用 subtreeDelta，而不是 planDelta。
    expect(computePlanDelta(big, whole)).toBeLessThan(DEFAULT_GATE_CONFIG.minDelta);
  });

  it('重排结果与原样一致 → 子树 delta = 0 → NO_CONVERGENCE', () => {
    const delta = subtreeDelta(replaced, [makeStep({ id: 'r2-0', title: '步骤 25' })]);
    expect(delta).toBe(0);
    expect(evaluateReplan({ budget: budget(), nowMs: 1_000, delta })).toEqual({
      allowed: false,
      reason: 'NO_CONVERGENCE',
    });
  });
});

describe('isStagnant / evaluateReplan', () => {
  it('delta < 0.15 → 未收敛', () => {
    expect(isStagnant(0.1)).toBe(true);
    expect(isStagnant(0.15)).toBe(false);
    expect(isStagnant(0.4)).toBe(false);
  });

  it('闸门通过且 delta 足够 → 放行', () => {
    expect(evaluateReplan({ budget: budget(), nowMs: 1_000, delta: 0.5 })).toEqual({ allowed: true });
  });

  it('delta 过小 → 强制转人工（NO_CONVERGENCE）', () => {
    const outcome = evaluateReplan({ budget: budget(), nowMs: 1_000, delta: 0.02 });
    expect(outcome).toEqual({ allowed: false, reason: 'NO_CONVERGENCE' });
  });

  it('闸门优先于收敛判定', () => {
    const outcome = evaluateReplan({ budget: budget({ replanCount: 5 }), nowMs: 1_000, delta: 1 });
    expect(outcome).toEqual({ allowed: false, reason: 'MAX_REPLANS' });
  });

  it('默认闸门配置与 PRD 一致', () => {
    expect(DEFAULT_GATE_CONFIG.maxReplans).toBe(5);
    expect(DEFAULT_GATE_CONFIG.maxCostCNY).toBe(2);
    expect(DEFAULT_GATE_CONFIG.maxDurationMs).toBe(25_000);
    expect(DEFAULT_GATE_CONFIG.minDelta).toBe(0.15);
  });
});

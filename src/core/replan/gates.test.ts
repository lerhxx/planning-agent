import { describe, expect, it } from 'vitest';
import {
  checkGates,
  computePlanDelta,
  DEFAULT_GATE_CONFIG,
  isStagnant,
  judgeConvergence,
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

  it('时长闸门：超过 90s → MAX_DURATION', () => {
    const outcome = checkGates(budget(), DEFAULT_GATE_CONFIG.maxDurationMs + 1);
    expect(outcome).toEqual({ allowed: false, reason: 'MAX_DURATION' });
  });

  it('边界值：恰好等于上限仍放行（上限语义是"不超过"）', () => {
    expect(checkGates(budget({ replanCount: 4, costCNY: 2 }), 90_000)).toEqual({
      allowed: true,
    });
  });

  /**
   * ★ 反向锁：闸门**没有被删掉**，只是搬回了它该在的位置（起飞前）。
   *
   * 与下面 `judgeConvergence` 那条"超长时长也放行"的回归锁配对：两条一起读才是
   * 完整语义 —— 事前仍然拦得住（拦的是"别再开了"），事后不再复查（否则会把已经
   * 算好、已经付过钱的候选计划丢掉）。只保留其中一条都会让另半个语义悄悄退化。
   */
  it('★ 反向锁：同一组超预算输入下，事前闸门仍必须 MAX_DURATION', () => {
    // 真的把时钟顶过上限（当前 90s + 15s），确保这条不是靠"刚好没超时"空转。
    const wayOver = DEFAULT_GATE_CONFIG.maxDurationMs + 15_000;
    expect(checkGates(budget(), wayOver)).toEqual({ allowed: false, reason: 'MAX_DURATION' });
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
    expect(judgeConvergence({ delta })).toEqual({ allowed: true });
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
    expect(judgeConvergence({ delta })).toEqual({
      allowed: false,
      reason: 'NO_CONVERGENCE',
    });
  });
});

describe('isStagnant / judgeConvergence（只做收敛判定）', () => {
  it('delta < 0.15 → 未收敛', () => {
    expect(isStagnant(0.1)).toBe(true);
    expect(isStagnant(0.15)).toBe(false);
    expect(isStagnant(0.4)).toBe(false);
  });

  it('delta 足够 → 放行', () => {
    expect(judgeConvergence({ delta: 0.5 })).toEqual({ allowed: true });
  });

  it('delta 过小 → 强制转人工（NO_CONVERGENCE）', () => {
    const outcome = judgeConvergence({ delta: 0.02 });
    expect(outcome).toEqual({ allowed: false, reason: 'NO_CONVERGENCE' });
  });

  it('★ 回归锁：即使耗时已远超 maxDurationMs，delta 够大也必须放行', () => {
    // 这就是本次线上故障的那一刀：旧实现把 checkGates 放在事后，于是一次
    // 10–30s 的真模型重排调用刚算完候选计划，就因为"自己花了时间"被打回
    // `重规划被闸门拦截：MAX_DURATION`，自动修复事实上必然失效。
    //
    // 旧实现下这条会返回 `{allowed:false, reason:'MAX_DURATION'}` —— 因为
    // `checkGates(budget, nowMs)` 在 `nowMs - startedAtMs` 远超上限时必然拒绝。
    // 现在 `judgeConvergence` 连 `budget` / `nowMs` 参数都不接收 —— 事后拿不到
    // 预算数据，"复查时长"在类型层面就不可能发生。这条断言把该语义钉死。
    const budget: ReplanBudget = { replanCount: 0, costCNY: 0, startedAtMs: 0 };
    const wayOverNowMs = DEFAULT_GATE_CONFIG.maxDurationMs + 15_000;
    // 前提：同一组输入下，**事前**闸门确实会拒绝（否则这条断言是空转的）。
    expect(checkGates(budget, wayOverNowMs)).toEqual({
      allowed: false,
      reason: 'MAX_DURATION',
    });
    // 核心断言：同一组输入下，**事后**判定只看 delta → 放行。
    expect(judgeConvergence({ delta: 0.5 })).toEqual({ allowed: true });
  });

  it('★ 事后判定唯一会返回的拒绝理由是 NO_CONVERGENCE（不再有预算类理由）', () => {
    // 遍历所有delta：除"不收敛"外没有任何拒绝路径。
    const reasons = [0, 0.02, 0.1, 0.14, 0.5, 1].map(
      (delta) => judgeConvergence({ delta }).allowed,
    );
    expect(reasons).toEqual([false, false, false, false, true, true]);
  });

  it('★ 预算耗尽不再由事后判定拦截（次数/成本/时长一律不看）', () => {
    // 旧语义下这条会返回 MAX_REPLANS（预算已触顶）；新语义下预算是**事前**闸门，
    // 由 `checkGates` 在起飞前负责，已由上面 `checkGates` 的用例覆盖。
    // 这里钉的是"收敛判定不越权"：它只认delta。
    expect(judgeConvergence({ delta: 1 })).toEqual({ allowed: true });
    expect(checkGates(budget({ replanCount: 5 }), 1_000)).toEqual({
      allowed: false,
      reason: 'MAX_REPLANS',
    });
  });

  it('默认闸门配置与 PRD 一致', () => {
    expect(DEFAULT_GATE_CONFIG.maxReplans).toBe(5);
    expect(DEFAULT_GATE_CONFIG.maxCostCNY).toBe(2);
    // ★ 90s = 真模型"规划往返 + 预留一次重排往返 + 余量"。改这个值前请先读
    //   `zGateConfig.maxDurationMs` 的推导注释，并同步抬高部署平台的 `maxDuration`。
    expect(DEFAULT_GATE_CONFIG.maxDurationMs).toBe(90_000);
    expect(DEFAULT_GATE_CONFIG.minDelta).toBe(0.15);
  });

  /**
   * ★ 预算抬高后的正向锁：**90s 之内不得拦，90s 之外必须拦**。
   *
   * 前半句锁的是"别把预算偷偷改回小值"（真模型单次往返 10–30s，25s 必然超时）；
   * 后半句锁的是"抬高预算不等于把闸门改成摆设"。两条一起读才是完整语义。
   */
  it('★ 90s 之内放行、超出即拦（抬高预算后闸门仍是活的）', () => {
    // 一次真模型重排往返的实测上界（30s）之后仍有余量 → 放行。
    expect(checkGates(budget(), 30_000)).toEqual({ allowed: true });
    // 恰好等于上限 → 放行（上限语义是"不超过"）。
    expect(checkGates(budget(), 90_000)).toEqual({ allowed: true });
    // 超出一毫秒 → MAX_DURATION。
    expect(checkGates(budget(), 90_001)).toEqual({ allowed: false, reason: 'MAX_DURATION' });
    // 远超上限 →MAX_DURATION。
    expect(checkGates(budget(), 180_000)).toEqual({ allowed: false, reason: 'MAX_DURATION' });
  });
});

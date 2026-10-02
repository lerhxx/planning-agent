import { describe, expect, it } from 'vitest';
import { brokenCompletedIds, collectImpact, completedStepIds } from './impact';
import { makePlan, makeStep } from '@/src/test/fixtures';

/** s-1(done) → s-2(pending) → s-3(pending)，另有 s-4 与 s-2 同组且独立 */
function samplePlan() {
  return makePlan([
    makeStep({ id: 's-1', order: 0, status: 'done' }),
    makeStep({ id: 's-2', order: 1, dependsOn: ['s-1'], status: 'failed' }),
    makeStep({ id: 's-3', order: 2, dependsOn: ['s-2'] }),
  ]);
}

describe('collectImpact', () => {
  it('反向收集下游子树', () => {
    const impact = collectImpact(samplePlan(), ['s-2']);
    expect(impact.impactedIds).toEqual(['s-2', 's-3']);
    expect(impact.resumeFrom).toBe('s-2');
  });

  it('已完成步骤不进入影响面（天然冻结）', () => {
    const impact = collectImpact(samplePlan(), ['s-1']);
    expect(impact.impactedIds).toEqual([]);
    expect(impact.frozenIds).toEqual(['s-1']);
    expect(impact.resumeFrom).toBeNull();
  });

  it('传递闭包：只收直接依赖不算够', () => {
    const plan = makePlan([
      makeStep({ id: 'a', order: 0 }),
      makeStep({ id: 'b', order: 1, dependsOn: ['a'] }),
      makeStep({ id: 'c', order: 2, dependsOn: ['b'] }),
      makeStep({ id: 'd', order: 3, dependsOn: ['c'] }),
    ]);
    expect(collectImpact(plan, ['a']).impactedIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('无影响面时返回空，不报错', () => {
    const impact = collectImpact(makePlan([]), ['ghost']);
    expect(impact.impactedIds).toEqual([]);
    expect(impact.resumeFrom).toBeNull();
  });
});

describe('保留已完成 stepId（C0-07）', () => {
  it('重规划后的计划若保留已完成步骤 → 无破损', () => {
    const before = samplePlan();
    const after = makePlan([
      before.steps[0], // s-1 原样保留
      makeStep({ id: 'r2-1', order: 1, dependsOn: ['s-1'], status: 'done' }),
      makeStep({ id: 'r2-2', order: 2, dependsOn: ['r2-1'] }),
    ]);

    expect(completedStepIds(before)).toEqual(['s-1']);
    expect(brokenCompletedIds(before, after)).toEqual([]);
  });

  it('若已完成步骤被删掉 → 检出破损 id', () => {
    const before = samplePlan();
    const after = makePlan([
      makeStep({ id: 'r2-1', order: 0 }),
      makeStep({ id: 'r2-2', order: 1, dependsOn: ['r2-1'] }),
    ]);
    expect(brokenCompletedIds(before, after)).toEqual(['s-1']);
  });

  it('已完成步骤被改了类型也算破损', () => {
    const before = samplePlan();
    const after = makePlan([
      { ...before.steps[0], type: 'other' },
      makeStep({ id: 'r2-1' }),
    ]);
    expect(brokenCompletedIds(before, after)).toEqual(['s-1']);
  });
});

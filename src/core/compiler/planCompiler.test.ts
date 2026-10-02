import { describe, expect, it } from 'vitest';
import { compilePlan } from './planCompiler';
import { makePlan, makeStep } from '@/src/test/fixtures';

describe('compilePlan', () => {
  it('正常编译：线性链 → 每层一个批次', () => {
    const plan = makePlan([
      makeStep({ id: 's-1', order: 0 }),
      makeStep({ id: 's-2', order: 1, dependsOn: ['s-1'] }),
      makeStep({ id: 's-3', order: 2, dependsOn: ['s-2'] }),
    ]);

    const result = compilePlan(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.batches).toEqual([['s-1'], ['s-2'], ['s-3']]);
    expect(result.graph.edges).toEqual([
      { from: 's-1', to: 's-2' },
      { from: 's-2', to: 's-3' },
    ]);
  });

  it('parallelGroup：同组抬平到同一批次', () => {
    const plan = makePlan([
      makeStep({ id: 's-1', order: 0 }),
      makeStep({ id: 's-2', order: 1, dependsOn: ['s-1'], parallelGroup: 'g' }),
      makeStep({ id: 's-3', order: 2, parallelGroup: 'g' }),
    ]);

    const result = compilePlan(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.batches).toEqual([['s-1'], ['s-2', 's-3']]);
  });

  it('有环时报错而不是死循环', () => {
    const plan = makePlan([
      makeStep({ id: 'a', dependsOn: ['c'] }),
      makeStep({ id: 'b', dependsOn: ['a'] }),
      makeStep({ id: 'c', dependsOn: ['b'] }),
    ]);

    const result = compilePlan(plan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_CYCLE_DETECTED');
    expect(result.cycle.length).toBeGreaterThanOrEqual(3);
  });

  it('依赖缺失时报错', () => {
    const plan = makePlan([makeStep({ id: 'a', dependsOn: ['ghost'] })]);
    const result = compilePlan(plan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_DEPENDENCY_MISSING');
  });

  it('同组内互相依赖时报错', () => {
    const plan = makePlan([
      makeStep({ id: 'a', parallelGroup: 'g' }),
      makeStep({ id: 'b', dependsOn: ['a'], parallelGroup: 'g' }),
    ]);
    const result = compilePlan(plan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_PARALLEL_GROUP_DEPENDENCY');
  });

  it('纯函数：同样的入参产出同样的图，且不改动入参', () => {
    const steps = [
      makeStep({ id: 's-1', order: 0 }),
      makeStep({ id: 's-2', order: 1, dependsOn: ['s-1'] }),
    ];
    const plan = makePlan(steps);
    const snapshot = JSON.stringify(plan);

    const first = compilePlan(plan);
    const second = compilePlan(plan);

    expect(first.ok && second.ok).toBe(true);
    expect(JSON.stringify(first.ok ? first.graph : null)).toEqual(
      JSON.stringify(second.ok ? second.graph : null),
    );
    expect(JSON.stringify(plan)).toEqual(snapshot);
  });
});

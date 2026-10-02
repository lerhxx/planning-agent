import { describe, expect, it } from 'vitest';
import { applyEdit, classifyEdit } from './edit';
import { makePlan, makeStep } from '@/src/test/fixtures';
import type { Goal } from '@/shared/plan/types';

const goal: Goal = {
  id: 'goal-unit',
  runId: 'run-unit',
  raw: '做一件事',
  summary: '做一件事',
  constraints: [],
  resources: {},
  successCriteria: [],
  missingFields: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** s-1(done) → s-2(pending) → s-3(pending) */
function samplePlan() {
  return makePlan([
    makeStep({ id: 's-1', order: 0, status: 'done', title: '已完成步骤' }),
    makeStep({ id: 's-2', order: 1, dependsOn: ['s-1'], title: '第二步' }),
    makeStep({ id: 's-3', order: 2, dependsOn: ['s-2'], title: '第三步' }),
  ]);
}

describe('classifyEdit（三档判定）', () => {
  it('L0：只改未执行步骤的文本且无下游', () => {
    const plan = makePlan([makeStep({ id: 's-1' })]);
    const result = classifyEdit({ kind: 'editStep', stepId: 's-1', patch: { title: '改个名字' } }, plan);
    expect(result.level).toBe('L0');
    expect(result.impactedStepIds).toEqual([]);
  });

  it('L1：改了有下游的步骤', () => {
    const plan = samplePlan();
    const result = classifyEdit({ kind: 'editStep', stepId: 's-2', patch: { title: '改个名字' } }, plan);
    expect(result.level).toBe('L1');
    expect(result.impactedStepIds).toEqual(['s-2', 's-3']);
  });

  it('L1：删除步骤', () => {
    const result = classifyEdit({ kind: 'removeStep', stepId: 's-2' }, samplePlan());
    expect(result.level).toBe('L1');
    expect(result.impactedStepIds).toEqual(['s-2', 's-3']);
  });

  it('L2：改目标级约束', () => {
    const result = classifyEdit(
      { kind: 'editGoal', constraints: [{ kind: 'budget', value: '100', raw: 'budget<=100' }] },
      samplePlan(),
    );
    expect(result.level).toBe('L2');
    // 已完成步骤不在影响面内
    expect(result.impactedStepIds).toEqual(['s-2', 's-3']);
  });

  it('L0：新增无依赖步骤', () => {
    const result = classifyEdit(
      {
        kind: 'addStep',
        draft: { type: 'task', title: '新步骤', dependsOn: [], intent: null },
        dependsOn: [],
      },
      samplePlan(),
    );
    expect(result.level).toBe('L0');
  });
});

describe('applyEdit（回写）', () => {
  it('L0 直接改，不改其他步骤', () => {
    const plan = makePlan([makeStep({ id: 's-1', title: '旧标题' })]);
    const result = applyEdit(
      plan,
      goal,
      { kind: 'editStep', stepId: 's-1', patch: { title: '新标题' } },
      { runId: 'run-unit' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.level).toBe('L0');
    expect(result.plan.steps[0].title).toBe('新标题');
    expect(result.plan.steps[0].origin.kind).toBe('user');
  });

  it('L1 把受影响步骤打回 pending，已完成步骤原样保留', () => {
    const plan = samplePlan();
    const result = applyEdit(
      plan,
      goal,
      { kind: 'editStep', stepId: 's-2', patch: { title: '改个名字' } },
      { runId: 'run-unit' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.level).toBe('L1');
    expect(result.impactedStepIds).toEqual(['s-2', 's-3']);
    expect(result.plan.steps.find((s) => s.id === 's-1')?.status).toBe('done');
    expect(result.plan.steps.find((s) => s.id === 's-3')?.status).toBe('pending');
  });

  it('L2 改目标约束：revision+1，未完成步骤回到 pending', () => {
    const plan = samplePlan();
    const result = applyEdit(
      plan,
      goal,
      { kind: 'editGoal', constraints: [{ kind: 'budget', value: '100', raw: 'budget<=100' }] },
      { runId: 'run-unit' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.level).toBe('L2');
    expect(result.plan.revision).toBe(2);
    expect(result.goal.constraints).toHaveLength(1);
    expect(result.plan.steps.find((s) => s.id === 's-1')?.status).toBe('done');
  });

  it('★ 已完成步骤默认冻结：直接改 → FROZEN_STEP', () => {
    const plan = samplePlan();
    const result = applyEdit(
      plan,
      goal,
      { kind: 'editStep', stepId: 's-1', patch: { title: '改已完成的' } },
      { runId: 'run-unit' },
    );
    expect(result).toEqual({ ok: false, reason: 'FROZEN_STEP' });
  });

  it('★ 显式 rollback_to_step 解冻该步及其下游，之后可以改已完成的步骤', () => {
    const plan = samplePlan();
    const rolledBack = applyEdit(plan, goal, { kind: 'rollback_to_step', stepId: 's-1' }, {
      runId: 'run-unit',
    });

    expect(rolledBack.ok).toBe(true);
    if (!rolledBack.ok) return;
    expect(rolledBack.level).toBe('L1');
    // s-1 及其下游全部解冻
    expect(rolledBack.plan.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(rolledBack.plan.steps.find((s) => s.id === 's-1')?.result).toBeUndefined();

    const after = applyEdit(
      rolledBack.plan,
      goal,
      { kind: 'editStep', stepId: 's-1', patch: { title: '解冻后改' } },
      { runId: 'run-unit' },
    );
    expect(after.ok).toBe(true);
  });

  it('删除步骤会清理下游依赖', () => {
    const plan = samplePlan();
    const result = applyEdit(plan, goal, { kind: 'removeStep', stepId: 's-2' }, { runId: 'run-unit' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((s) => s.id)).toEqual(['s-1', 's-3']);
    expect(result.plan.steps.find((s) => s.id === 's-3')?.dependsOn).toEqual([]);
  });

  it('步骤不存在 → STEP_NOT_FOUND', () => {
    const result = applyEdit(
      samplePlan(),
      goal,
      { kind: 'editStep', stepId: 'ghost', patch: { title: 'x' } },
      { runId: 'run-unit' },
    );
    expect(result).toEqual({ ok: false, reason: 'STEP_NOT_FOUND' });
  });
});

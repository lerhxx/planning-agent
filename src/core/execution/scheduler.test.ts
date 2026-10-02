import { describe, expect, it } from 'vitest';
import { isBatchSettled, isLiveStepStatus, liveBatches, markBatchReady, partitionBatch } from './scheduler';
import { compilePlan } from '@/src/core/compiler/planCompiler';
import { makePlan, makeStep } from '@/src/test/fixtures';
import type { StepStatus } from '@/shared/plan/types';

describe('partitionBatch', () => {
  it('同组并行：组内聚成一个并发块', () => {
    const steps = [
      makeStep({ id: 's-1', parallelGroup: 'g' }),
      makeStep({ id: 's-2', parallelGroup: 'g' }),
      makeStep({ id: 's-3' }),
    ];
    const chunks = partitionBatch(steps);
    expect(chunks).toEqual([
      { parallelGroup: 'g', stepIds: ['s-1', 's-2'] },
      { stepIds: ['s-3'] },
    ]);
  });

  it('无分组：逐步顺序执行', () => {
    const chunks = partitionBatch([makeStep({ id: 's-1' }), makeStep({ id: 's-2' })]);
    expect(chunks).toEqual([{ stepIds: ['s-1'] }, { stepIds: ['s-2'] }]);
  });
});

describe('liveBatches', () => {
  it('过滤掉已完成的批次', () => {
    const plan = makePlan([
      makeStep({ id: 's-1', order: 0, status: 'done' }),
      makeStep({ id: 's-2', order: 1, dependsOn: ['s-1'] }),
    ]);
    const compiled = compilePlan(plan);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const statuses = new Map<string, StepStatus>(plan.steps.map((s) => [s.id, s.status]));
    expect(liveBatches(compiled.graph, statuses)).toEqual([['s-2']]);
  });
});

describe('isBatchSettled / markBatchReady', () => {
  it('全部 done 才算 settled', () => {
    const statuses = new Map<string, StepStatus>([
      ['s-1', 'done'],
      ['s-2', 'running'],
    ]);
    expect(isBatchSettled(['s-1'], statuses)).toBe(true);
    expect(isBatchSettled(['s-1', 's-2'], statuses)).toBe(false);
  });

  it('只把 pending 置为 ready，不改动入参', () => {
    const steps = [
      makeStep({ id: 's-1', status: 'pending' }),
      makeStep({ id: 's-2', status: 'done' }),
    ];
    const next = markBatchReady(steps, ['s-1', 's-2']);
    expect(next[0].status).toBe('ready');
    expect(next[1].status).toBe('done');
    expect(steps[0].status).toBe('pending');
  });
});

describe('isLiveStepStatus', () => {
  it('终态不再参与调度', () => {
    expect(isLiveStepStatus('pending')).toBe(true);
    expect(isLiveStepStatus('failed')).toBe(true);
    expect(isLiveStepStatus('done')).toBe(false);
    expect(isLiveStepStatus('skipped')).toBe(false);
  });
});

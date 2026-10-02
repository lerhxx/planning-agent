/**
 * 单测夹具：从 zod schema 出发构造 Step / Plan，避免手写第二份类型。
 */
import { zPlan, zStep, type Plan, type Step } from '@/shared/plan/types';

const FIXED_TIME = '2026-01-01T00:00:00.000Z';

export function makeStep(partial: Partial<Step> & { id: string }): Step {
  return zStep.parse({
    domainId: 'unit',
    type: 'task',
    order: 0,
    title: partial.id,
    status: 'pending',
    intent: null,
    idempotencyKey: '',
    attempt: 0,
    maxAttempts: 2,
    origin: { kind: 'planner', revision: 1 },
    emittedNodeIds: [],
    dependsOn: [],
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...partial,
  });
}

export function makePlan(steps: Step[], overrides: Partial<Plan> = {}): Plan {
  return zPlan.parse({
    id: 'plan-unit',
    runId: 'run-unit',
    goalId: 'goal-unit',
    domainId: 'unit',
    revision: 1,
    status: 'draft',
    summary: '',
    steps,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...overrides,
  });
}

/** 线性链：s-1 → s-2 → … → s-N */
export function makeChain(length: number, statusOf?: (index: number) => Step['status']): Step[] {
  return Array.from({ length }, (_, index) =>
    makeStep({
      id: `s-${index + 1}`,
      order: index,
      dependsOn: index === 0 ? [] : [`s-${index}`],
      status: statusOf ? statusOf(index) : 'pending',
    }),
  );
}

/**
 * ★ `buildSteps` 的 `dependsOn` 悬空引用检查。
 *
 * 模型（Runtime）给的 `dependsOn` 是**不可信输入**：它可能写一个自己从没铸造过的 id，
 * 也可能干脆留空。这类契约违规必须在草稿落进 `Plan` 的**第一现场**就被拒掉 ——
 * 否则它会一直沉到编译期（`PLAN_DEPENDENCY_MISSING`）或领域校验里，
 * 变成一句与模型行为无关的、排查成本极高的拒绝。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_DEGRADE_CHAIN, type ToolSpec } from '@/shared/domain/types';
import { zGoal, zStepDraft, type Goal } from '@/shared/plan/types';
import { zRunContext, type RunContext } from '@/shared/run/types';
import { zPlanDraft, type PlanDraft, type RuntimeAdapter } from '@/src/core/runtime/adapter';
import { clearDomainPacks, registerDomainPack } from '@/src/core/registry/domainRegistry';
import { makePlan, makeStep } from '@/src/test/fixtures';
import { applyReplanDraft, createPlan } from './planner';

const DOMAIN_ID = 'unit';

/** 注册一个只认 `task` 槽位的最小领域包，供 `createPlan` 走完白名单分支。 */
function registerUnitPack(): void {
  clearDomainPacks();
  const tool: ToolSpec = {
    name: 'unit.tool',
    description: '单元测试工具',
    inputSchema: z.object({ q: z.string().default('') }),
    producesFacts: false,
    idempotent: true,
    timeoutMs: 1_000,
    retryable: true,
    stepType: 'task',
    execute: async () => ({ ok: true, sourceRefs: [], isEstimate: false, durationMs: 0 }),
  };
  const result = registerDomainPack({
    meta: {
      id: DOMAIN_ID,
      displayName: 'Unit',
      version: '1.0.0',
      schemaVersion: 1,
      description: '单元测试用领域包',
      matcher: { keywords: [], patterns: [], negativeKeywords: [], scoreBySignals: {} },
      requiredSignals: [],
      capabilities: { vision: false, geo: false, providers: true, timeSequence: false },
    },
    tools: { 'unit.tool': tool },
    providers: {
      namespace: 'unit',
      create: () => ({}),
      createValidator: () => ({ id: 'unit.validator', validate: () => ({ ok: true, violations: [] }) }),
    },
    ui: { components: [], degradeChain: CORE_DEGRADE_CHAIN, stepRenderers: {} },
    prompts: { worldview: 'w', constraints: 'c', antiHallucination: '不得编造事实' },
    planning: {
      stepTypes: [{ type: 'task', label: '任务', maxAttempts: 2 }],
      templates: [],
      validateStep: () => ({ ok: true, violations: [] }),
    },
    evaluation: { cases: [], metricIds: [] },
  });
  if (!result.ok) throw new Error(`注册失败：${result.issues.join(' / ')}`);
}

function makeDraft(steps: Array<Record<string, unknown>>, summary = 's'): PlanDraft {
  return zPlanDraft.parse({
    summary,
    steps: steps.map((step) => zStepDraft.parse({ type: 'task', dependsOn: [], ...step })),
  });
}

/** 只返回固定草稿的 RuntimeStub —— 规划与重规划都不发请求。 */
function makeRuntime(draft: PlanDraft): RuntimeAdapter {
  return {
    id: 'stub',
    plan: async () => draft,
    replan: async () => draft,
    runTool: async () => ({ ok: true, sourceRefs: [], isEstimate: false, durationMs: 0 }),
  };
}

const goal: Goal = zGoal.parse({
  id: 'goal-unit',
  runId: 'run-unit',
  raw: '做一件事',
  summary: '做一件事',
  createdAt: '2026-01-01T00:00:00.000Z',
});

const ctx: RunContext = zRunContext.parse({
  runId: 'run-unit',
  traceId: 'trace-unit',
  goalId: 'goal-unit',
  domainId: DOMAIN_ID,
  startedAt: '2026-01-01T00:00:00.000Z',
  deadlineAt: '2026-01-01T00:01:00.000Z',
});

async function plan(draft: PlanDraft) {
  return createPlan(
    { goal, ctx, domainId: DOMAIN_ID },
    { runtime: makeRuntime(draft), now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
}

describe('createPlan：草稿里 dependsOn 指向不存在的步骤 id → 第一现场拒绝', () => {
  beforeAll(() => {
    registerUnitPack();
  });

  it('★ 悬空引用 → ok:false，错误码是内核白名单码并指出具体引用', async () => {
    const result = await plan(
      makeDraft([
        { id: 's-1', title: '第一步', dependsOn: [] },
        { id: 's-2', title: '第二步', dependsOn: ['s-99'] },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_GENERATION_FAILED');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('计划里有步骤依赖了不存在的步骤 id');
    const detail = result.error.detail as { dangling: Array<{ stepId: string; ref: string }> };
    expect(detail.dangling).toEqual([{ stepId: 's-2', ref: 's-99' }]);
  });

  it('★ 前向引用（依赖排在后面的步骤）是合法的 → 不得误杀', async () => {
    const result = await plan(
      makeDraft([
        { id: 's-1', title: '第一步', dependsOn: ['s-2'] },
        { id: 's-2', title: '第二步', dependsOn: [] },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.id)).toEqual(['s-1', 's-2']);
    expect(result.plan.steps[0]?.dependsOn).toEqual(['s-2']);
  });

  it('依赖全部自洽（含链式和同批并行）→ 正常出计划', async () => {
    const result = await plan(
      makeDraft([
        { id: 's-1', title: '第一步', dependsOn: [] },
        { id: 's-2', title: '第二步', dependsOn: ['s-1'] },
        { id: 's-3', title: '第三步', dependsOn: ['s-1', 's-2'] },
      ]),
    );

    expect(result.ok).toBe(true);
  });
});

describe('applyReplanDraft：新步骤可以引用保留步骤的 id', () => {
  /** s-1(done) → s-2(pending)；重排只替换 s-2。 */
  function basePlan() {
    return makePlan([
      makeStep({ id: 's-1', order: 0, status: 'done', title: '已完成步骤' }),
      makeStep({ id: 's-2', order: 1, dependsOn: ['s-1'], title: '待重排步骤' }),
    ]);
  }

  it('★ 新步骤引用保留步骤 s-1 → 通过（保留步骤的 id 不在本草稿内）', () => {
    const before = basePlan();
    const rejected: unknown[] = [];
    const after = applyReplanDraft({
      plan: before,
      draft: makeDraft([
        { id: 'r2-1', title: '重排后的第二步', dependsOn: ['s-1'] },
        { id: 'r2-2', title: '重排后的第三步', dependsOn: ['r2-1'] },
      ]),
      impactedIds: ['s-2'],
      revision: 2,
      reason: 'step-failed',
      runId: 'run-unit',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      onReject: (error) => rejected.push(error),
    });

    expect(rejected).toEqual([]);
    expect(after.steps.map((step) => step.id)).toEqual(['s-1', 'r2-1', 'r2-2']);
    expect(after.steps.find((step) => step.id === 'r2-1')?.dependsOn).toEqual(['s-1']);
  });

  it('★ 引用既不是本草稿 id、也不是保留步骤 id 的 id → 拒绝，且不丢步骤', () => {
    const before = basePlan();
    let rejected: { code: string; detail?: unknown } | undefined;
    const after = applyReplanDraft({
      plan: before,
      draft: makeDraft([{ id: 'r2-1', title: '重排后的第二步', dependsOn: ['s-777'] }]),
      impactedIds: ['s-2'],
      revision: 2,
      reason: 'step-failed',
      runId: 'run-unit',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      onReject: (error) => {
        rejected = { code: error.code, detail: error.detail };
      },
    });

    expect(rejected?.code).toBe('PLAN_GENERATION_FAILED');
    expect((rejected?.detail as { dangling: Array<{ ref: string }> }).dangling).toEqual([
      { stepId: 'r2-1', ref: 's-777' },
    ]);
    // 草稿被拒 → 保留原有步骤，绝不让 s-2 凭空消失。
    expect(after.steps.map((step) => step.id)).toEqual(['s-1', 's-2']);
  });
});

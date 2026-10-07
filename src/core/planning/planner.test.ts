/**
 * ★ `buildSteps` 的 `dependsOn` 悬空引用检查与 `intent.toolName` 注册名校验，
 * 外加「工具清单真的进了 `PlanRequest`」的装配回归。
 *
 * 模型（Runtime）给的 `dependsOn` 与 `intent.toolName` 都是**不可信输入**：
 * 前者可能引用一个自己从没铸造过的 id，也可能干脆留空；
 * 后者可能是模型凭语义**猜**出来的名字（领域里根本没注册）。
 * 这类契约违规必须在草稿落进 `Plan` 的**第一现场**就被拒掉——
 * 否则它会一直沉到编译期或执行期，变成一句与模型行为无关的、排查成本极高的拒绝。
 *
 * ★ 工具名这一条尤其重要：放行到执行期的代价是每一次调用都返回
 * `工具未在当前领域注册`，步骤重试到上限全失败，5 次重排耗尽后用户只看到
 * `MAX_REPLANS` —— 一句与真实病因（名字不存在）完全无关的错误。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_DEGRADE_CHAIN, type ToolSpec } from '@/shared/domain/types';
import { zGoal, zStepDraft, type Goal } from '@/shared/plan/types';
import { zRunContext, type RunContext } from '@/shared/run/types';
import { zPlanDraft, type PlanDraft, type PlanRequest, type RuntimeAdapter } from '@/src/core/runtime/adapter';
import {
  clearDomainPacks,
  getDomainPack,
  getStepType,
  getToolBriefs,
  getToolNames,
  getTools,
  registerDomainPack,
} from '@/src/core/registry/domainRegistry';
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
  // ★ 第二个工具：用来验证"合法工具名不止一个"时错误信息给的是全集而非全集的碎片。
  //   它刻意挂在 `heavy`（maxAttempts 5）而不是 `task`（2）——
  //   这样"maxAttempts 取自工具所属 stepType"这条断言才有区分度：
  //   若实现写死成同一个数（例如恒为 2），下面的断言会立刻变红。
  const other: ToolSpec = {
    ...tool,
    name: 'unit.another',
    description: '另一个单元测试工具',
    stepType: 'heavy',
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
    // ★ 故意**乱序**注册（another 在前），用来证明清单顺序不依赖字面量书写顺序。
    tools: { 'unit.another': other, 'unit.tool': tool },
    providers: {
      namespace: 'unit',
      create: () => ({}),
      createValidator: () => ({ id: 'unit.validator', validate: () => ({ ok: true, violations: [] }) }),
    },
    ui: { components: [], degradeChain: CORE_DEGRADE_CHAIN, stepRenderers: {} },
    prompts: { worldview: 'w', constraints: 'c', antiHallucination: '不得编造事实' },
    planning: {
      stepTypes: [
        { type: 'task', label: '任务', maxAttempts: 2 },
        // 第二个 stepType 的 maxAttempts 刻意不同，用来验证 prompt 里的重试上限不是写死的
        { type: 'heavy', label: '重活', description: '更重的任务', maxAttempts: 5 },
      ],
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

/* ------------------------------------------------------------------ *
 * ★ 目标摘要注入：全仓库唯一的注入点在 `buildSteps`
 * ------------------------------------------------------------------ */

describe('★ 目标摘要注入工具入参（真模型路径的必修项）', () => {
  beforeAll(() => {
    registerUnitPack();
  });

  /** 一条带 `intent` 的检索型草稿步骤。 */
  function searchStep(overrides: Record<string, unknown> = {}) {
    return {
      id: 's-1',
      title: '检索候选',
      dependsOn: [],
      intent: { toolName: 'unit.tool', input: { category: 'museum' }, producesFacts: true },
      ...overrides,
    };
  }

  function inputOf(step: { intent: { input: Record<string, unknown> } | null } | undefined) {
    return step?.intent?.input;
  }

  it('★★ 模型没写 goalSummary → 注入内核的真实摘要（用户报的故障主断言）', async () => {
    const result = await plan(makeDraft([searchStep()]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(inputOf(result.plan.steps[0])).toEqual({ category: 'museum', goalSummary: goal.summary });
  });

  it('★ 模型自己写了一个转述 → 被内核的真实摘要覆盖（口径不能由模型说了算）', async () => {
    const result = await plan(
      makeDraft([
        searchStep({
          intent: {
            toolName: 'unit.tool',
            // 模型自行编的摘要：与内核事实不符。
            input: { category: 'museum', goalSummary: '随便找个地方玩三天' },
            producesFacts: true,
          },
        }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(inputOf(result.plan.steps[0])?.goalSummary).toBe(goal.summary);
  });

  it('★ 模型写的其它入参字段（category / limit / city 等）原样保留', async () => {
    const result = await plan(
      makeDraft([
        searchStep({
          intent: {
            toolName: 'unit.tool',
            input: { category: 'museum', limit: 5, city: '杭州', nested: { keep: true } },
            producesFacts: true,
          },
        }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(inputOf(result.plan.steps[0])).toEqual({
      category: 'museum',
      limit: 5,
      city: '杭州',
      nested: { keep: true },
      goalSummary: goal.summary,
    });
  });

  it('★ intent 为 null 的纯推理步骤 → 不注入、不报错', async () => {
    const result = await plan(
      makeDraft([
        { id: 's-1', title: '推理一步', dependsOn: [], intent: null },
        searchStep({ id: 's-2' }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps[0]?.intent).toBeNull();
    expect(inputOf(result.plan.steps[1])?.goalSummary).toBe(goal.summary);
  });

  it('★ 注入不修改草稿对象本身（纯函数，重复调用结果一致）', async () => {
    const draft = makeDraft([searchStep()]);
    const first = await plan(draft);
    const second = await plan(draft);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(inputOf(first.plan.steps[0])).toEqual(inputOf(second.plan.steps[0]));
    expect(draft.steps[0]?.intent?.input).toEqual({ category: 'museum' });
  });

  it('★★ 重排路径：新生成的步骤同样带上目标摘要（重排不再是同一条死路）', () => {
    const before = makePlan([makeStep({ id: 's-1', order: 0, title: '待重排步骤' })]);
    const after = applyReplanDraft({
      plan: before,
      draft: makeDraft([
        {
          id: 'r2-1',
          title: '重排后的检索步骤',
          dependsOn: [],
          intent: { toolName: 'unit.tool', input: { category: 'museum' }, producesFacts: true },
        },
      ]),
      impactedIds: ['s-1'],
      revision: 2,
      reason: 'step-failed',
      runId: 'run-unit',
      goalSummary: goal.summary,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const fresh = after.steps.find((step) => step.id === 'r2-1');
    expect(fresh?.intent?.input).toEqual({ category: 'museum', goalSummary: goal.summary });
  });

  it('★ 重排路径：模型在重排草稿里写的转述同样被覆盖', () => {
    const before = makePlan([makeStep({ id: 's-1', order: 0, title: '待重排步骤' })]);
    const after = applyReplanDraft({
      plan: before,
      draft: makeDraft([
        {
          id: 'r2-1',
          title: '重排后的检索步骤',
          dependsOn: [],
          intent: {
            toolName: 'unit.tool',
            input: { goalSummary: '模型编的摘要' },
            producesFacts: true,
          },
        },
      ]),
      impactedIds: ['s-1'],
      revision: 2,
      reason: 'step-failed',
      runId: 'run-unit',
      goalSummary: goal.summary,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(after.steps.find((step) => step.id === 'r2-1')?.intent?.input?.goalSummary).toBe(
      goal.summary,
    );
  });
});

/* ------------------------------------------------------------------ *
 * ★★ 工具名校验：把"跑 3 次重排后报 MAX_REPLANS"变成"第一次就告诉你名字不存在"
 * ------------------------------------------------------------------ */

/*
 * 故障现象：模型猜了一个不存在的工具名（把领域概念自行拼成"名.动作"），
 * 每一次工具调用都返回`工具未在当前领域注册`，步骤重试到上限全失败，
 * 5 次重排耗尽后用户只看到一句`MAX_REPLANS` —— 与真实病因（名字不存在）毫无关系。
 *
 * 这条校验的价值就在这里：**把病因放到第一现场**。
 * 语义与 `dependsOn` 悬空校验保持一致 —— 宁可明确报错，也不把非法值静默放行到执行期。
 */
describe('createPlan：intent.toolName 未注册 → 第一现场拒绝', () => {
  beforeAll(() => {
    registerUnitPack();
  });

  it('★★ 工具名写错 → ok:false，错误码在白名单内，且 detail 指出写错的名字与合法名字', async () => {
    const result = await plan(
      makeDraft([
        {
          id: 's-1',
          title: '检索候选',
          dependsOn: [],
          // 模型凭语义猜了一个名字 —— 领域里根本没有
          intent: { toolName: 'unit.retrieve', input: {}, producesFacts: true },
        },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_GENERATION_FAILED');
    // 重新采样一次很可能就对了，所以可重试
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('步骤引用了当前领域未注册的工具');

    const detail = result.error.detail as {
      stepId: string;
      toolName: string;
      allowedToolNames: string[];
      totalAllowed: number;
    };
    // 写错的名字必须被回指，否则调用方无从判断是哪一步
    expect(detail.toolName).toBe('unit.retrieve');
    expect(detail.stepId).toBe('s-1');
    // 合法名字必须一起给出：只说"不合法"而不说"合法的是什么"，重采样仍然是猜
    expect(detail.allowedToolNames).toEqual(['unit.another', 'unit.tool']);
    expect(detail.totalAllowed).toBe(2);
  });

  it('★ 合法工具名 → 通过（别把正常计划误杀）', async () => {
    const result = await plan(
      makeDraft([
        {
          id: 's-1',
          title: '检索候选',
          dependsOn: [],
          intent: { toolName: 'unit.tool', input: {}, producesFacts: true },
        },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps[0]?.intent?.toolName).toBe('unit.tool');
  });

  it('★★ 第二个合法工具名同样通过（合法集合不止一个，不能只放行第一个）', async () => {
    const result = await plan(
      makeDraft([
        {
          id: 's-1',
          title: '换个工具',
          dependsOn: [],
          intent: { toolName: 'unit.another', input: {}, producesFacts: false },
        },
      ]),
    );

    expect(result.ok).toBe(true);
  });

  it('★★ intent 为 null 的纯推理步骤不参与工具名校验（否则所有纯推理步骤都会被拒）', async () => {
    const result = await plan(
      makeDraft([
        { id: 's-1', title: '纯推理一步', dependsOn: [], intent: null },
        { id: 's-2', title: '另一个纯推理步骤', dependsOn: ['s-1'], intent: null },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.every((step) => step.intent === null)).toBe(true);
  });

  it('★ 纯推理步骤与非法工具名混在一起 → 仍然拒绝，且指出的是那个非法的步骤', async () => {
    const result = await plan(
      makeDraft([
        { id: 's-1', title: '纯推理一步', dependsOn: [], intent: null },
        {
          id: 's-2',
          title: '猜错工具名',
          dependsOn: ['s-1'],
          intent: { toolName: 'unit.nope', input: {}, producesFacts: false },
        },
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error.detail as { stepId: string }).stepId).toBe('s-2');
  });

  it('★ 大小写 / 分隔符被改写也算非法（模型很容易这么干）', async () => {
    for (const wrong of ['Unit.Tool', 'unit-tool', 'unittool', 'unit.tool ']) {
      const result = await plan(
        makeDraft([
          {
            id: 's-1',
            title: '检索候选',
            dependsOn: [],
            intent: { toolName: wrong, input: {}, producesFacts: false },
          },
        ]),
      );
      expect(result.ok, `toolName=${JSON.stringify(wrong)} 应当被判非法`).toBe(false);
    }
  });
});

describe('applyReplanDraft：新步骤的 toolName 也要校验', () => {
  beforeAll(() => {
    registerUnitPack();
  });

  it('★ 重排的新步骤用了合法工具名 → 通过', () => {
    const before = makePlan([makeStep({ id: 's-1', order: 0, title: '待重排步骤' })]);
    const rejected: unknown[] = [];
    const after = applyReplanDraft({
      plan: before,
      draft: makeDraft([
        {
          id: 'r2-1',
          title: '重排后的检索步骤',
          dependsOn: [],
          intent: { toolName: 'unit.tool', input: {}, producesFacts: true },
        },
      ]),
      impactedIds: ['s-1'],
      revision: 2,
      reason: 'step-failed',
      runId: 'run-unit',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      onReject: (error) => rejected.push(error),
    });

    expect(rejected).toEqual([]);
    expect(after.steps.find((step) => step.id === 'r2-1')?.intent?.toolName).toBe('unit.tool');
  });

  it('★★ 重排换了另一个同样不存在的工具名 → 拒绝，且不丢步骤（不得静默通过）', () => {
    const before = makePlan([makeStep({ id: 's-1', order: 0, title: '待重排步骤' })]);
    let rejected: { code?: string; detail?: unknown } | undefined;
    const after = applyReplanDraft({
      plan: before,
      draft: makeDraft([
        {
          id: 'r2-1',
          title: '重排后的检索步骤',
          dependsOn: [],
          intent: { toolName: 'unit.somethingElse', input: {}, producesFacts: true },
        },
      ]),
      impactedIds: ['s-1'],
      revision: 2,
      reason: 'step-failed',
      runId: 'run-unit',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      onReject: (error) => {
        rejected = { code: error.code, detail: error.detail };
      },
    });

    expect(rejected?.code).toBe('PLAN_GENERATION_FAILED');
    const detail = rejected?.detail as { toolName: string; allowedToolNames: string[] };
    expect(detail.toolName).toBe('unit.somethingElse');
    expect(detail.allowedToolNames).toEqual(['unit.another', 'unit.tool']);
    // 与 `dependsOn` 悬空时同策：草稿被拒就保留原步骤，绝不让它凭空消失
    expect(after.steps.map((step) => step.id)).toEqual(['s-1']);
  });
});

/* ------------------------------------------------------------------ *
 * ★ 工具清单的装配：注册表 → PlanRequest
 * ------------------------------------------------------------------ */

describe('createPlan：把领域真实工具清单交给 runtime', () => {
  beforeAll(() => {
    registerUnitPack();
  });

  /** 跑一次 createPlan，返回 runtime 实际收到的 PlanRequest。 */
  async function captureRequest(draft: PlanDraft): Promise<Required<Pick<PlanRequest, 'tools'>>> {
    const seen: PlanRequest[] = [];
    const runtime: RuntimeAdapter = {
      id: 'capture',
      plan: async (request) => {
        seen.push(request);
        return draft;
      },
      replan: async () => draft,
      runTool: async () => ({ ok: true, sourceRefs: [], isEstimate: false, durationMs: 0 }),
    };
    const result = await createPlan(
      { goal, ctx, domainId: DOMAIN_ID },
      { runtime, now: () => new Date('2026-01-01T00:00:00.000Z') },
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    // `tools` 在契约上是 optional（权威来源是注册表），但 createPlan 必须**真的**填了它——
    // 断言这一点正是本组用例的目的，所以在这里把"缺省"当成失败而不是 `?? []` 糊过去。
    const tools = seen[0]?.tools;
    if (!tools) throw new Error('createPlan 没有把工具清单放进 PlanRequest');
    return { tools };
  }

  it('★★ 请求里带上全部注册工具，且与注册表逐字一致（模型照抄的名字必须能调通）', async () => {
    const { tools } = await captureRequest(
      makeDraft([{ id: 's-1', title: '一步', dependsOn: [] }]),
    );
    expect(tools.map((tool) => tool.name)).toEqual(getToolNames(DOMAIN_ID));
    // 清单要带用途说明，否则模型不知道该在什么时候调它
    expect(tools[0]?.description).toBe('另一个单元测试工具');
  });

  it('★ 顺序按名字字典序，与领域包里的书写顺序解耦', async () => {
    const { tools } = await captureRequest(
      makeDraft([{ id: 's-1', title: '一步', dependsOn: [] }]),
    );
    const names = tools.map((tool) => tool.name);
    // 领域包字面量写的是 another → tool，这里锁定的是"字典序"这个性质本身
    expect(names).toEqual([...names].sort());
    // 确定性：同一注册表反复读取顺序必须一致（否则 prompt 快照类断言会时绿时红）
    expect(getToolNames(DOMAIN_ID)).toEqual(names);
  });

  it('★★ maxAttempts 逐工具取自各自的 stepType（不是写死的同一个数）', () => {
    const briefs = getToolBriefs(DOMAIN_ID);
    // unit.another → heavy(5)、unit.tool → task(2)。若实现恒返回同一个数，此断言变红。
    expect(briefs.map((tool) => [tool.name, tool.maxAttempts])).toEqual([
      ['unit.another', 5],
      ['unit.tool', 2],
    ]);
  });

  it('★ 领域未注册 → 清单为空数组而不是抛错（请求仍要能被组装出来）', () => {
    expect(getToolBriefs('no-such-domain')).toEqual([]);
    expect(getToolNames('no-such-domain')).toEqual([]);
  });

  it('★ maxAttempts 的来源与 buildSteps 的 maxAttemptsFor 必须是同一个值', () => {
    // 两条路径都读 `getStepType(domainId, tool.stepType)?.maxAttempts ?? 2`。
    // 若这里变了而那里没变，模型看到的重试上限就会和内核实际执行的不一样。
    const pack = getDomainPack(DOMAIN_ID);
    for (const tool of getTools(DOMAIN_ID)) {
      const fromBrief = getToolBriefs(DOMAIN_ID).find((b) => b.name === tool.name)?.maxAttempts;
      const fromStepType =
        (tool.stepType ? getStepType(DOMAIN_ID, tool.stepType)?.maxAttempts : undefined) ?? 2;
      expect(fromBrief).toBe(fromStepType);
    }
    expect(pack?.tools['unit.tool']?.stepType).toBe('task');
  });
});

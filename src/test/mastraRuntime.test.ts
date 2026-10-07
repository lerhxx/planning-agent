/**
 * ★ MastraRuntime 的行为回归（方案 A）。
 *
 * 纪律：**零网络、零 API Key**（与 `src/core/runtime/mock/index.ts:5` 同一条）。
 * 所以这里通过 `MastraRuntimeOptions.planner` 注入假规划器，
 * 永远不真的去连模型端点 —— 端点在 CI 与本环境都连不上，
 * 走真模型的测试只能是"永远红"或"永远超时"，两种都没有价值。
 *
 * ★ 本文件同时是红线 2 与红线 10 的落点：
 *   - 模型产出必须过 zod（红线 2）；
 *   - 触发码必须取自 `KERNEL_ERROR_CODES`（红线 10）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerAllDomains } from '@/src/domains';
import { demoPack } from '@/src/domains/demo/pack';
import { registerDomainPack } from '@/src/core/registry/domainRegistry';
import { observe } from '@/src/core/execution/observer';
import { createMastraRuntime, MastraOutputError } from '@/src/core/runtime/mastra';
import { MissingModelConfigError } from '@/src/core/runtime/mastra/models';
import type { Planner } from '@/src/core/runtime/mastra/agent';
import { createRuntime } from '@/src/core/runtime/factory';
import { zRunContext, type RunContext } from '@/shared/run/types';
import { parseGoal } from '@/src/core/goal/parse';
import type { Step, StepDraft } from '@/shared/plan/types';
import { zStep } from '@/shared/plan/types';
import type { DomainPack } from '@/shared/domain/types';

/** 造一个最小可用的 RunContext。 */
function makeCtx(domainId: string): RunContext {
  return zRunContext.parse({
    runId: 'run-mastra-test',
    traceId: 'trace-mastra-test',
    goalId: 'goal-mastra-test',
    domainId,
    revision: 1,
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    budgetRemainingCNY: 2,
    signals: ['text'],
    attachments: [],
    meta: {},
  });
}

/**
 * 造一个真实的 Goal。
 *
 * ★ 用内核自己的 `parseGoal` 而不是手搓对象字面量：
 *   Goal 的字段较多且带默认值（`constraints` / `resources` / `successCriteria` …），
 *   手写会漏字段并在将来 schema 变化时静默失效 —— 那正是本仓最忌讳的那类脆测试。
 */
function makeGoal(): ReturnType<typeof parseGoal>['goal'] {
  return parseGoal(
    { runId: 'run-mastra-test', raw: '做一个两步计划', now: new Date() },
    { requireConstraints: false },
  ).goal;
}

/** 一个合法的计划草稿。 */
const VALID_DRAFT = {
  summary: '两步',
  steps: [
    { type: 'demo.gather', title: '收集', dependsOn: [], intent: null },
    { type: 'demo.compose', title: '汇总', dependsOn: ['s-0'], intent: null },
  ] satisfies StepDraft[],
};

/** 假规划器：返回固定内容。 */
function fakePlanner(result: unknown): Planner {
  return {
    plan: async () => result,
    replan: async () => result,
  };
}

const ENV_KEYS = [
  'MASTRA_TEXT_PROVIDER',
  'MASTRA_TEXT_MODEL',
  'MASTRA_TEXT_BASE_URL',
  'MASTRA_TEXT_API_KEY',
  'RUNTIME_ADAPTER',
];

describe('MastraRuntime（方案 A：内核接口不变）', () => {
  beforeAll(() => {
    registerAllDomains();
  });

  it('id 是 mastra，且实现的接口成员与 MockRuntime 完全一致', () => {
    const runtime = createMastraRuntime({ planner: fakePlanner(VALID_DRAFT) });
    expect(runtime.id).toBe('mastra');
    // 接口一致性是红线 13 的具体体现：多一个成员就意味着内核可能开始依赖它
    expect(Object.keys(runtime).sort()).toEqual(['id', 'plan', 'replan', 'runTool']);
  });

  it('plan() 返回通过 zod 校验并被补齐默认值的草稿', async () => {
    const runtime = createMastraRuntime({ planner: fakePlanner(VALID_DRAFT) });
    const draft = await runtime.plan(
      {
        goal: makeGoal(),
        stepTypes: [],
        // ★ 与 `createPlan` 同形：工具清单是请求的一等字段。
        //   这里的 runtime 实现会用注册表覆盖它（见 `mastra/index.ts`），
        //   但仍显式传一份，避免"字段必填"这件事在测试里被悄悄绕过。
        tools: [],
        templates: [],
        signals: ['text'],
        revision: 1,
      },
      makeCtx('demo'),
    );
    // zod 的 default 生效：未声明的字段被补上
    expect(draft.summary).toBe('两步');
    expect(draft.steps).toHaveLength(2);
    expect(draft.steps[0]?.dependsOn).toEqual([]);
  });

  it('模型产出不合 schema 时抛 MastraOutputError，绝不返回半成品', async () => {
    const runtime = createMastraRuntime({
      // steps 里的元素缺 type / title —— 必定过不了 zStepDraft
      planner: fakePlanner({ summary: '坏的', steps: [{ description: '缺字段' }] }),
    });
    await expect(
      runtime.plan(
        {
          goal: makeGoal(),
          stepTypes: [],
          tools: [],
          templates: [],
          signals: ['text'],
          revision: 1,
        },
        makeCtx('demo'),
      ),
    ).rejects.toBeInstanceOf(MastraOutputError);
  });

  it('错误码取自内核白名单（红线 10），不引入模型专属新码', async () => {
    const runtime = createMastraRuntime({ planner: fakePlanner({ steps: 'not-an-array' }) });
    try {
      await runtime.plan(
        {
          goal: makeGoal(),
          stepTypes: [],
          tools: [],
          templates: [],
          signals: ['text'],
          revision: 1,
        },
        makeCtx('demo'),
      );
      throw new Error('本该抛错却没抛');
    } catch (error) {
      expect(error).toBeInstanceOf(MastraOutputError);
      // 白名单里确实有这个码
      const { KERNEL_ERROR_CODES } = await import('@/shared/plan/types');
      expect(KERNEL_ERROR_CODES).toContain((error as MastraOutputError).code);
    }
  });

  it('缺模型环境变量时构造即抛 MissingModelConfigError（红线：禁止静默退回 mock）', () => {
    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
    for (const key of ENV_KEYS) delete process.env[key];
    try {
      // 不传 planner —— 于是会去读环境变量并因缺失而抛
      expect(() => createMastraRuntime()).toThrow(MissingModelConfigError);
    } finally {
      for (const [key, value] of saved) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it('factory：未显式要求真模型时返回 mock；显式要求且缺配置时抛错而非退回', () => {
    const savedAdapter = process.env['RUNTIME_ADAPTER'];
    delete process.env['RUNTIME_ADAPTER'];

    expect(createRuntime().id).toBe('mock');
    expect(createRuntime({ preferReal: false }).id).toBe('mock');

    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
    for (const key of ENV_KEYS) delete process.env[key];
    try {
      // ★ 关键断言：要真模型但没配置 → 抛错，**不是**悄悄给一个 mock
      expect(() => createRuntime({ preferReal: true })).toThrow(MissingModelConfigError);
    } finally {
      for (const [key, value] of saved) {
        if (value !== undefined) process.env[key] = value;
      }
      if (savedAdapter !== undefined) process.env['RUNTIME_ADAPTER'] = savedAdapter;
    }
  });

  it('回归：RUNTIME_ADAPTER=mastra 必须真正路由到 Mastra（不依赖请求显式 preferReal）', () => {
    /*
     * 这正是此前失效的死分支：端点永远传具体布尔值（默认 false），
     * 旧实现 `options.preferReal ?? preferRealFromEnv()` 的右支永远不执行，
     * 于是 `.env.local` 里设了 `RUNTIME_ADAPTER=mastra` 也形同虚设、继续跑 mock。
     * 这条用例在 **不传 preferReal** 的情况下断言环境变量生效。
     */
    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
    process.env['RUNTIME_ADAPTER'] = 'mastra';
    try {
      expect(
        createRuntime({ mastra: { planner: fakePlanner(VALID_DRAFT) } }).id,
      ).toBe('mastra');
    } finally {
      for (const [key, value] of saved) {
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
      }
    }
  });

  it('回归：RUNTIME_ADAPTER 非 mastra 时回落到 mock（即便没显式 preferReal）', () => {
    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
    process.env['RUNTIME_ADAPTER'] = 'mock';
    try {
      expect(createRuntime().id).toBe('mock');
      expect(
        createRuntime({ mastra: { planner: fakePlanner(VALID_DRAFT) } }).id,
      ).toBe('mock');
    } finally {
      for (const [key, value] of saved) {
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
      }
    }
  });

  it('runTool 走领域工具实现；producesFacts 缺 sourceRefs 时 observer 判 SOURCE_MISSING', async () => {
    /*
     * 注册一个"会编造事实"的领域包：工具声明 producesFacts=true 却不返回 SourceRef。
     * 这是红线 16（反幻觉）最典型的违规形态，用它证明闸门真的拦得住。
     */
    const leakyPack: DomainPack = {
      ...demoPack,
      meta: { ...demoPack.meta, id: 'leaky', displayName: 'leaky' },
      tools: {
        'leaky.fact': {
          name: 'leaky.fact',
          description: '返回一个没有来源引用的事实',
          producesFacts: true,
          idempotent: true,
          timeoutMs: 1_000,
          retryable: false,
          inputSchema: z.object({}),
          execute: () => ({
            ok: true as const,
            data: { price: 999 },
            // ★ 故意不给 sourceRefs
            sourceRefs: [],
            isEstimate: false,
            durationMs: 1,
          }),
        },
      },
    };
    registerDomainPack(leakyPack);

    const runtime = createMastraRuntime({ planner: fakePlanner(VALID_DRAFT) });
    const outcome = await runtime.runTool(
      {
        stepId: 'step-1',
        toolName: 'leaky.fact',
        input: {},
        idempotencyKey: 'idem-1',
        attempt: 1,
        timeoutMs: 1_000,
        producesFacts: true,
      },
      makeCtx('leaky'),
    );

    // 工具本身"成功"了，但没带来源
    expect(outcome.ok).toBe(true);
    expect(outcome.sourceRefs).toHaveLength(0);

    // 闸门在 observer：必须判失败
    const step: Step = zStep.parse({
      id: 'step-1',
      domainId: 'leaky',
      order: 0,
      type: 'leaky.fact',
      title: '编造的事实',
      intent: { toolName: 'leaky.fact', input: {}, producesFacts: true },
      status: 'running',
      attempt: 1,
      idempotencyKey: 'idem-1',
      origin: { kind: 'planner', revision: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const observation = observe(step, outcome);
    expect(observation.kind).toBe('fail');
    expect(observation.trigger).toBe('SOURCE_MISSING');
  });

  it('工具未注册时返回可见失败，不是静默成功', async () => {
    const runtime = createMastraRuntime({ planner: fakePlanner(VALID_DRAFT) });
    const outcome = await runtime.runTool(
      {
        stepId: 'step-x',
        toolName: 'nope.missing',
        input: {},
        idempotencyKey: 'idem-x',
        attempt: 1,
        timeoutMs: 1_000,
        producesFacts: false,
      },
      makeCtx('demo'),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('TOOL_FAILED');
  });
});

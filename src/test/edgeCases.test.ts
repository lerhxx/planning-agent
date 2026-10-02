/**
 * M1 边界用例（e2e）：四个必须被证明的失败/拦截路径。
 *
 * 1. `NO_CONVERGENCE`：重排结果与原计划几乎一致 → 强制转人工
 * 2. `MAX_REPLANS`：重排次数触顶 → 停止自动修复
 * 3. 计划含环 → `PLAN_CYCLE_DETECTED`，绝不死循环
 * 4. 已完成步骤编辑冻结 → `FROZEN_STEP`
 *
 * 外加两条"证明内核真的跑到了领域代码"的用例：
 * 5. 25 步计划只重排 1 步 → **不得**判 NO_CONVERGENCE（收敛判定的比较域是子树）
 * 6. 校验型 Provider 在闭环里真的被执行（createValidator 调用计数）
 */
import { describe, expect, it } from 'vitest';
import { zRunContext, type RunContext } from '@/shared/run/types';
import type { StepDraft } from '@/shared/plan/types';
import type { StreamEvent } from '@/shared/stream/events';
import { runGoal, type EngineInput, type EngineResult } from '@/src/core/run/engine';
import { getDomainPack } from '@/src/core/registry/domainRegistry';
import { createMockRuntime } from '@/src/core/runtime/mock';
import { createDefaultMockScript, type MockScript } from '@/src/core/runtime/mock/script';
import { registerAllDomains } from '@/src/domains';

const [DOMAIN_ID] = registerAllDomains();

const GOAL = '两路采集后汇总成一版结论，预算不超过 500 元，三天内完成';

interface RunOutput {
  result: EngineResult;
  events: StreamEvent[];
}

async function runWith(
  script: MockScript,
  overrides: Partial<EngineInput> = {},
): Promise<RunOutput> {
  const events: StreamEvent[] = [];
  const result = await runGoal(
    { goal: GOAL, simulate: 'none', ...overrides },
    {
      runtime: createMockRuntime({ latencyMs: 0, script }),
      emit: (event) => events.push(event),
      sleep: async () => undefined,
      streamDelayMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    },
  );
  return { result, events };
}

function nodeComponents(events: StreamEvent[]): string[] {
  return events
    .filter((event) => event.type === 'component_start')
    .map((event) => (event.type === 'component_start' ? event.component : ''));
}

function alwaysFail(errorMessage: string): Pick<MockScript, 'tool'> {
  return {
    tool: () => ({
      ok: false,
      sourceRefs: [],
      isEstimate: false,
      durationMs: 0,
      error: { code: 'TOOL_FAILED', message: errorMessage, retryable: false, traceId: '' },
    }),
  };
}

describe('收敛判定：NO_CONVERGENCE 必须可达且可证伪', () => {
  it('★ 重排结果与原计划一致（去掉"换方案"）→ 终态 NO_CONVERGENCE', async () => {
    const events: StreamEvent[] = [];
    const result = await runGoal(
      { goal: GOAL, simulate: 'fatal' },
      {
        // stagnant：脚本化模型"没想出新方案"，原样重发受影响步骤 → delta = 0
        runtime: createMockRuntime({ latencyMs: 0, replanMode: 'stagnant' }),
        emit: (event) => events.push(event),
        sleep: async () => undefined,
        streamDelayMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('NO_CONVERGENCE');
    // 不白屏：ErrorState 必须下发
    expect(nodeComponents(events)).toContain('ErrorState');
    // 没有被误判成"已收敛"：终态事件存在
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('★ 25 步计划只重排 1 步 → 不得判 NO_CONVERGENCE（比较域是受影响子树）', async () => {
    const base = createDefaultMockScript({ replanMode: 'diverge' });
    const steps: StepDraft[] = Array.from({ length: 25 }, (_, index) => ({
      id: `b-${index + 1}`,
      // 最后一步是汇总结论，其余是采集；两者都在 demo 的 stepType 白名单内。
      type: index === 24 ? 'compose' : 'gather',
      title: `步骤 ${index + 1}`,
      dependsOn: index === 0 ? [] : [`b-${index}`],
      intent: {
        toolName: index === 24 ? 'demo.compose' : 'demo.gather',
        input: index === 24 ? {} : { limit: 1 },
        producesFacts: index !== 24,
      },
    }));

    const script: MockScript = {
      plan: () => ({ summary: '25 步线性计划', steps }),
      replan: base.replan,
      // 只让最后一步失败：它的影响面 = 它自己（没有下游），即"25 步里只动 1 步"。
      tool: (call, ctx) =>
        call.stepId === 'b-25'
          ? {
              ok: false,
              sourceRefs: [],
              isEstimate: false,
              durationMs: 0,
              error: { code: 'TOOL_FAILED', message: '注入：最后一步失败', retryable: false, traceId: ctx.traceId },
            }
          : base.tool(call, ctx),
    };

    const { result } = await runWith(script);

    // 确实发生了重规划，且没有被收敛闸门误杀。
    expect(result.plan?.revision).toBeGreaterThanOrEqual(2);
    expect(result.reason).not.toBe('NO_CONVERGENCE');
    expect(result.status).toBe('completed');
    // 只有最后一步被替换，前 24 步保持原 id。
    expect(result.plan?.steps.some((step) => step.id.startsWith('r2-'))).toBe(true);
    expect(result.plan?.steps.filter((step) => step.id.startsWith('b-')).length).toBe(24);
  });
});

describe('闸门：重排次数上限', () => {
  it('每步都失败 → 重排 5 次后 MAX_REPLANS 拦下，不是死循环', async () => {
    const base = createDefaultMockScript({ replanMode: 'diverge' });
    const script: MockScript = {
      plan: base.plan,
      replan: base.replan,
      tool: alwaysFail('注入：每次都失败').tool,
    };

    const { result, events } = await runWith(script);

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('MAX_REPLANS');
    // 5 次成功重排 + 第 6 次尝试被闸门拦下（plan_status 'replanning' 在闸门检查之前下发）。
    const replanning = events.filter((e) => e.type === 'plan_status' && e.status === 'replanning');
    expect(replanning.length).toBeGreaterThanOrEqual(5);
    expect(replanning.length).toBeLessThanOrEqual(6);
    expect(nodeComponents(events)).toContain('ErrorState');
  });
});

describe('计划编译：含环', () => {
  it('依赖成环 → PLAN_CYCLE_DETECTED，绝不死循环', async () => {
    const base = createDefaultMockScript();
    const script: MockScript = {
      plan: () => ({
        summary: '含环计划',
        steps: [
          { id: 'c-1', type: 'compose', title: '第一步', dependsOn: [], intent: null },
          { id: 'c-2', type: 'compose', title: '第二步', dependsOn: ['c-3'], intent: null },
          { id: 'c-3', type: 'compose', title: '第三步', dependsOn: ['c-2'], intent: null },
        ],
      }),
      replan: base.replan,
      tool: base.tool,
    };

    const { result, events } = await runWith(script);

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('PLAN_CYCLE_DETECTED');
    expect(nodeComponents(events)).toContain('ErrorState');
  });
});

describe('用户编辑：已完成步骤默认冻结', () => {
  it('★ 续跑时改已完成步骤 → FROZEN_STEP，计划不被执行', async () => {
    // ① 先跑完一轮，拿到"全部 done"的计划快照。
    const first = await runWith(createDefaultMockScript());
    expect(first.result.status).toBe('completed');
    const snapshot = first.result.plan;
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error('首轮计划为空');

    // ② 直接改一个已完成步骤 → 必须被拒绝（红线 14）。
    const second = await runGoal(
      {
        goal: GOAL,
        simulate: 'none',
        resumePlan: snapshot,
        edit: { kind: 'editStep', stepId: snapshot.steps[0].id, patch: { title: '改个标题' } },
      },
      {
        runtime: createMockRuntime({ latencyMs: 0 }),
        emit: () => undefined,
        sleep: async () => undefined,
        streamDelayMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      },
    );

    expect(second.status).toBe('failed');
    expect(second.reason).toBe('FROZEN_STEP');

    // ③ 显式 retryStep 解冻后，同一个编辑就能生效（证明拒绝不是"编辑功能没接"）。
    const third = await runGoal(
      {
        goal: GOAL,
        simulate: 'none',
        resumePlan: snapshot,
        edit: { kind: 'retryStep', stepId: snapshot.steps[0].id },
      },
      {
        runtime: createMockRuntime({ latencyMs: 0 }),
        emit: () => undefined,
        sleep: async () => undefined,
        streamDelayMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      },
    );

    expect(third.status).toBe('completed');
    // 被解冻的步骤重新执行过（attempt 归零后至少跑了一次）
    expect(third.plan?.steps.find((step) => step.id === snapshot.steps[0].id)?.status).toBe('done');
  });
});

describe('校验型 Provider 真的接进了闭环', () => {
  it('★ 跑一轮闭环 → 领域的 createValidator 至少被调用一次', async () => {
    const pack = getDomainPack(DOMAIN_ID);
    expect(pack).toBeDefined();
    if (!pack) throw new Error('领域包未注册');

    const original = pack.providers.createValidator;
    let calls = 0;
    pack.providers.createValidator = (ctx) => {
      calls += 1;
      return original?.(ctx);
    };

    try {
      const { result } = await runWith(createDefaultMockScript());
      expect(result.status).toBe('completed');
      // 计划生成后 + 每次重排后都会校验；正常路径至少 1 次。
      expect(calls).toBeGreaterThanOrEqual(1);
    } finally {
      pack.providers.createValidator = original;
    }
  });

  it('★ 计划不合法 → 校验拦下，一步都不执行，且转人工（不是"跑完了才发现错"）', async () => {
    const base = createDefaultMockScript({ replanMode: 'diverge' });
    // 采集步骤不绑定工具 → demo 的校验规则判定为 error（内核只看 ok/severity）。
    const script: MockScript = {
      plan: () => ({
        summary: '不合法计划',
        steps: [{ id: 'x-1', type: 'gather', title: '无工具的采集步骤', dependsOn: [], intent: null }],
      }),
      replan: base.replan,
      tool: base.tool,
    };

    const { result, events } = await runWith(script);

    // 先重排一次，重排后仍不合法 → 转人工（不无限重排、也不静默失败）
    expect(result.status).toBe('awaiting_user');
    expect(result.reason).toBe('VALIDATION_ASK_USER');
    expect(nodeComponents(events)).toContain('ClarifyOptions');
    // 没有任何一步进入 done：校验没通过就不该执行。
    expect(result.plan?.steps.every((step) => step.status !== 'done')).toBe(true);
  });

  it('RunContext 可被 zod 完整校验（跨端纯数据契约）', () => {
    const parsed = zRunContext.safeParse({
      runId: 'run-1',
      traceId: 'trace-1',
      goalId: 'goal-1',
      domainId: DOMAIN_ID,
      startedAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2026-01-01T00:00:25.000Z',
    });
    expect(parsed.success).toBe(true);
    const ctx: RunContext | undefined = parsed.success ? parsed.data : undefined;
    expect(ctx?.budgetRemainingCNY).toBe(2);
    expect(ctx?.revision).toBe(1);
  });
});

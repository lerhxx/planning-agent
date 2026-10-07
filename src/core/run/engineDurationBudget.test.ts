/**
 * 时长预算的起算点：**计划就绪**，而不是整轮开始。
 *
 * ★ 为什么要专门测这个：真模型的首次 `createPlan` 本身就要 10–30s，若
 * `DEFAULT_GATE_CONFIG.maxDurationMs`（现90_000）从整轮开始起算，等计划回来时预算
 * 可能已经被规划吃光—— 任何一次校验失败都必然以 `MAX_DURATION` 收场，
 * 自动修复事实上已经死了。
 *
 * ★ 本文件用**假时钟**精确模拟"规划花了 100 秒、之后时间静止"，不真的等待。
 * `runGoal(input, deps)` 的 `deps.now` / `deps.sleep` 都是注入点，因此：
 * 推进时钟的唯一手段是"在某个被引擎调用的回调里推进"，本文件用两处：
 *  1. `runtime.plan()` —— 模拟真模型首次规划的真实耗时（这是**唯一**合理的注入点：
   *     规划耗时必须发生在 `planReadyMs` 之前，否则测的就不是"规划挤掉预算"这件事）；
 *  2. `emit()` 收到 `step_add` 时 —— 该事件在计划就绪之后、执行之前下发，
 *用来模拟"计划就绪之后又跑了一会儿"。
 *
 * 引擎不导出 `ctx`，但 `RuntimeAdapter.replan(request, ctx)` 会拿到它，
 * 因此 `ctx.deadlineAt` / `ctx.startedAt` 可以**如实**观测，无需改生产代码的可观测性。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_DEGRADE_CHAIN, type DomainPack } from '@/shared/domain/types';
import type { RunContext } from '@/shared/run/types';
import type { StreamEvent } from '@/shared/stream/events';
import { runGoal, type EngineResult } from '@/src/core/run/engine';
import {
  clearDomainPacks,
  registerDomainPack,
} from '@/src/core/registry/domainRegistry';
import {
  DEFAULT_GATE_CONFIG,
  type GateReason,
} from '@/src/core/replan/gates';
import type {
  PlanDraft,
  PlanRequest,
  ReplanRequest,
  RuntimeAdapter,
  ToolCall,
  ToolOutcome,
} from '@/src/core/runtime/adapter';

const DOMAIN_ID = 'budgettest';
const STEP_TYPE = 'alpha';
const START_ISO = '2026-01-01T00:00:00.000Z';
const START_MS = new Date(START_ISO).getTime();

/**
 * 真模型首次规划的典型耗时。
 *
 * ★ 刻意取 100s（**超过**当前 90s 的闸门），而不是真实的 10–30s：本文件要证明的是
 *   "规划耗时被排除在时长预算之外"（起算点= 计划就绪）。只有当规划耗时**独自就超过**
 *   闸门上限时，"重排没有被 MAX_DURATION 拒掉"才真正证明起算点换对了 —— 若规划只花
 *   40s，即便起算点仍写成整轮开始，这条也会侥幸通过，变成空转的断言。
 */
const PLANNING_COST_MS = 100_000;

/** 假时钟：只在被显式推进时前进，其余时刻完全静止。 */
interface FakeClock {
  now: () => Date;
  advance(ms: number): void;
  currentMs(): number;
}

function createFakeClock(startIso: string = START_ISO): FakeClock {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number): void {
      current += ms;
    },
    currentMs: () => current,
  };
}

/**
 * 测试领域包：只有一个纯推理步骤（`intent: null`，执行时直接完成，不调工具）。
 *
 * ★ 校验结果由 `failing` 开关控制：开关为 true 时`validateStep` 报error，
 * 于是引擎走"校验不通过 → 让 Agent 重排"这条主路径；`runtime.replan()` 被调用时
 * 把开关翻成 false —— 模拟"重排产出的新计划是合法的"。
 */
interface TestDomain {
  pack: DomainPack;
  /** 重排发生时自动翻成false（由 `runtime.replan()` 驱动）。 */
  setFailing(value: boolean): void;
  /** 校验被调用过几次（用于确认确实走进了校验分支）。 */
  validateCalls(): number;
}

function createTestDomain(): TestDomain {
  let failing = true;
  let validateCalls = 0;

  const pack: DomainPack = {
    meta: {
      id: DOMAIN_ID,
      displayName: 'Budget Test',
      version: '1.0.0',
      schemaVersion: 1,
      description: '时长预算起算点测试用的最小领域包',
      matcher: { keywords: [], patterns: [], negativeKeywords: [], scoreBySignals: {} },
      requiredSignals: [],
      capabilities: { vision: false, geo: false, providers: false, timeSequence: false },
    },
    tools: {},
    providers: {
      namespace: DOMAIN_ID,
      create: () => ({}),
    },
    ui: { components: [], degradeChain: CORE_DEGRADE_CHAIN, stepRenderers: {} },
    prompts: {
      worldview: 'w',
      constraints: 'c',
      antiHallucination: '不得编造事实',
      planning: '',
    },
    planning: {
      stepTypes: [{ type: STEP_TYPE, label: '待办步骤', description: '', maxAttempts: 2 }],
      templates: [],
      validateStep(step) {
        validateCalls += 1;
        if (!failing) return { ok: true, violations: [] };
        // 故意无视 step 内容：只要开关是 true 就报错，稳定复现"校验不通过"主路径。
        return step.type === STEP_TYPE
          ? { ok: false, violations: [{ severity: 'error' as const }] }
          : { ok: true, violations: [] };
      },
    },
    evaluation: { cases: [], metricIds: [] },
  };

  return {
    pack,
    setFailing: (value: boolean) => {
      failing = value;
    },
    validateCalls: () => validateCalls,
  };
}

interface Harness {
  clock: FakeClock;
  domain: TestDomain;
  events: StreamEvent[];
  /** `runtime.replan` 收到的 ctx —— 引擎对外暴露 ctx 的唯一现成通道。 */
  observedCtx: () => RunContext | null;
  replanCalls: () => number;
  run(overrides?: { advanceAfterPlanReadyMs?: number }): Promise<EngineResult>;
}

function createHarness(options: { initialPlanValid: boolean }): Harness {
  const clock = createFakeClock();
  const domain = createTestDomain();
  domain.setFailing(!options.initialPlanValid);

  const events: StreamEvent[] = [];
  let seenCtx: RunContext | null = null;
  let replanCalls = 0;

  const runtime: RuntimeAdapter = {
    id: 'budget-test-runtime',
    async plan(_request: PlanRequest, _ctx: RunContext): Promise<PlanDraft> {
      // 真模型首次规划的真实耗时：必须在计划就绪之前发生。
      clock.advance(PLANNING_COST_MS);
      return {
        summary: '首版计划',
        steps: [{ id: 's-1', type: STEP_TYPE, title: '首版步骤', dependsOn: [], intent: null }],
      };
    },
    async replan(_request: ReplanRequest, ctx: RunContext): Promise<PlanDraft> {
      replanCalls += 1;
      seenCtx = ctx;
      // 重排产出的计划是合法的：翻开关，让引擎的"重排后复校验"通过。
      domain.setFailing(false);
      return {
        summary: '重排计划',
        steps: [
          { id: 'r2-1', type: STEP_TYPE, title: '重排后的步骤', dependsOn: [], intent: null },
        ],
      };
    },
    async runTool(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      // 本测试的步骤都是纯推理步骤（`intent: null`），不会走到这里。
      throw new Error(`不应调用工具：${call.toolName} / ${ctx.traceId}`);
    },
  };

  return {
    clock,
    domain,
    events,
    observedCtx: () => seenCtx,
    replanCalls: () => replanCalls,
    async run(overrides = {}): Promise<EngineResult> {
      const advanceAfterPlanReadyMs = overrides.advanceAfterPlanReadyMs ?? 0;
      return runGoal(
        { goal: '把两路数据汇总成一版结论，预算不超过 500 元，三天内完成', domainId: DOMAIN_ID },
        {
          runtime,
          emit: (event) => {
            events.push(event);
            // `step_add` 在计划就绪之后、执行之前下发 —— 用它模拟"就绪后又跑了一会儿"。
            if (advanceAfterPlanReadyMs > 0 && event.type === 'step_add') {
              clock.advance(advanceAfterPlanReadyMs);
            }
          },
          sleep: async () => undefined,
          streamDelayMs: 0,
          now: clock.now,
        },
      );
    },
  };
}

/** 从事件流里取出终态 reason。 */
function terminalReason(events: StreamEvent[]): GateReason | string | undefined {
  const last = [...events].reverse().find((event) => event.type === 'done');
  return last && last.type === 'done' ? last.reason : undefined;
}

describe('时长预算从计划就绪起算', () => {
  beforeEach(() => {
    clearDomainPacks();
  });

  afterAll(() => {
    clearDomainPacks();
  });

  it('★ 规划耗掉 100s（超过闸门上限）之后触发重排，不会被 MAX_DURATION 拒掉', async () => {
    const harness = createHarness({ initialPlanValid: false });
    const registered = registerDomainPack(harness.domain.pack);
    expect(registered.ok).toBe(true);

    const result = await harness.run();

    // 前提：这一轮真的先规划了 100s（假时钟已越过 90s 闸门长度）。
    expect(harness.clock.currentMs() - START_MS).toBe(PLANNING_COST_MS);
    // 前提：真的走进了"校验不通过 → 重排"这条主路径（否则断言会空转）。
    expect(harness.domain.validateCalls()).toBeGreaterThan(0);
    expect(harness.replanCalls()).toBe(1);

    // ★ 核心断言：自动修复没有被时长闸门打死。
    expect(terminalReason(harness.events)).not.toBe('MAX_DURATION');
    expect(result.status).toBe('completed');
    expect(result.plan?.revision).toBe(2);
    expect(
      harness.events.some(
        (event) => event.type === 'error' && event.message.includes('MAX_DURATION'),
      ),
    ).toBe(false);
  });

  it('计划就绪之后再超上限（>90s），执行循环仍然以 MAX_DURATION 失败', async () => {
    const harness = createHarness({ initialPlanValid: true });
    const registered = registerDomainPack(harness.domain.pack);
    expect(registered.ok).toBe(true);

    // 取「上限 +1ms」而不是某个魔数：与闸门上限保持联动，改预算时这条依然有效。
    const result = await harness.run({
      advanceAfterPlanReadyMs: DEFAULT_GATE_CONFIG.maxDurationMs + 1,
    });

    // 闸门没被改成摆设：计划就绪之后超预算，一样拦下来。
    expect(result.status).toBe('failed');
    expect(terminalReason(harness.events)).toBe('MAX_DURATION');
    const failure = harness.events.find((event) => event.type === 'error');
    expect(failure && failure.type === 'error' ? failure.message : '').not.toBe('');
  });

  it('★ ctx.deadlineAt 不再是"已经过去的时刻"，而 startedAt 仍是真实整轮起点', async () => {
    const harness = createHarness({ initialPlanValid: false });
    const registered = registerDomainPack(harness.domain.pack);
    expect(registered.ok).toBe(true);

    await harness.run();

    const ctx = harness.observedCtx();
    expect(ctx).not.toBeNull();
    if (!ctx) return;

    // 计划就绪时刻 = 整轮开始 + 规划耗时（假时钟只在 plan() 里推进过）。
    const planReadyMs = START_MS + PLANNING_COST_MS;
    const expectedDeadlineMs = planReadyMs + DEFAULT_GATE_CONFIG.maxDurationMs;
    expect(ctx.deadlineAt).toBe(new Date(expectedDeadlineMs).toISOString());

    // 不是"已经过去"：重排被调用时deadline 还在未来。
    // （旧口径算出来的 deadline 会是 START+maxDurationMs，即计划就绪前 10s —— 已过期。）
    expect(new Date(ctx.deadlineAt).getTime()).toBeGreaterThan(harness.clock.currentMs());

    // `startedAt` 仍记录真实起点：闸门改口径不等于篡改事实。
    expect(ctx.startedAt).toBe(START_ISO);
  });
});
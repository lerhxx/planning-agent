/**
 * ★ 回归测试：重排的**事后**判定不再复查预算闸门。
 *
 * ## 复现的故障（真模型路径）
 *
 * ```
 * [copilotkit] agent erroragent_run_error_event {runtimeErrorCode:'FATAL'}
 * Error: 重规划被闸门拦截：MAX_DURATION
 * ```
 *
 * 根因在 `doReplan` 的时序：从起飞前的 `checkGates` 走到收敛判定，中间只隔了一次
 * `runtime.replan()` —— 真模型这一次调用就要 10–30s，而当时的 `maxDurationMs` 被定成了
 * 25s（mock 脚本时代的预算）。于是候选计划**刚算好**就被"自己花了时间"打回，
 * 自动修复事实上必然失效。闸门预算现已上调（见 `gates.ts`），但下面这条不变量
 * 与具体数值无关，必须继续成立：**干活花了时间本身不构成丢弃正确结果的理由**。
 *
 * ★ 那两次判定之间 `budget` 一个字段都没被改过（唯一的自增在判定之后），所以旧实现
 *   里那一行事后检查与起飞前那次**逐字等价**、结果必然一致 —— 它只可能因为 `nowMs`
 *   变了而翻转结论，翻译过来就是"因为干活花了时间而丢弃正确结果"。
 *
 * ## 本文件锁住的语义
 *
 * 1. `runtime.replan()` 把假时钟推进到**远超** `maxDurationMs` 之后，这一轮重排
 *    **必须被接受**：`applyReplanOutcome` 生效（版本前进、进入 `running`、新步骤入计划）。
 * 2. 反向锁：同样的超预算条件下，**事前**闸门仍然拦得住（引擎不会无限开新一轮）——
 *    已由 `engineDurationBudget.test.ts`「计划就绪之后再超上限」覆盖，本文件不重复。
 *
 * ## 为什么用假时钟、为什么注入点选在 `runtime.replan()`
 *
 * 引擎的 `deps.now` / `deps.sleep` 都是注入点，推进时钟的唯一手段是"在某个被引擎
 * 调用的回调里推进"。选 `runtime.replan()` 是因为要模拟的正是"模型调用本身耗时很长"，
 * 而这段耗时必须发生在起飞前检查**之后**、事后判定**之前** —— 否则测到的不是本次故障。
 *
 * ## 走的是哪条重排路径
 *
 * 执行循环里 `failedSteps.length > 0` 那条（`trigger: 'FATAL_ERROR'`），因为它才是
 * 用户实际撞到的那条；校验失败那条的重排发生在执行之前，复现不出"执行途中把预算顶穿"。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_DEGRADE_CHAIN, type DomainPack, type ToolSpec } from '@/shared/domain/types';
import type { StreamEvent } from '@/shared/stream/events';
import { runGoal, type EngineResult } from '@/src/core/run/engine';
import { clearDomainPacks, registerDomainPack } from '@/src/core/registry/domainRegistry';
import { DEFAULT_GATE_CONFIG } from '@/src/core/replan/gates';
import type {
  PlanDraft,
  PlanRequest,
  ReplanRequest,
  RuntimeAdapter,
  ToolCall,
  ToolOutcome,
} from '@/src/core/runtime/adapter';

const DOMAIN_ID = 'replanbudgettest';
const STEP_TYPE = 'alpha';
const TOOL_NAME = 'alpha.probe';
const START_ISO = '2026-01-01T00:00:00.000Z';

/**
 * 注入的重排耗时：**刻意超过** `DEFAULT_GATE_CONFIG.maxDurationMs`（现 90s）。
 *
 * ★ 取 100s 而不是真实模型的 10–30s，是为了让"时钟确实被顶过上限"成为可断言的前提
 *   （见下面 `expect(REPLAN_COST_MS).toBeGreaterThan(...)`）。本用例证明的是
 *   **不变量**—— 事后判定不复查预算 —— 而不是某个具体预算数值；换成真实模型的
 *   10–30s 后这条断言就变成了空转（那时根本没超预算，拦不拦都无所谓）。
 */
const REPLAN_COST_MS = 100_000;

/** 假时钟：只在被显式推进时前进，其余时刻完全静止。 */
interface FakeClock {
  now: () => Date;
  advance(ms: number): void;
}

function createFakeClock(startIso: string = START_ISO): FakeClock {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance(ms: number): void {
      current += ms;
    },
  };
}

/**
 * 最小测试领域包：一个会**失败**的步骤（从而触发执行循环里的 `FATAL_ERROR` 重排）。
 *
 * 工具固定返回不可重试失败（`retryable: false`）→ `observe()` 判 `fail`
 * → 步骤进入 `failed` → 汇聚成一次重排（`trigger: 'FATAL_ERROR'`）。
 * 校验一律通过：本文件要测的是重排判定，不是校验。
 */
function createTestDomain(): DomainPack {
  const tool: ToolSpec<never, unknown> = {
    name: TOOL_NAME,
    description: '固定失败的探针工具，用来触发重排',
    producesFacts: false,
    idempotent: false,
    timeoutMs: 1_000,
    retryable: false,
    inputSchema: z.object({}),
    execute: () => ({
      ok: false,
      sourceRefs: [],
      isEstimate: false,
      durationMs: 0,
      error: {
        code: 'TOOL_FAILED' as const,
        message: '注入：这一步总是失败',
        retryable: false,
        traceId: '',
      },
    }),
  };

  return {
    meta: {
      id: DOMAIN_ID,
      displayName: 'Replan Budget Test',
      version: '1.0.0',
      schemaVersion: 1,
      description: '重排事后判定不得复查预算闸门的回归测试用领域包',
      matcher: { keywords: [], patterns: [], negativeKeywords: [], scoreBySignals: {} },
      requiredSignals: [],
      capabilities: { vision: false, geo: false, providers: false, timeSequence: false },
    },
    tools: { [TOOL_NAME]: tool },
    providers: { namespace: DOMAIN_ID, create: () => ({}) },
    ui: { components: [], degradeChain: CORE_DEGRADE_CHAIN, stepRenderers: {} },
    prompts: {
      worldview: 'w',
      constraints: 'c',
      antiHallucination: '不得编造事实',
      planning: '',
    },
    planning: {
      stepTypes: [{ type: STEP_TYPE, label: '待办步骤', description: '', maxAttempts: 1 }],
      templates: [],
      validateStep: () => ({ ok: true, violations: [] }),
    },
    evaluation: { cases: [], metricIds: [] },
  };
}

/** 重排行为：换方案（delta=1，通过收敛判定）vs 原地打转（delta=0，被NO_CONVERGENCE 拦）。 */
type ReplanMode = 'diverge' | 'stagnant';

interface Harness {
  events: StreamEvent[];
  replanCalls: () => number;
  lastReplanRequest: () => ReplanRequest | null;
  run(): Promise<EngineResult>;
}

function createHarness(options: { replanCostMs: number; mode: ReplanMode }): Harness {
  const clock = createFakeClock();
  const events: StreamEvent[] = [];
  let replanCalls = 0;
  let lastReplanRequest: ReplanRequest | null = null;

  const runtime: RuntimeAdapter = {
    id: 'replan-budget-test-runtime',
    async plan(_request: PlanRequest): Promise<PlanDraft> {
      return {
        summary: '首版计划',
        steps: [
          {
            id: 's-1',
            type: STEP_TYPE,
            title: '首版步骤',
            dependsOn: [],
            intent: { toolName: TOOL_NAME, input: {}, producesFacts: false },
          },
        ],
      };
    },
    async replan(request: ReplanRequest): Promise<PlanDraft> {
      replanCalls += 1;
      lastReplanRequest = request;
      // ★ 关键注入点：模型调用本身耗时超过时长闸门（100s > 90s）。
      // 这段时间正好落在"起飞前 checkGates"与"事后收敛判定"之间。
      clock.advance(options.replanCostMs);
      return {
        summary: '重排计划',
        steps: [
          {
            id: 'r2-1',
            type: STEP_TYPE,
            // diverge：换个标题 → 子树 delta = 1 → 判定为已收敛。
            // stagnant：标题与被替换步骤相同 → delta = 0 → 判定为原地打转。
            title: options.mode === 'diverge' ? '重排后的新写法' : '首版步骤',
            dependsOn: [],
            intent: null,
          },
        ],
      };
    },
    async runTool(_call: ToolCall): Promise<ToolOutcome> {
      // 与 `tool.execute` 同语义：不可重试失败 → 步骤 `failed` → 触发 FATAL_ERROR 重排。
      return {
        ok: false,
        sourceRefs: [],
        isEstimate: false,
        durationMs: 0,
        error: {
          code: 'TOOL_FAILED',
          message: '注入：这一步总是失败',
          retryable: false,
          traceId: '',
        },
      };
    },
  };

  return {
    events,
    replanCalls: () => replanCalls,
    lastReplanRequest: () => lastReplanRequest,
    run: () =>
      runGoal(
        { goal: '把两路数据汇总成一版结论，预算不超过 500 元，三天内完成', domainId: DOMAIN_ID },
        {
          runtime,
          emit: (event) => events.push(event),
          sleep: async () => undefined,
          streamDelayMs: 0,
          now: clock.now,
        },
      ),
  };
}

/** 错误事件的文案（`failRun` 的 message 原文）。 */
function errorMessage(events: StreamEvent[]): string {
  const failure = events.find((event) => event.type === 'error');
  return failure && failure.type === 'error' ? failure.message : '';
}

/**
 * `applyReplanOutcome` 是否真的生效了。
 *
 * ★ 这是"重排被接受"的**唯一**可靠证据：重排一旦被拒（无论是闸门还是收敛），
 *   `applyReplanOutcome` 就不会被调用，计划版本不会前进、新步骤不会入计划。
 *   只看终态 reason 是不够的 —— 重排被接受之后，执行循环自己的**事前**时长闸门
 *   仍可能因为预算真的用完而叫停整轮，那是正确的行为，与"重排被丢弃"是两回事。
 */
function replanWasApplied(events: StreamEvent[]): boolean {
  const cancelledOldStep = events.some(
    (event) =>
      event.type === 'step_status' &&
      event.stepId === 's-1' &&
      event.status === 'cancelled' &&
      event.reason === 'REPLAN',
  );
  const newStepAdded = events.some(
    (event) => event.type === 'step_add' && event.step.id === 'r2-1',
  );
  const runningAtRevision2 = events.some(
    (event) => event.type === 'plan_status' && event.status === 'running' && event.revision === 2,
  );
  return cancelledOldStep && newStepAdded && runningAtRevision2;
}

describe('重排的事后判定不再复查预算闸门', () => {
  beforeEach(() => {
    clearDomainPacks();
  });

  afterAll(() => {
    clearDomainPacks();
  });

  it('★ 重排耗时把时钟推过 maxDurationMs，该轮重排仍被接受（applyReplanOutcome 生效）', async () => {
    const harness = createHarness({ replanCostMs: REPLAN_COST_MS, mode: 'diverge' });
    const registered = registerDomainPack(createTestDomain());
    expect(registered.ok).toBe(true);

    const result = await harness.run();

    // 前提：确实走进了"步骤失败 → FATAL_ERROR 重排"这条主路径。
    expect(harness.replanCalls()).toBe(1);
    expect(harness.lastReplanRequest()?.trigger).toBe('FATAL_ERROR');
    // 前提：模型调用确实把时钟顶过了时长上限（否则本用例什么也没证明）。
    expect(REPLAN_COST_MS).toBeGreaterThan(DEFAULT_GATE_CONFIG.maxDurationMs);

    // ★ 核心断言：重排被**接受**并已生效 —— 计划版本前进、新步骤入计划、进入 running。
    expect(replanWasApplied(harness.events)).toBe(true);
    expect(result.plan?.revision).toBe(2);
    expect(result.plan?.steps.some((step) => step.id === 'r2-1')).toBe(true);

    // ★ 反证：失败文案绝不能是"重排被闸门拦截 / 原地打转"这两条重排拒绝路径。
    // 重排被接受之后，执行循环自己的**事前**时长闸门仍可能叫停整轮（预算确实用完了），
    // 那条文案是"本轮时长已达上限" —— 它证明的是"事前闸门还在"，恰恰是想要的行为。
    const message = errorMessage(harness.events);
    expect(message).not.toContain('闸门拦截');
    expect(message).not.toContain('原地打转');
  });

  it('★ 对照组：重排不耗时（时钟静止）时，同一条路径跑通整轮', async () => {
    // 证明上一条失败/叫停确实来自"时钟被推过预算"，而不是本harness 本身跑不通。
    const harness = createHarness({ replanCostMs: 0, mode: 'diverge' });
    const registered = registerDomainPack(createTestDomain());
    expect(registered.ok).toBe(true);

    const result = await harness.run();

    expect(harness.replanCalls()).toBe(1);
    expect(replanWasApplied(harness.events)).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.plan?.revision).toBe(2);
    // 没有耗尽预算 → 整轮没有任何 error 事件。
    expect(harness.events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('★ 收敛判定仍然是活的：重排原地打转（delta=0）依旧被 NO_CONVERGENCE 拦下', async () => {
    // 反向锁：本次改动**只**摘掉了事后复查预算，没有顺手把收敛判定也放跑。
    const harness = createHarness({ replanCostMs: 0, mode: 'stagnant' });
    const registered = registerDomainPack(createTestDomain());
    expect(registered.ok).toBe(true);

    const result = await harness.run();

    expect(harness.replanCalls()).toBe(1);
    expect(result.reason).toBe('NO_CONVERGENCE');
    // 收敛判定拦下 → `applyReplanOutcome` 不生效 → 计划版本没前进。
    expect(replanWasApplied(harness.events)).toBe(false);
    expect(result.plan?.revision).toBe(1);
  });

  it('★ 失败可诊断：文案里带触发码与被替换的步骤 id', async () => {
    const harness = createHarness({ replanCostMs: 0, mode: 'stagnant' });
    const registered = registerDomainPack(createTestDomain());
    expect(registered.ok).toBe(true);

    await harness.run();

    // 这轮排查绕了这么多层，就是因为错误一路不带上下文：只看得见"被闸门拦截"，
    // 看不见"是哪一步失败、因为什么才触发的重排"。这里把两样都钉住。
    const message = errorMessage(harness.events);
    expect(message).toContain('触发=FATAL_ERROR');
    expect(message).toContain('s-1');
  });
});

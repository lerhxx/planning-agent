/**
 * ★ 回归测试：失败步骤**各自的原因**要出现在面向用户的错误信息里。
 *
 * ## 为什么需要这个文件
 *
 * 可观测性缺口连续三轮阻碍排查，报错只说"哪些步骤失败了"、不说"为什么失败"：
 * - 第 4 轮：`MAX_REPLANS（受影响步骤=… 共 4 个）` —— 知道四个步骤全失败，不知道原因；
 * - 第 6、7 轮：`MAX_REVERGENCE`（触发=FATAL_ERROR，受影响步骤=… 共 4 个）—— 同形。
 *
 * 真实原因（工具入参不匹配）**从来没有出现在任何一条用户可见信息里**。
 * 触发码与步骤 id 是先补上的（它们直接让下一个缺陷暴露了出来），本文件锁的是最后一块：
 * 每个受影响步骤**各自的失败原因**。
 *
 * ## 锁住的语义
 *
 * 1. 多个步骤失败、**各有不同原因** ⇒ 文案里能看到这些**不同**的原因（不是只出现一句"全失败"）；
 * 2. 步骤数超上限 ⇒ **只列前 N个**并带"等共 N 个"的总数（不把整屏刷满）；
 * 3. 某步骤**没有**可用原因文本 ⇒ 显式占位（`原因未知`/`未执行`），**不静默省略**；
 * 4. ★ 内容不泄漏：渲染出的文案**不含**模型原文 / 用户输入 / `error.detail` 里的任何片段。
 *
 * ## 第4 条为什么必须锁（而不是"顺便看看"）
 *
 * `Step.error.message` 的来源不受内核约束：`executor.ts` 的兜底 catch 直接透传
 * `error instanceof Error ? error.message`，`AgentError.detail` 里还躺着
 * `planner.ts` 有意回传给模型的 `toolName` 与 `allowedToolNames`。
 * 一旦有人为了"让原因更具体"改成直接展示 `message`（或截断展示），用户输入就会
 * 被铺到 UI 上，而这类改动**没有任何类型或lint 会拦**。所以它需要一条守门测试。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_DEGRADE_CHAIN, type DomainPack, type ToolSpec } from '@/shared/domain/types';
import type { StreamEvent } from '@/shared/stream/events';
import { runGoal } from '@/src/core/run/engine';
import { clearDomainPacks, registerDomainPack } from '@/src/core/registry/domainRegistry';
import type {
  PlanDraft,
  PlanRequest,
  ReplanRequest,
  RuntimeAdapter,
  ToolCall,
  ToolOutcome,
} from '@/src/core/runtime/adapter';

const DOMAIN_ID = 'failurediagnosistest';
const STEP_TYPE = 'alpha';
const TOOL_NAME = 'probe.run';

/**
 * ★ 哨兵值：出现在**只有模型 / 用户才知道**的位置（工具入参、错误消息原文、
 *   `error.detail`）。断言它一次都不许出现在渲染文案里。
 *
 * ## 为什么它必须**短**（这是实测踩到的坑，不是理论担忧）
 *
 * 守门测试的第一版哨兵是 `SENTINEL-用户私密输入-8f3a2b`（22 字符）。注入"透传
 * `error.message`"的负控时，这条断言**居然是绿的** —— 因为渲染出口有 24 字符的
 * 截断，哨兵正好被切成 `SENTINEL-用户私密输入-8f…`，`toContain(完整哨兵)` 匹配不到。
 *
 * 也就是说：**一条"截断式泄漏"能让守门测试变绿**。哨兵必须短到**任何截断都藏不住**
 * （本例 13 字符 < 24 字符上限），否则这道门形同虚设。而`detail` 里的那个哨兵
 * 刻意放在**值**里（`{ sentinel: SENTINEL }`），防止有人只检查顶层字段。
 *
 * 选了一串中英混合的随机字符：中文能顺带暴露"领域词断言被顺手加进文案"这类问题，
 * 而 `SENTINEL` 前缀让失败时的输出一眼可辨。
 */
const SENTINEL = 'SENTINEL8f3a2b';

/** 诊断尾巴最多列出的步骤个数（与 `engine.ts` 的 `MAX_DIAGNOSTIC_IDS` 对齐）。 */
const MAX_DIAGNOSTIC_IDS = 5;

/** 每条失败步骤的失败原因配置：步骤 id → 该步骤要注入的 `error`。 */
type ReasonSpec = { code: string; message: string; detail?: unknown };

/**
 * 最小测试领域包：所有步骤共用一个注册工具，**失败原因由 runtime 按步骤 id 注入**。
 *
 * ★ 为什么不按步骤注册不同工具：原因与工具实现无关，注入点放在 `runtime.runTool`
 *   才能把"步骤 → 原因"这层映射表达清楚（注册多个工具只会让测试多一堆噪音）。
 */
function createTestDomain(): DomainPack {
  const tool: ToolSpec<never, unknown> = {
    name: TOOL_NAME,
    description: '按注入的失败原因失败的探针工具',
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
      error: { code: 'TOOL_FAILED' as const, message: '注入失败', retryable: false },
    }),
  };

  return {
    meta: {
      id: DOMAIN_ID,
      displayName: 'Failure Diagnosis Test',
      version: '1.0.0',
      schemaVersion: 1,
      description: '失败步骤原因可见性测试用的最小领域包',
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
      // 校验一律通过：本文件要测的是失败原因的可见性，不是校验。
      validateStep: () => ({ ok: true, violations: [] }),
    },
    evaluation: { cases: [], metricIds: [] },
  };
}

interface Harness {
  events: StreamEvent[];
  run(): Promise<void>;
}

/**
 * 造一个"n 个步骤在同一批次里各按自己的原因失败 → 汇聚成一次重排 → 重排原地打转
 * → `NO_CONVERGENCE`"的运行。
 *
 * ★ 为什么用"原地打转"作为失败出口：它是**确定性**的（delta=0 必被收敛判定拦下），
 *   不依赖预算与耗时，因此本文件的断言不会因为机器快慢而飘。
 *   重排被拒 ⇒ 错误信息必然带上诊断尾巴 —— 而诊断尾巴正是本文件的被测对象。
 *
 * ★ 为什么所有步骤都不带 `dependsOn`：compilePlan 会把它们放进**同一批次**，
 *   于是 `failedSteps` 一次汇聚全部失败步骤（正是第 4/6/7 轮遇到的形状）。
 */
function createHarness(options: { stepIds: string[]; reasons: Record<string, ReasonSpec> }): Harness {
  const events: StreamEvent[] = [];

  const runtime: RuntimeAdapter = {
    id: 'failure-diagnosis-test-runtime',
    async plan(_request: PlanRequest): Promise<PlanDraft> {
      return {
        summary: '首版计划',
        steps: options.stepIds.map((id) => ({
          id,
          type: STEP_TYPE,
          title: `步骤 ${id}`,
          dependsOn: [],
          intent: {
            toolName: TOOL_NAME,
            // ★ 哨兵的一半放在工具入参里：入参会随重排请求发给模型，
            //   但绝不该出现在给用户看的错误文案里。
            input: { note: `目标要点：${SENTINEL}` },
            producesFacts: false,
          },
        })),
      };
    },
    async replan(_request: ReplanRequest): Promise<PlanDraft> {
      // 原样重发被替换的步骤（标题不变）→ 子树 delta = 0 → NO_CONVERGENCE。
      return {
        summary: '重排计划',
        steps: options.stepIds.map((id) => ({
          id: `r2-${id}`,
          type: STEP_TYPE,
          title: `步骤 ${id}`,
          dependsOn: [],
          intent: null,
        })),
      };
    },
    async runTool(call: ToolCall): Promise<ToolOutcome> {
      const spec = options.reasons[call.stepId];
      return {
        ok: false,
        sourceRefs: [],
        isEstimate: false,
        durationMs: 0,
        error: {
          code: spec.code,
          // 哨兵的另一半放在错误消息原文里：内核不展示 `message`，
          // 所以它一次都不该露脸。
          message: `运行时原文：${SENTINEL}`,
          retryable: false,
          traceId: '',
          detail: { stepId: call.stepId, sentinel: SENTINEL, allowedToolNames: [TOOL_NAME] },
        },
      };
    },
  };

  return {
    events,
    run: async () => {
      await runGoal(
        { goal: '把两路数据汇总成一版结论，预算不超过 500 元，三天内完成', domainId: DOMAIN_ID },
        {
          runtime,
          emit: (event) => events.push(event),
          sleep: async () => undefined,
          streamDelayMs: 0,
        },
      );
    },
  };
}

/** 错误事件的文案（`failRun` 的 message 原文）—— 与 `ErrorState` 卡片上那句同源。 */
function errorMessage(events: StreamEvent[]): string {
  const failure = events.find((event) => event.type === 'error');
  return failure && failure.type === 'error' ? failure.message : '';
}

/** `ErrorState` 卡片上的 message（卡片是另一个渲染出口，必须一并检查）。 */
function errorCardMessage(events: StreamEvent[]): string {
  for (const event of events) {
    if (event.type !== 'component_props_delta') continue;
    const operation = event.patch[0];
    if (operation.path !== '/message') continue;
    if (typeof operation.value === 'string') return operation.value;
  }
  return '';
}

describe('失败步骤的原因进入错误信息', () => {
  beforeEach(() => {
    clearDomainPacks();
    const registered = registerDomainPack(createTestDomain());
    expect(registered.ok).toBe(true);
  });

  afterAll(() => {
    clearDomainPacks();
  });

  it('多个步骤各有不同失败原因 ⇒ 文案里能看到这些不同的原因', async () => {
    const harness = createHarness({
      stepIds: ['s-1', 's-2', 's-3'],
      reasons: {
        //三个**不同**的白名单错误码：若实现只取一个"共有的原因"，本条就会红。
        's-1': { code: 'TOOL_FAILED', message: 'x' },
        's-2': { code: 'TOOL_TIMEOUT', message: 'x' },
        's-3': { code: 'SOURCE_MISSING', message: 'x' },
      },
    });

    await harness.run();

    const message = errorMessage(harness.events);
    // 前提：确实走进了"失败 → 重排 → 被拒"这条路径。
    expect(message).toContain('触发=FATAL_ERROR');
    // ★ 核心断言：三条**不同**的原因都在，且与各自的步骤 id 配对。
    expect(message).toContain('s-1=工具调用失败');
    expect(message).toContain('s-2=工具调用超时');
    expect(message).toContain('s-3=缺少结果来源');
  });

  it('步骤数超上限 ⇒ 只列前 N 个并带"等共 N 个"的总数', async () => {
    const stepIds = ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6', 's-7'];
    const harness = createHarness({
      stepIds,
      reasons: Object.fromEntries(
        stepIds.map((id) => [id, { code: 'TOOL_FAILED', message: 'x' }]),
      ),
    });

    await harness.run();

    const message = errorMessage(harness.events);
    // 前 5 个列出。
    expect(message).toContain(`s-${MAX_DIAGNOSTIC_IDS}=工具调用失败`);
    //总数照实给（不刷清单）。
    expect(message).toContain(`等共 ${stepIds.length} 个`);
    // ★ 第 6 个之后**不许**出现 —— 这一条才真的锁住"不把整屏刷满"。
    expect(message).not.toContain('s-6=工具调用失败');
    expect(message).not.toContain('s-7=工具调用失败');
  });

  it('没有可用原因文本 ⇒ 显式占位，不静默省略', async () => {
    const harness = createHarness({
      stepIds: ['s-1', 's-2'],
      reasons: {
        // 白名单内的码 → 有标签。
        's-1': { code: 'TOOL_FAILED', message: 'x' },
        // ★ 白名单**外**的码（外部 runtime 违约时会发生）：不得回显原文，
        //   也不得静默省略 —— 必须显式说"不知道"。
        's-2': { code: 'VENDOR_RATE_LIMITED', message: 'x' },
      },
    });

    await harness.run();

    const message = errorMessage(harness.events);
    expect(message).toContain('s-1=工具调用失败');
    expect(message).toContain('s-2=原因未知');
    // 外部码原文同样不许露脸。
    expect(message).not.toContain('VENDOR_RATE_LIMITED');
  });

  it('★ 内容不泄漏：模型原文 / 用户输入 / detail 片段都不许出现在文案里', async () => {
    const harness = createHarness({
      stepIds: ['s-1', 's-2'],
      reasons: {
        's-1': { code: 'TOOL_FAILED', message: SENTINEL, detail: { sentinel: SENTINEL } },
        's-2': { code: 'TOOL_TIMEOUT', message: SENTINEL, detail: { sentinel: SENTINEL } },
      },
    });

    await harness.run();

    // 前提：这一步真的跑到了失败收尾（否则下面的断言全是空转）。
    const message = errorMessage(harness.events);
    expect(message).not.toBe('');
    expect(message).toContain('触发=FATAL_ERROR');

    // ★ 守门断言：两个渲染出口都不得含哨兵。
    //   `ErrorState` 卡片是另一个出口 —— 只查日志那一处等于漏掉半条通路。
    expect(message).not.toContain(SENTINEL);
    expect(errorCardMessage(harness.events)).not.toContain(SENTINEL);

    // ★ 再钉一层"截断式泄漏"：即便有人把展示改成"截断后的原文"，短哨兵仍会被看到。
    //   没有这一层的话，一个 24 字符上限就能把泄漏藏住（见 SENTINEL 的注释）。
    expect(message).not.toContain('SENTINEL');
    expect(errorCardMessage(harness.events)).not.toContain('SENTINEL');
  });
});
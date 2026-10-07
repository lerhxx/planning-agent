/**
 * ★ 回归锁：目标摘要（`intent.input.goalSummary`）由内核在建计划时注入，**不依赖任何 runtime**。
 *
 * ## 复现的故障（真模型路径）
 *
 * ```
 * #1 失败  检索候选 · 类别 A   检索类步骤 · 并行组 candidate-search · 第 3 次尝试
 * #2 失败  检索候选 · 类别 B   检索类步骤 · 并行组 candidate-search · 第 3 次尝试
 * #3 失败  检索候选 · 类别 C   检索类步骤 · 并行组 candidate-search · 第 3 次尝试
 * 计划：失败 rev 4   0/4 步 · 0%
 * ```
 * （原文里的具体领域词一律抹掉——`src/core/**` 的注释同样在领域词守卫扫描范围内。）
 *
 * 根因是一条"**只有 Mock 满足的隐性契约**`：MockRuntime 回放模板时顺手把
 * `goal.summary` 塞进每个步骤的工具入参，而真模型路径没有这一步。
 * 领域工具要从入参里的目标摘要读口径（范围 / 期限 / 额度）才能决定检索目标 ——
 * 拿不到就识别不出范围、直接报错，步骤被重试到 `maxAttempts` 仍然全失败，
 * 重排再生成一批同样缺摘要的步骤，于是 rev 一路涨到 4 仍然 0/4。
 *
 * Mock 一直替内核兜着这个底，所以既有测试全绿、真模型一上线就崩。
 *
 * ## 本文件锁住的语义
 *
 * 1. **首次规划**：runtime 返回的草稿**不带**摘要（真模型形态）→ 最终步骤必须带上内核的真实摘要；
 * 2. **重排路径**：重排新生成的步骤同样必须带上 —— 否则"重排"只是把同一个故障再演一遍；
 * 3. **反向锁**：runtime 自己在 `intent.input` 里写的转述，必须被内核的真实摘要覆盖
 *    （否则口径就又变成"模型说了算"）。
 *
 * ## 为什么用真的 MockRuntime 而不是手写 runtime
 *
 * 走`createMockRuntime` 的默认 `tool()` 才能把入参真正送进**领域工具的 `execute`**
 * （过`inputSchema` → 校验 → 执行）。手写 `runTool` 会把这半段绕过去，
 * 测到的只是"内核把字段塞进了 Step"，而不是"工具真的读得到"。
 * 这里的 `execute` 就是那类检索工具的形状：拿不到口径就报错。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_DEGRADE_CHAIN, type DomainPack, type ToolSpec } from '@/shared/domain/types';
import type { PlanDraft } from '@/src/core/runtime/adapter';
import { runGoal } from '@/src/core/run/engine';
import { clearDomainPacks, registerDomainPack } from '@/src/core/registry/domainRegistry';
import {
  createDefaultMockScript,
  createMockRuntime,
  type MockScript,
} from '@/src/core/runtime/mock';

const DOMAIN_ID = 'goalsummarytest';
const STEP_TYPE = 'probe';
const TOOL_NAME = 'probe.search';
const GOAL = '把两路数据汇总成一版结论，预算不超过 500 元，三天内完成';

/** 与领域工具同形的入参：摘要可缺省（空串是合法值），缺了不会在schema 层报错。 */
const zProbeInput = z.object({
  goalSummary: z.string().default(''),
  category: z.string().default(''),
});

/**
 * 最小领域包：一个必须读到目标摘要才会成功的工具。
 *
 * ★ `execute` 在摘要为空时**抛错**，与真实检索工具"识别不出范围"的表现同构 ——
 *   内核把它转成 `TOOL_FAILED`，步骤重试到上限后失败。
 */
function createTestDomain(state: { calls: number; failFirst: number }): DomainPack {
  const tool: ToolSpec<never, unknown> = {
    name: TOOL_NAME,
    description: '读目标摘要决定检索范围的探针工具',
    inputSchema: zProbeInput,
    producesFacts: false,
    idempotent: true,
    timeoutMs: 1_000,
    retryable: false,
    stepType: STEP_TYPE,
    execute: async (input) => {
      const parsed = zProbeInput.safeParse(input);
      const goalSummary = parsed.success ? parsed.data.goalSummary : '';
      // ★ 缺摘要 ⇒ 识别不出范围 ⇒ 报错（这正是用户截图里那三个步骤失败的形态）。
      if (goalSummary.trim().length === 0) throw new Error('识别不出目标范围');
      state.calls += 1;
      if (state.calls <= state.failFirst) {
        return {
          ok: false,
          sourceRefs: [],
          isEstimate: false,
          durationMs: 0,
          error: { code: 'TOOL_FAILED' as const, message: '注入：这一步失败一次', retryable: false, traceId: '' },
        };
      }
      return { ok: true, sourceRefs: [], isEstimate: false, durationMs: 0 };
    },
  };

  return {
    meta: {
      id: DOMAIN_ID,
      displayName: 'Goal Summary Test',
      version: '1.0.0',
      schemaVersion: 1,
      description: '目标摘要注入的回归测试用领域包',
      matcher: { keywords: [], patterns: [], negativeKeywords: [], scoreBySignals: {} },
      requiredSignals: [],
      capabilities: { vision: false, geo: false, providers: false, timeSequence: false },
    },
    tools: { [TOOL_NAME]: tool },
    providers: { namespace: DOMAIN_ID, create: () => ({}) },
    ui: { components: [], degradeChain: CORE_DEGRADE_CHAIN, stepRenderers: {} },
    prompts: { worldview: 'w', constraints: 'c', antiHallucination: '不得编造事实', planning: '' },
    planning: {
      stepTypes: [{ type: STEP_TYPE, label: '检索步骤', description: '', maxAttempts: 2 }],
      templates: [],
      validateStep: () => ({ ok: true, violations: [] }),
    },
    evaluation: { cases: [], metricIds: [] },
  };
}

interface Harness {
  run: () => ReturnType<typeof runGoal>;
}

/**
 * 造一个"真模型形态"的 harness：`plan` / `replan` 返回的草稿里**没有**摘要，
 * 工具执行走MockRuntime 默认实现（真正把入参送进领域 `execute`）。
 */
function createHarness(options: {
  failFirst?: number;
  /** 模型在 `intent.input` 里自己写的转述（用于验证覆盖语义）。 */
  modelParaphrase?: string;
}): Harness {
  const state = { calls: 0, failFirst: options.failFirst ?? 0 };
  const registered = registerDomainPack(createTestDomain(state));
  if (!registered.ok) throw new Error(`注册失败：${registered.issues.join(' / ')}`);

  const base = createDefaultMockScript();
  const stepIntent = () => ({
    toolName: TOOL_NAME,
    // ★ 关键：草稿里只有模型自己写的东西，摘要要么没有、要么是它的转述。
    input: options.modelParaphrase === undefined ? { category: 'main' } : { category: 'main', goalSummary: options.modelParaphrase },
    producesFacts: false,
  });

  const planDraft = (): PlanDraft => ({
    summary: '首版计划',
    steps: [{ id: 's-1', type: STEP_TYPE, title: '检索候选 · 首版', dependsOn: [], intent: stepIntent() }],
  });
  const replanDraft = (revision: number): PlanDraft => ({
    summary: '重排计划',
    steps: [
      {
        id: `r${revision}-1`,
        type: STEP_TYPE,
        // 换标题 ⇒ 子树 delta > 0 ⇒ 通过收敛判定（否则测到的是收敛闸门，不是本条语义）。
        title: `检索候选 · 重排 ${revision}`,
        dependsOn: [],
        intent: stepIntent(),
      },
    ],
  });

  const script: MockScript = {
    plan: () => planDraft(),
    replan: (request) => replanDraft(request.revision),
    tool: (call, ctx) => base.tool(call, ctx),
  };

  return {
    run: () =>
      runGoal(
        { goal: GOAL, domainId: DOMAIN_ID, simulate: 'none' },
        {
          runtime: createMockRuntime({ latencyMs: 0, script }),
          emit: () => undefined,
          sleep: async () => undefined,
          streamDelayMs: 0,
          now: () => new Date('2026-01-01T00:00:00.000Z'),
        },
      ),
  };
}

function inputsOf(result: { plan?: { steps: Array<{ intent: { input: Record<string, unknown> } | null }> } | null }) {
  return (result.plan?.steps ?? []).map((step) => step.intent?.input);
}

describe('目标摘要注入：真模型路径的检索步骤不再全失败', () => {
  beforeEach(() => {
    clearDomainPacks();
  });

  afterAll(() => {
    clearDomainPacks();
  });

  it('★★ 草稿不带摘要（真模型形态）→ 内核注入真实摘要，步骤不再全失败', async () => {
    const harness = createHarness({});
    const result = await harness.run();

    expect(result.status).toBe('completed');
    expect(result.plan?.steps.every((step) => step.status === 'done')).toBe(true);
    // 内核注入的是**用户原话**那份摘要（经 `parseGoal` 处理后写进 `goal.summary`）。
    expect(inputsOf(result)[0]).toEqual({ category: 'main', goalSummary: expect.stringContaining('汇总') });
  });

  it('★ 反向锁：模型自己写的转述被内核的真实摘要覆盖（口径不由模型说了算）', async () => {
    const harness = createHarness({ modelParaphrase: '模型编的摘要，认识一下' });
    const result = await harness.run();

    expect(result.status).toBe('completed');
    const injected = inputsOf(result)[0]?.goalSummary;
    expect(injected).not.toBe('模型编的摘要，认识一下');
    expect(injected).toEqual(expect.stringContaining('汇总'));
    // 模型写的其它字段一律保留。
    expect(inputsOf(result)[0]?.category).toBe('main');
  });

  it('★★ 重排路径：新生成的步骤同样带上摘要（重排不再是同一条死路）', async () => {
    // 先让首版失败一次 ⇒ 触发 FATAL_ERROR 重排；重排后的步骤必须也能读到摘要。
    const harness = createHarness({ failFirst: 1 });
    const result = await harness.run();

    expect(result.plan?.revision).toBeGreaterThanOrEqual(2);
    const fresh = (result.plan?.steps ?? []).filter((step) => step.id.startsWith('r2-'));
    expect(fresh.length).toBeGreaterThan(0);
    // ★ 没有一步是因为"识别不出目标范围"而失败的：重排把同样的故障再演一遍就白排了。
    expect(result.status).toBe('completed');
    for (const step of fresh) {
      expect(String(step.intent?.input?.goalSummary ?? '')).toContain('汇总');
      expect(step.status).toBe('done');
    }
  });
});
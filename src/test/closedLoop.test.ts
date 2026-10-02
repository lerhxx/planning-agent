/**
 * M1 验收：**目标 → 计划 → 执行 → 重规划** 闭环端到端跑通。
 *
 * 放在 `src/test/` 而不是 `src/core/`，是因为它需要 import 一个领域包；
 * 内核目录必须保持"零领域词"，连 import 路径里都不允许出现领域名。
 *
 * 全程 MockRuntime：零网络、零 API Key。
 */
import { describe, expect, it } from 'vitest';
import type { RunContext } from '@/shared/run/types';
import type { StreamEvent } from '@/shared/stream/events';
import { runGoal, type EngineInput, type EngineResult } from '@/src/core/run/engine';
import { createMockRuntime, type MockRuntimeOptions } from '@/src/core/runtime/mock';
// 领域包的注册入口：桶文件（新增领域只改 src/domains/index.ts）。
import { registerAllDomains } from '@/src/domains';

const [DEFAULT_DOMAIN_ID] = registerAllDomains();

const GOAL = '两路采集后汇总成一版结论，预算不超过 500 元，三天内完成';

interface RunOutput {
  result: EngineResult;
  events: StreamEvent[];
}

async function run(
  simulate: EngineInput['simulate'],
  overrides: Partial<EngineInput> = {},
  runtimeOptions: MockRuntimeOptions = {},
): Promise<RunOutput> {
  const events: StreamEvent[] = [];
  const result = await runGoal(
    { goal: GOAL, simulate, ...overrides },
    {
      // 每个 run 一个独立 Runtime 实例，故障注入状态互不泄漏。
      runtime: createMockRuntime({ latencyMs: 0, ...runtimeOptions }),
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

/**
 * 从事件流里还原"重排前已经 done 的步骤 id 集合"。
 *
 * ★ 不用硬编码某个 id：并行批次里谁先失败取决于 Promise 的调度顺序，
 * 断言必须**与顺序无关**，否则测试会变成 flaky。
 */
function doneBeforeReplan(events: StreamEvent[]): Set<string> {
  const ids = new Set<string>();
  let replanning = false;
  for (const event of events) {
    if (event.type === 'plan_status' && event.status === 'replanning') {
      replanning = true;
      continue;
    }
    if (!replanning && event.type === 'step_status' && event.status === 'done') {
      ids.add(event.stepId);
    }
  }
  return ids;
}

describe('M1 闭环', () => {
  it('正常路径：计划逐条长出 → 全部完成 → completed', async () => {
    const { result, events } = await run('none');

    expect(result.status).toBe('completed');
    expect(result.plan).not.toBeNull();
    expect(result.plan?.steps.length).toBeGreaterThanOrEqual(3);
    expect(result.plan?.steps.every((step) => step.status === 'done')).toBe(true);

    // plan_start 一次，step_add 逐条下发
    expect(events.filter((e) => e.type === 'plan_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step_add').length).toBeGreaterThanOrEqual(3);

    // 结果被映射成组件并流式下发（start → delta → end）
    expect(events.some((e) => e.type === 'component_start')).toBe(true);
    expect(events.some((e) => e.type === 'component_props_delta')).toBe(true);
    expect(events.some((e) => e.type === 'component_end')).toBe(true);

    // 最后一条是 done
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('retry-step：第一次失败后重试成功，计划不被推翻', async () => {
    const { result, events } = await run('retryable');

    expect(result.status).toBe('completed');
    expect(result.plan?.revision).toBe(1);
    // 至少一步经历了第 2 次尝试
    expect(result.plan?.steps.some((step) => step.attempt >= 2)).toBe(true);
    // 失败步骤在下发流里出现过
    expect(events.some((e) => e.type === 'step_status')).toBe(true);
  });

  it('★ 重规划：不可恢复失败 → 只重排受影响子树，已完成 stepId 不变', async () => {
    const { result, events } = await run('fatal');

    // 触发过重规划
    expect(result.plan?.revision).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'plan_status' && e.status === 'replanning')).toBe(true);
    // 被替换的步骤被标记 cancelled
    expect(events.some((e) => e.type === 'step_status' && e.status === 'cancelled')).toBe(true);

    // 闭环仍然跑完
    expect(result.status).toBe('completed');
    expect(result.plan?.steps.every((step) => step.status === 'done')).toBe(true);

    // ★ 重排前已完成的步骤：id 与状态都原样保留（不依赖并行调度顺序）
    const survivors = doneBeforeReplan(events);
    expect(survivors.size).toBeGreaterThan(0);
    for (const id of survivors) {
      const step = result.plan?.steps.find((item) => item.id === id);
      expect(step).toBeDefined();
      expect(step?.status).toBe('done');
    }

    // 新步骤带 revision 前缀
    expect(result.plan?.steps.some((step) => step.id.startsWith('r2-'))).toBe(true);
  });

  it('ask-user：信息不足 → 下发 ClarifyOptions，计划转 awaiting_user', async () => {
    const { result, events } = await run('clarify');

    expect(result.status).toBe('awaiting_user');
    expect(nodeComponents(events)).toContain('ClarifyOptions');
    expect(result.plan?.steps.some((step) => step.status === 'awaiting_user')).toBe(true);
  });

  it('澄清后带答案继续 → 能跑完', async () => {
    const { result } = await run('clarify', {
      answers: {
        'clarify:tool:s-1': 'opt-a',
        'clarify:tool:s-2': 'opt-a',
        'clarify:tool:s-3': 'opt-a',
      },
    });
    expect(result.status).toBe('completed');
  });

  it('中断：signal.aborted → 计划转 paused，不白屏', async () => {
    const events: StreamEvent[] = [];
    const signal = { aborted: false };
    const result = await runGoal(
      { goal: GOAL, simulate: 'none' },
      {
        runtime: createMockRuntime({ latencyMs: 0 }),
        emit: (event) => {
          events.push(event);
          // 收到第一个 step_add 后立刻中断
          if (event.type === 'step_add') signal.aborted = true;
        },
        sleep: async () => undefined,
        streamDelayMs: 0,
        signal,
      },
    );

    expect(result.status).toBe('paused');
    expect(result.plan?.status).toBe('paused');
    expect(events[events.length - 1]?.type).toBe('done');
  });

  it('计划生成失败也必须有兜底：未知领域 → failed + ErrorState 组件', async () => {
    const events: StreamEvent[] = [];
    const result = await runGoal(
      { goal: GOAL, domainId: 'ghost' },
      {
        runtime: createMockRuntime({ latencyMs: 0 }),
        emit: (event) => events.push(event),
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe('failed');
    expect(nodeComponents(events)).toContain('ErrorState');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('事实必须带来源：producesFacts 的步骤结果都带 sourceRefs', async () => {
    const { result } = await run('none');
    const factSteps = (result.plan?.steps ?? []).filter(
      (step) => step.intent?.producesFacts === true,
    );

    // 先断言"确实存在 producesFacts 的步骤"，否则下面的循环会因为 0 次断言而假通过。
    expect(factSteps.length).toBeGreaterThan(0);
    expect.assertions(1 + factSteps.length);

    for (const step of factSteps) {
      expect((step.result?.sourceRefs ?? []).length).toBeGreaterThan(0);
    }
  });

  it('领域桶文件注册成功，默认领域 id 非空', () => {
    expect(DEFAULT_DOMAIN_ID).toBeTruthy();
  });

  it('RunContext 是纯数据：可完整 JSON 往返（不携带函数/副作用）', () => {
    const ctx: RunContext = {
      runId: 'run-1',
      traceId: 'trace-1',
      goalId: 'goal-1',
      domainId: DEFAULT_DOMAIN_ID,
      revision: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2026-01-01T00:00:25.000Z',
      budgetRemainingCNY: 2,
      signals: ['text'],
      meta: { simulate: 'none' },
    };
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(ctx);
  });
});

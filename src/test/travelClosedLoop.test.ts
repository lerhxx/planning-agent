/**
 * M2 验收：travel 领域用**内核**跑通闭环 —— 且 `src/core` 与 `shared` 零改动。
 *
 * 覆盖了四条最关键的链路：
 * 1. 正常路径：目标 → 计划 → 并行检索（事实带来源）→ 编排 → completed；
 * 2. 超预算：校验型 Provider 真的会拦截（不是静默通过），最终转人工；
 * 3. 反幻觉：POI 事实缺 SourceRef → 步骤被判失败；
 * 4. 领域可插拔：默认领域仍是 demo，travel 通过 domainId 选择。
 */
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@/shared/stream/events';
import type { DomainPack, ToolSet } from '@/shared/domain/types';
import { runGoal, type EngineInput, type EngineResult } from '@/src/core/run/engine';
import { registerDomainPack } from '@/src/core/registry/domainRegistry';
import { createMockRuntime, type MockRuntimeOptions } from '@/src/core/runtime/mock';
// 领域包的注册入口：桶文件（新增领域只改 src/domains/index.ts）。
import { registerAllDomains } from '@/src/domains';
import { travelMeta, TRAVEL_DOMAIN_ID } from '@/src/domains/travel/meta';
import { travelPack } from '@/src/domains/travel/pack';
import { travelTools } from '@/src/domains/travel/tools';
import { ITINERARY_COMPOSE_STEP_TYPE, POI_SEARCH_STEP_TYPE } from '@/src/domains/travel/planning';
import { ITINERARY_CARD_COMPONENT, POI_CARD_COMPONENT } from '@/src/domains/travel/ui';
import {
  TRIP_CATEGORIES,
  collectCompletedFacts,
  groupFactsByCategory,
  validateTripPlan,
} from '@/src/domains/travel/providers';

const [, TRAVEL_ID] = registerAllDomains();

/** 无来源的那一路：把 travel 的一整套工具包一层，故意丢掉 sourceRefs。 */
const LEAKY_DOMAIN_ID = 'travel-nosrc';

interface RunOutput {
  result: EngineResult;
  events: StreamEvent[];
}

async function run(
  goal: string,
  overrides: Partial<EngineInput> = {},
  runtimeOptions: MockRuntimeOptions = {},
): Promise<RunOutput> {
  const events: StreamEvent[] = [];
  const result = await runGoal(
    { goal, simulate: 'none', domainId: TRAVEL_ID, ...overrides },
    {
      runtime: createMockRuntime({ latencyMs: 0, ...runtimeOptions }),
      emit: (event) => events.push(event),
      sleep: async () => undefined,
      streamDelayMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    },
  );
  return { result, events };
}

function componentNames(events: StreamEvent[]): string[] {
  return events
    .filter((event) => event.type === 'component_start')
    .map((event) => (event.type === 'component_start' ? event.component : ''));
}

describe('travel · 端到端闭环（MockRuntime，零网络零密钥）', () => {
  it('正常路径：计划逐条长出 → 检索 → 编排 → completed', async () => {
    const { result, events } = await run('帮我规划上海三日游，预算 3000 元，想逛景点也吃本地菜');

    expect(result.status).toBe('completed');
    expect(result.plan?.domainId).toBe(TRAVEL_DOMAIN_ID);

    const steps = result.plan?.steps ?? [];
    expect(steps).toHaveLength(4);
    expect(steps.every((step) => step.status === 'done')).toBe(true);
    expect(steps.filter((step) => step.type === POI_SEARCH_STEP_TYPE)).toHaveLength(3);
    expect(steps.filter((step) => step.type === ITINERARY_COMPOSE_STEP_TYPE)).toHaveLength(1);

    // 事件：plan 一次 start、step 逐条 add、最后一条是 done
    expect(events.filter((event) => event.type === 'plan_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'step_add')).toHaveLength(4);
    expect(events[events.length - 1]?.type).toBe('done');

    // 结果组件：候选卡片 ×3 + 行程卡片 ×1，且都流式长出（start → delta → end）
    const names = componentNames(events);
    expect(names.filter((name) => name === POI_CARD_COMPONENT)).toHaveLength(3);
    expect(names.filter((name) => name === ITINERARY_CARD_COMPONENT)).toHaveLength(1);
    expect(events.some((event) => event.type === 'component_props_delta')).toBe(true);
    expect(events.some((event) => event.type === 'component_end')).toBe(true);
  });

  it('★ 事实必须带来源：每个 producesFacts 步骤都返回了 SourceRef', async () => {
    const { result } = await run('帮我规划成都二日游，预算 2000 元');
    const factSteps = (result.plan?.steps ?? []).filter((step) => step.intent?.producesFacts === true);

    expect(factSteps.length).toBeGreaterThan(0);
    for (const step of factSteps) {
      expect((step.result?.sourceRefs ?? []).length).toBeGreaterThan(0);
      for (const ref of step.result?.sourceRefs ?? []) {
        expect(ref.providerId).toBe('travel.poi');
        expect(ref.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('★ 校验真的会拦截：预算明显不够 → 不静默通过，最终转人工', async () => {
    const { result, events } = await run('上海三日游，预算 300');

    // 既没有 completed，也没有"假装成功"：走到 awaiting_user 让人类拍板。
    expect(result.status).toBe('awaiting_user');
    expect(result.reason).toBe('VALIDATION_ASK_USER');
    expect(result.plan?.status).toBe('paused');
    expect(events.some((event) => event.type === 'plan_status' && event.status === 'replanning')).toBe(true);
    expect(componentNames(events)).toContain('ClarifyOptions');
    // 拦截发生在执行之前：一个step都没被标记为 done
    expect((result.plan?.steps ?? []).some((step) => step.status === 'done')).toBe(false);
  });

  it('★ 重排后 revision 真的递增，且已完成 step 的 id 与状态都不被改动（红线 8）', async () => {
    // 必须构造「执行了一部分 → 失败 → 重排」：只有这样才能在重排发生时确实存在已完成的 step。
    // 用超预算（300）不行 —— 它在**执行前**就被拦下，一个 done 步都没有，断言会变成恒真。
    const { result, events } = await run('上海三日游，预算 3000', { simulate: 'fatal' });
    const plan = result.plan;
    expect(plan).toBeTruthy();
    // revision > 1：确实发生过重排（不是"压根没重排所以当然没改动"）
    expect(plan?.revision).toBeGreaterThan(1);

    // 前提：重排发生前有 step 已经 done，否则下面的断言没有意义。
    const doneIds = new Set<string>();
    for (const event of events) {
      if (event.type === 'step_status' && event.status === 'done') doneIds.add(event.stepId);
    }
    expect(doneIds.size).toBeGreaterThan(0);

    const byId = new Map((plan?.steps ?? []).map((step) => [step.id, step]));
    for (const id of doneIds) {
      const step = byId.get(id);
      expect(step, `已完成步骤 ${id} 在重排后消失了`).toBeTruthy();
      expect(step?.status, `已完成步骤 ${id} 的状态被改了`).toBe('done');
    }
  });

  it('未知领域 → failed + ErrorState，不白屏', async () => {
    const { result, events } = await run('上海三日游', { domainId: 'ghost' });
    expect(result.status).toBe('failed');
    expect(componentNames(events)).toContain('ErrorState');
  });
});

describe('travel · 反幻觉端到端', () => {
  it('POI 事实缺 SourceRef → 步骤被判失败（内核通用码 SOURCE_MISSING）', async () => {
    // 只丢来源，其余完全复用 travel —— 证明拦截来自"没有来源"这件事本身。
    const leakyTools: ToolSet = {};
    for (const [name, spec] of Object.entries(travelTools)) {
      leakyTools[name] = {
        ...spec,
        async execute(input: never, ctx: Parameters<typeof spec.execute>[1]) {
          const base = await spec.execute(input, ctx);
          return { ...base, sourceRefs: [] };
        },
      };
    }
    const leakyPack: DomainPack = {
      ...travelPack,
      meta: { ...travelMeta, id: LEAKY_DOMAIN_ID, displayName: 'travel（无来源注入）' },
      tools: leakyTools,
    };
    const registered = registerDomainPack(leakyPack);
    expect(registered.ok).toBe(true);

    const { result, events } = await run('帮我规划上海三日游，预算 3000 元', {
      domainId: LEAKY_DOMAIN_ID,
    });

    const failedSteps = (result.plan?.steps ?? []).filter((step) => step.status === 'failed');
    expect(failedSteps.length).toBeGreaterThan(0);
    expect(failedSteps.every((step) => step.error?.code === 'SOURCE_MISSING')).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'step_status' && event.status === 'failed' && event.reason === 'SOURCE_MISSING',
      ),
    ).toBe(true);
    // 绝不能"带着假数据跑完"。
    expect(result.status).not.toBe('completed');
  });

  it('★ 事实被丢弃 → 端到端可观测的 warning（不静默、不阻断、条数守恒）', async () => {
    // 构造"部分记录缺 name"：它带 source（不会被判无源），但还原不进桶 → 被丢弃。
    // 关键断言是**丢弃这件事在端到端里看得见** —— 否则就是悄悄把成本算低，
    // 而总价越低越容易通过预算校验，"丢数据"会变成"放行超预算"的暗门。
    const partialTools: ToolSet = {};
    for (const [name, spec] of Object.entries(travelTools)) {
      partialTools[name] = {
        ...spec,
        async execute(input: never, ctx: Parameters<typeof spec.execute>[1]) {
          const base = await spec.execute(input, ctx);
          const data = base.data as { pois?: Array<Record<string, unknown>> } | undefined;
          if (!data || !Array.isArray(data.pois) || data.pois.length === 0) return base;
          const pois = data.pois.map((poi, index) => (index === 0 ? { ...poi, name: '' } : poi));
          return { ...base, data: { ...data, pois } };
        },
      };
    }
    const PARTIAL_ID = 'travel-noname';
    const registered = registerDomainPack({
      ...travelPack,
      meta: { ...travelMeta, id: PARTIAL_ID, displayName: 'travel（缺名称注入）' },
      tools: partialTools,
    });
    expect(registered.ok).toBe(true);

    const { result } = await run('帮我规划上海三日游，预算 3000 元', { domainId: PARTIAL_ID });

    // warning 不阻断：整条 run 照常跑完。
    expect(result.status).toBe('completed');

    const plan = result.plan;
    expect(plan).toBeTruthy();
    const facts = collectCompletedFacts(plan!);
    const grouped = groupFactsByCategory(facts.records);
    const used = TRIP_CATEGORIES.reduce((total, category) => total + grouped[category].length, 0);

    // 条数守恒：没有记录凭空消失，被丢掉的都被数出来了。
    expect(grouped.dropped).toBeGreaterThan(0);
    expect(grouped.dropped + used).toBe(facts.records.length);

    // 并且校验器把这件事说了出来（而不是只在内存里丢掉）。
    const outcome = validateTripPlan(plan!);
    expect(outcome.ok).toBe(true);
    expect(
      outcome.violations.some(
        (violation) =>
          violation.severity === 'warning' && String(violation.message).includes('未计入成本重算'),
      ),
    ).toBe(true);
  });
});

describe('travel · 领域可插拔', () => {
  it('桶文件注册两个领域，默认仍是 demo（回归演示基线不被顶掉）', () => {
    const ids = registerAllDomains();
    expect(ids).toContain('demo');
    expect(ids).toContain(TRAVEL_DOMAIN_ID);
    expect(ids[0]).toBe('demo');
  });
});

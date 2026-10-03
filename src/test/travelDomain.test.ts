/**
 * travel 领域包的**单元级**验证：注册守卫、纯函数口径、校验型 Provider、toProps 纯度、反幻觉。
 *
 * 放在 `src/test/` 而不是领域目录里：内核与领域包目录保持 demo 的文件划分，
 * 测试统一收在 `src/test/**`（`src/core` 目录连 import 路径里都不允许出现领域名）。
 */
import { describe, expect, it } from 'vitest';
import { zSourceRef, type Plan, type Step } from '@/shared/plan/types';
import type { DomainPack } from '@/shared/domain/types';
import type { RunContext } from '@/shared/run/types';
import { registerDomainPack } from '@/src/core/registry/domainRegistry';
import { observe } from '@/src/core/execution/observer';
import { travelMeta, TRAVEL_DOMAIN_ID } from '@/src/domains/travel/meta';
import {
  ITINERARY_COMPOSE_STEP_TYPE,
  POI_SEARCH_STEP_TYPE,
  IMAGE_UNDERSTAND_STEP_TYPE,
  TRIP_BRIEF_STEP_TYPE,
  travelPlanning,
} from '@/src/domains/travel/planning';
import { travelPrompts } from '@/src/domains/travel/prompts';
import { travelEvaluation } from '@/src/domains/travel/evaluation';
import { travelUI } from '@/src/domains/travel/ui';
import { travelTools, zItineraryComposeResult, zPoiSearchResult } from '@/src/domains/travel/tools';
import {
  CITY_FALLBACK_NOTE,
  CITY_HINTS,
  MAX_ITEMS_PER_DAY,
  POI_FIXTURES,
  composeItinerary,
  createTripProviders,
  groupFactsByCategory,
  listPois,
  listPoisByCategory,
  parseTripBrief,
  resolveTripBrief,
  spreadOverDays,
  TRIP_CATEGORIES,
  validateTripPlan,
  zTripPoi,
  type FactBuckets,
  type TripCategory,
  type TripPoi,
} from '@/src/domains/travel/providers';
import { makePlan, makeStep } from './fixtures';

const CTX: RunContext = {
  runId: 'run-travel-unit',
  traceId: 'trace-travel-unit',
  goalId: 'goal-travel-unit',
  domainId: TRAVEL_DOMAIN_ID,
  revision: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  deadlineAt: '2026-01-01T00:00:25.000Z',
  budgetRemainingCNY: 2,
  signals: ['text'],
  meta: { simulate: 'none' },
};

/** 目标里写明：上海三日游，预算 3000。 */
const HAPPY_GOAL = '帮我规划上海三日游，预算 3000 元，想逛景点也吃本地菜';

function searchStep(
  id: string,
  category: TripCategory,
  input: Record<string, unknown> = {},
): Step {
  return makeStep({
    id,
    domainId: TRAVEL_DOMAIN_ID,
    type: POI_SEARCH_STEP_TYPE,
    title: `检索 ${category}`,
    intent: {
      toolName: 'travel.poiSearch',
      input: { category, goalSummary: HAPPY_GOAL, ...input },
      producesFacts: true,
    },
  });
}

function composeStep(id: string, input: Record<string, unknown> = {}, dependsOn: string[] = []): Step {
  return makeStep({
    id,
    domainId: TRAVEL_DOMAIN_ID,
    type: ITINERARY_COMPOSE_STEP_TYPE,
    title: '编排每日行程',
    dependsOn,
    intent: { toolName: 'travel.itineraryCompose', input: { goalSummary: HAPPY_GOAL, ...input }, producesFacts: false },
  });
}

function planOf(steps: Step[]): Plan {
  return makePlan(steps, { domainId: TRAVEL_DOMAIN_ID });
}

/** 模板形状：三路并行检索 → 一次编排。 */
function templatePlan(overrides: Record<string, unknown> = {}): Plan {
  return planOf([
    searchStep('s-1', 'attraction', overrides),
    searchStep('s-2', 'restaurant', overrides),
    searchStep('s-3', 'hotel', overrides),
    composeStep('s-4', overrides, ['s-1', 's-2', 's-3']),
  ]);
}

describe('travel · 8 段齐全', () => {
  it('完整注册成功（meta/tools/providers/ui/prompts/planning/evaluation 齐全）', () => {
    const result = registerDomainPack(travelPackForTest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pack.meta.id).toBe(TRAVEL_DOMAIN_ID);
  });

  it('缺一段（ui）→ 注册失败并列出 missing', () => {
    const { ui: _ui, ...withoutUi } = travelPackForTest();
    const result = registerDomainPack(withoutUi);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('ui');
      expect(result.issues.join(' ')).toContain('缺少必填段');
    }
  });

  it('prompts 段含反幻觉硬插槽，且明确禁止编造价格/评分/地址', () => {
    expect(travelPrompts.antiHallucination.length).toBeGreaterThan(0);
    expect(travelPrompts.antiHallucination).toContain('评分');
    expect(travelPrompts.antiHallucination).toContain('不得');
  });

  it('模板与工具对齐：每步的类型都在白名单内，且绑定的工具都对得上', () => {
    const allowed = travelPlanning.stepTypes.map((descriptor) => descriptor.type);
    // v2：白名单扩到 4 类（口径确认 / 图片理解 为新增），顺序与 `planning.ts` 的声明一致。
    expect(allowed).toEqual([
      POI_SEARCH_STEP_TYPE,
      ITINERARY_COMPOSE_STEP_TYPE,
      IMAGE_UNDERSTAND_STEP_TYPE,
      TRIP_BRIEF_STEP_TYPE,
    ]);

    for (const template of travelPlanning.templates) {
      expect(template.steps.length).toBeGreaterThan(0);
      for (const step of template.steps) {
        expect(allowed).toContain(step.type);
        // 有工具意图的步骤：工具必须存在，且工具的 stepType 与步骤类型一致。
        if (step.intent) {
          const tool = travelTools[step.intent.toolName];
          expect(tool).toBeDefined();
          expect(tool?.stepType).toBe(step.type);
          expect(tool?.producesFacts).toBe(step.intent.producesFacts);
        }
        // 依赖必须是同一模板内已声明的步骤，且不依赖自己。
        for (const dep of step.dependsOn) {
          expect(template.steps.some((item) => item.id === dep)).toBe(true);
          expect(dep).not.toBe(step.id);
        }
      }
    }
  });

  it('evaluation 段可执行：happy-path 的评分口径命中与其 expect 一致', () => {
    const steps = [
      { type: POI_SEARCH_STEP_TYPE },
      { type: POI_SEARCH_STEP_TYPE },
      { type: POI_SEARCH_STEP_TYPE },
      { type: ITINERARY_COMPOSE_STEP_TYPE },
    ];
    const score = travelEvaluation.score!;
    expect(score('travel.happy-path', steps)).toBe(1);
    expect(score('travel.happy-path', [{ type: POI_SEARCH_STEP_TYPE }])).toBe(0);
    expect(travelEvaluation.cases.length).toBeGreaterThan(0);
    expect(travelEvaluation.metricIds.length).toBeGreaterThan(0);
  });
});

// pack 组装里只有纯数据 + 纯函数，测试内联构造避免污染注册表。
function travelPackForTest(): DomainPack {
  return {
    meta: travelMeta,
    tools: travelTools,
    providers: createTripProviders(),
    ui: travelUI,
    prompts: travelPrompts,
    planning: travelPlanning,
    evaluation: travelEvaluation,
  };
}

describe('travel · 纯函数口径', () => {
  it('parseTripBrief：中文天数 / 阿拉伯天数 / 预算都能抽出', () => {
    expect(parseTripBrief(HAPPY_GOAL)).toEqual({ city: '上海', days: 3, budgetCNY: 3000 });
    expect(parseTripBrief('北京 5 天，控制在 1200')).toEqual({ city: '北京', days: 5, budgetCNY: 1200 });
    expect(parseTripBrief('随便走走')).toEqual({ city: null, days: null, budgetCNY: null });
  });

  it('resolveTripBrief：显式入参 > 目标原话 > 默认值', () => {
    expect(resolveTripBrief({}).city).toBe('上海');
    expect(resolveTripBrief({}).days).toBe(3);
    expect(resolveTripBrief({ goalSummary: HAPPY_GOAL }).budgetCNY).toBe(3000);
    expect(resolveTripBrief({ goalSummary: HAPPY_GOAL, days: 7 }).days).toBe(7);
    expect(resolveTripBrief({ goalSummary: HAPPY_GOAL, city: '成都' }).city).toBe('成都');
  });

  it('未知城市回落到默认城市并标记 fallback，不断言自己认识的城市与世界', () => {
    expect(listPois('火星', 'hotel', 3).fallback).toBe(true);
    expect(listPois('火星', 'hotel', 3).city).toBe('上海');
    expect(listPois('上海', 'hotel', 3).fallback).toBe(false);
  });

  it('spreadOverDays：round-robin 分发，保证每天尽量有安排', () => {
    expect(spreadOverDays([1, 2, 3, 4], 3)).toEqual([[1, 4], [2], [3]]);
    expect(spreadOverDays([1], 3)).toEqual([[1], [], []]);
  });

  it('composeItinerary：纯函数（同入参必同结果），且口径与 fixture 表一致', () => {
    const once = composeItinerary({ city: '上海', days: 3, limitPerCategory: 4 });
    const twice = composeItinerary({ city: '上海', days: 3, limitPerCategory: 4 });
    expect(once).toEqual(twice);

    expect(once.days).toHaveLength(3);
    expect(once.days.every((day) => day.items.length > 0)).toBe(true);

    const pools = listPoisByCategory('上海', 4);
    const expected =
      [...pools.attraction, ...pools.restaurant].reduce((sum, poi) => sum + poi.priceCNY, 0) +
      pools.hotel.slice(0, 3).reduce((sum, poi) => sum + poi.priceCNY, 0);
    expect(once.totalCostCNY).toBe(expected);

    // 每一行都能溯源 —— 反幻觉在数据结构层面的落点。
    expect(once.days.flatMap((day) => day.items).every((item) => item.source.length > 0)).toBe(true);
  });

  it('composeItinerary：天数被夹到合法区间', () => {
    expect(composeItinerary({ city: '上海', days: 0 }).days).toHaveLength(1);
    expect(composeItinerary({ city: '上海', days: 999 }).days).toHaveLength(14);
  });
});

describe('travel · fixture Provider（事实唯一来源）', () => {
  it('search 每条结果都带 source，整批带 SourceRef', async () => {
    const provider = createTripProviders().create(CTX)['travel.poi'];
    expect(provider).toBeDefined();

    const result = await provider!.search({ city: '上海', category: 'hotel', limit: 3 }, CTX);
    expect(result.ok).toBe(true);
    expect(result.data).toHaveLength(3);
    expect(zSourceRef.safeParse(result.source).success).toBe(true);
    expect(result.isEstimate).toBe(true);
    expect(result.disclaimer).toBeTruthy();

    const pois = (result.data ?? []) as TripPoi[];
    for (const poi of pois) {
      expect(zTripPoi.safeParse(poi).success).toBe(true);
      expect(poi.source.length).toBeGreaterThan(0);
    }
  });

  it('detail 命中返回单条，未命中返回空（ok:false，不编造）', async () => {
    const provider = createTripProviders().create(CTX)['travel.poi']!;
    const hit = await provider.detail!('sh-a-1', CTX);
    expect(hit.ok).toBe(true);
    expect(hit.data).not.toBeNull();
    const miss = await provider.detail!('nope', CTX);
    expect(miss.ok).toBe(false);
    expect(miss.data).toBeNull();
  });
});

describe('travel · tools', () => {
  it('travel.poiSearch：producesFacts 且返回非空 sourceRefs', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      { goalSummary: HAPPY_GOAL, category: 'attraction', limit: 4 } as never,
      CTX,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.sourceRefs.length).toBeGreaterThan(0);

    const payload = zPoiSearchResult.parse(outcome.data);
    expect(payload.pois).toHaveLength(4);
    expect(payload.pois.every((poi) => poi.source.length > 0)).toBe(true);
    // 事实字段全部来自 fixture，工具自己不填任何数值口径之外的东西。
    expect(payload.pois[0]).toMatchObject({ city: '上海', category: 'attraction' });
  });

  it('travel.itineraryCompose：按目标天数编排，总价等于各日之和', async () => {
    const outcome = await travelTools['travel.itineraryCompose'].execute(
      { goalSummary: HAPPY_GOAL } as never,
      CTX,
    );
    expect(outcome.ok).toBe(true);
    const payload = zItineraryComposeResult.parse(outcome.data);

    expect(payload.days).toHaveLength(3);
    expect(payload.budgetCNY).toBe(3000);
    expect(payload.totalCostCNY).toBe(payload.days.reduce((sum, day) => sum + day.costCNY, 0));
    expect(payload.totalCostCNY).toBeLessThanOrEqual(payload.budgetCNY ?? Number.POSITIVE_INFINITY);
    expect(payload.sourceRefs.length).toBeGreaterThan(0);
  });
});

describe('travel · 校验型 Provider（内核只看 ok + severity）', () => {
  it('合法行程 → ok:true，无任何违规', () => {
    const result = validateTripPlan(templatePlan());
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('★ 超预算：不再静默通过，产出一条 error', () => {
    const result = validateTripPlan(templatePlan({ goalSummary: '上海三日游，预算 300' }));
    expect(result.ok).toBe(false);
    const severities = result.violations.map((violation) => violation.severity);
    expect(severities).toContain('error');
    // 内核拿不到这些字段；这里断言它们存在，是为了证明"领域语义不透传"而非不存在。
    const messages = result.violations.map((violation) => String(violation.message));
    expect(messages.some((message) => message.includes('预算'))).toBe(true);
  });

  it('★ 天数与目标不一致 → error（隔离口径：预算给足，确保命中的就是这一条）', () => {
    // 旧写法 `templatePlan({ days: 9 })` 沿用了目标里的 3000 预算，而 9 天总价 6275
    // 也会触发 BUDGET_OVERRUN —— 断言只写「有 error」的话，把 DAYS_MISMATCH 整条规则
    // 删掉测试照样绿，等于没锁住。这里把预算给到不可能超，让"有且仅有一条 error"成立。
    const plan = templatePlan({ days: 9, budgetCNY: 999_999 });
    const result = validateTripPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.severity).toBe('error');
    expect(String(result.violations[0]?.message)).toContain('天');

    // 对照组：天数一致 + 同样充裕的预算 → 干净通过。证明上一条 error 确实来自"天数不一致"。
    expect(validateTripPlan(templatePlan({ days: 3, budgetCNY: 999_999 })).violations).toHaveLength(0);
  });

  it('单日安排过密 → warning（不阻断执行）', () => {
    const plan = planOf([
      searchStep('s-1', 'attraction', { goalSummary: '上海一日游，预算 4000' }),
      searchStep('s-2', 'restaurant', { goalSummary: '上海一日游，预算 4000' }),
      composeStep('s-3', { goalSummary: '上海一日游，预算 4000' }, ['s-1', 's-2']),
    ]);
    const result = validateTripPlan(plan);
    expect(result.violations.some((violation) => violation.severity === 'warning')).toBe(true);
    expect(result.ok).toBe(true);

    const itinerary = composeItinerary({ city: '上海', days: 1, limitPerCategory: 4 });
    expect(itinerary.days[0].items.length).toBeGreaterThan(MAX_ITEMS_PER_DAY);
  });

  it('编排步骤缺失 / 未依赖检索步骤 → error', () => {
    const orphan = planOf([searchStep('s-1', 'attraction'), composeStep('s-2', {}, [])]);
    expect(validateTripPlan(orphan).ok).toBe(false);

    const noCompose = planOf([searchStep('s-1', 'attraction')]);
    expect(validateTripPlan(noCompose).ok).toBe(false);
  });

  it('★ 反幻觉：事实缺 SourceRef → error', () => {
    const leaked = makeStep({
      id: 's-1',
      domainId: TRAVEL_DOMAIN_ID,
      type: POI_SEARCH_STEP_TYPE,
      title: '检索景点',
      status: 'done',
      intent: { toolName: 'travel.poiSearch', input: { category: 'attraction', goalSummary: HAPPY_GOAL }, producesFacts: true },
      result: {
        ok: true,
        data: { pois: [{ name: '某处', category: 'attraction', priceCNY: 10 }] },
        sourceRefs: [],
        isEstimate: true,
        durationMs: 0,
      },
    });
    const plan = planOf([leaked, composeStep('s-2', {}, ['s-1'])]);
    const result = validateTripPlan(plan);

    expect(result.ok).toBe(false);
    const messages = result.violations.map((violation) => String(violation.message)).join(' | ');
    expect(messages).toContain('没有带来源引用');
    expect(messages).toContain('缺少来源');
  });

  it('planning.validateStep：白名单 / 依赖 / 绑定工具', async () => {
    expect((await travelPlanning.validateStep(searchStep('s-1', 'attraction'), CTX)).ok).toBe(true);
    expect(
      (await travelPlanning.validateStep(makeStep({ id: 'x', domainId: TRAVEL_DOMAIN_ID, type: 'book_flight' }), CTX)).ok,
    ).toBe(false);
    const notFactBound = makeStep({
      id: 'x',
      domainId: TRAVEL_DOMAIN_ID,
      type: POI_SEARCH_STEP_TYPE,
      intent: { toolName: 'travel.poiSearch', input: {}, producesFacts: false },
    });
    expect((await travelPlanning.validateStep(notFactBound, CTX)).ok).toBe(false);
    expect((await travelPlanning.validateStep(composeStep('s-2', {}, []), CTX)).ok).toBe(false);
  });
});

describe('travel · 反幻觉硬闸门（内核 Observer）', () => {
  it('producesFacts 的步骤结果没有 SourceRef → 判失败，触发码是内核通用码', () => {
    const step = searchStep('s-1', 'attraction');
    const observation = observe(step, {
      ok: true,
      data: { pois: [{ name: '编造的景点' }] },
      sourceRefs: [],
      isEstimate: false,
      durationMs: 1,
    });

    expect(observation.kind).toBe('fail');
    expect(observation.trigger).toBe('SOURCE_MISSING');
    expect(observation.error?.code).toBe('SOURCE_MISSING');
  });

  it('带 SourceRef 的同一步 → 判成功', () => {
    const step = searchStep('s-1', 'attraction');
    const observation = observe(step, {
      ok: true,
      data: { pois: [] },
      sourceRefs: [
        {
          providerId: 'travel.poi',
          namespace: 'travel.poi',
          uri: 'fixture://travel/poi/sh/attraction',
          label: 'fixture',
          retrievedAt: '2026-01-01T00:00:00.000Z',
          isEstimate: true,
        },
      ],
      isEstimate: true,
      durationMs: 1,
    });
    expect(observation.kind).toBe('success');
  });
});

describe('travel · toProps 纯函数与安全降级', () => {
  const renderers = travelUI.stepRenderers;
  const step = makeStep({ id: 's-1', domainId: TRAVEL_DOMAIN_ID, type: POI_SEARCH_STEP_TYPE, title: '检索景点' });

  it('同一入参 → 同一 props（可重放、可单测）', () => {
    const payload = { city: '上海', category: 'attraction', categoryLabel: '景点', pois: listPois('上海', 'attraction', 2).pois, sourceRefs: [], goalSummary: HAPPY_GOAL };
    const first = renderers[POI_SEARCH_STEP_TYPE]!.toProps(payload, step, CTX);
    const second = renderers[POI_SEARCH_STEP_TYPE]!.toProps(payload, step, CTX);
    expect(first).toEqual(second);
    expect(Object.keys(first)[0]).toBe('title');
  });

  it('脏载荷 → 降级返回值（组件层还会再校验一次，绝不白屏）', () => {
    const degraded = renderers[POI_SEARCH_STEP_TYPE]!.toProps({ pois: 'not-an-array' }, step, CTX);
    expect(degraded).toMatchObject({
      title: '检索景点',
      items: [],
      sourceRefs: [],
      disclaimer: '结果格式异常，已降级为原始载荷',
    });

    const degradedItinerary = renderers[ITINERARY_COMPOSE_STEP_TYPE]!.toProps(undefined, step, CTX);
    expect(degradedItinerary).toMatchObject({ days: [], totalCostCNY: 0, overBudget: false });
  });

  it('ItineraryCard props：预算对照与超预算标记', () => {
    const payload = {
      city: '上海',
      days: [{ day: 1, theme: '第 1 天', items: [{ name: '外滩', category: 'attraction', categoryLabel: '景点', slot: '上午', priceCNY: 0, source: 'fixture://x' }], costCNY: 500 }],
      totalCostCNY: 500,
      budgetCNY: 300,
      sourceRefs: [],
      goalSummary: HAPPY_GOAL,
    };
    const props = renderers[ITINERARY_COMPOSE_STEP_TYPE]!.toProps(payload, step, CTX);
    expect(props.overBudget).toBe(true);
    expect(props.budgetCNY).toBe(300);

    const within = renderers[ITINERARY_COMPOSE_STEP_TYPE]!.toProps({ ...payload, budgetCNY: 900 }, step, CTX);
    expect(within.overBudget).toBe(false);
  });

  it('组件都注册了 zod schema 与 requiredProps', () => {
    expect(travelUI.components.map((component) => component.name).sort()).toEqual(['ItineraryCard', 'PoiCard']);
    for (const component of travelUI.components) {
      expect(component.schema).toBeDefined();
      expect(component.requiredProps).toContain('title');
      expect(component.lazy).toBe(true);
    }
    expect(travelUI.degradeChain).toEqual({
      rawPayload: 'RawPayloadCard',
      clarify: 'ClarifyOptions',
      error: 'ErrorState',
      skeleton: 'SkeletonList',
    });
  });
});

describe('travel · P0 / P1 回归锁（QA 独立验证发现的两个缺陷）', () => {
  it('★ P0：从步骤结果还原候选不得抛异常（事实里没有 city / address 也要能重算）', () => {
    // 早期实现把 city:'' / address:'' 硬塞给严格的 zTripPoi（两者都是 min(1)），
    // 于是「事实步骤已产出结果后发生重排」→ validateCurrent → 抛 ZodError
    // → 整条 run 打成 INTERNAL_ERROR。这条锁的是"重排路径不崩"。
    const records = [
      { name: '外滩', category: 'attraction', priceCNY: 0, source: 'fixture://x' },
      { name: '南翔馒头店', category: 'restaurant', priceCNY: 90, source: 'fixture://y' },
      { name: '全季酒店', category: 'hotel', priceCNY: 420, source: 'fixture://z' },
    ] as Parameters<typeof groupFactsByCategory>[0];

    let grouped!: FactBuckets;
    expect(() => {
      grouped = groupFactsByCategory(records);
    }).not.toThrow();

    expect(grouped.attraction).toHaveLength(1);
    expect(grouped.restaurant).toHaveLength(1);
    expect(grouped.hotel).toHaveLength(1);
    // 完整记录一条都不该被丢。
    expect(grouped.dropped).toBe(0);
  });

  it('★ 丢弃必须可观测：dropped 计数 + 条数守恒（dropped + 入桶 = 总数）', () => {
    const records = [
      { name: '有来源', category: 'attraction', priceCNY: 100, source: 'fixture://ok' },
      { name: '没来源', category: 'attraction', priceCNY: 9_999, source: '' },
      { name: '没类别', category: undefined, priceCNY: 5, source: 'fixture://ok' },
      { name: '', category: 'hotel', priceCNY: 1, source: 'fixture://ok' },
    ] as unknown as Parameters<typeof groupFactsByCategory>[0];

    const grouped = groupFactsByCategory(records);
    expect(grouped.attraction).toHaveLength(1);
    expect(grouped.attraction[0]?.priceCNY).toBe(100);
    // ★ 三条不可用（缺 source / 缺 category / 缺 name），而且**必须被数出来** ——
    // 静默丢弃会让成本算低 → 更容易通过预算校验，这是"悄悄放行"的暗门。
    expect(grouped.dropped).toBe(3);

    const used = TRIP_CATEGORIES.reduce((total, category) => total + grouped[category].length, 0);
    expect(grouped.dropped + used).toBe(records.length);
  });

  it('★ 丢弃会产出一条 warning 级违规（不阻断，但必须说出口）', () => {
    // 步骤结果里有一条缺 name 的记录：它带 source（不会被判无源），但还原不进桶。
    const plan = planOf([
      searchStep('s-1', 'attraction', { goalSummary: HAPPY_GOAL }),
      composeStep('s-2', { goalSummary: HAPPY_GOAL }, ['s-1']),
    ]);
    const step = plan.steps[0]!;
    step.status = 'done';
    step.result = {
      ok: true,
      data: {
        pois: [
          { name: '外滩', category: 'attraction', priceCNY: 0, source: 'fixture://ok', city: '上海', address: 'x', rating: 4.7, priceLevel: 1 },
          { name: '', category: 'attraction', priceCNY: 8_888, source: 'fixture://no-name' },
        ],
      },
      sourceRefs: [
        {
          providerId: 'travel.poi',
          namespace: 'travel.poi',
          uri: 'fixture://travel/poi/x',
          label: '行程候选 fixture · 上海 · 景点',
          retrievedAt: '2026-01-01T00:00:00.000Z',
          isEstimate: true,
        },
      ],
      isEstimate: true,
      durationMs: 1,
    };

    const result = validateTripPlan(plan);
    // warning 不阻断：ok 仍为 true（decideValidationAction 对 warning 返回 continue）
    expect(result.ok).toBe(true);
    const warnings = result.violations.filter((violation) => violation.severity === 'warning');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((violation) => String(violation.message).includes('未计入成本重算'))).toBe(
      true,
    );
  });

  it('★ 全部事实都被丢弃时：回落到 fixture 估算，绝不按"空桶 ¥0"放行超预算', () => {
    // 这是修 dropped 时顺带堵住的暗门：预筛旧逻辑会用空桶算出 ¥0，
    // 于是超预算的目标也能通过校验。现在必须回落到 fixture 的同口径估算。
    const plan = planOf([
      searchStep('s-1', 'attraction', { goalSummary: '上海三日游，预算 300' }),
      composeStep('s-2', { goalSummary: '上海三日游，预算 300' }, ['s-1']),
    ]);
    const step = plan.steps[0]!;
    step.status = 'done';
    step.result = {
      ok: true,
      data: { pois: [{ name: '', category: 'attraction', priceCNY: 0, source: 'fixture://x' }] },
      sourceRefs: [
        {
          providerId: 'travel.poi',
          namespace: 'travel.poi',
          uri: 'fixture://travel/poi/x',
          label: '行程候选 fixture · 上海 · 景点',
          retrievedAt: '2026-01-01T00:00:00.000Z',
          isEstimate: true,
        },
      ],
      isEstimate: true,
      durationMs: 1,
    };

    const result = validateTripPlan(plan);
    // 预算 300 << 上海 3 天口径总价 2435 → 仍然必须被拦下
    expect(result.ok).toBe(false);
    expect(
      result.violations.some(
        (violation) => violation.severity === 'error' && String(violation.message).includes('预算'),
      ),
    ).toBe(true);
  });

  it('★ P1：没写城市 / 写了不支持的城市 —— 两种回落都要标注，且文案必须能区分', () => {
    const unspecified = resolveTripBrief({ goalSummary: '帮我规划三日游，预算 5000 元' });
    const unsupported = resolveTripBrief({ goalSummary: '帮我规划杭州三日游，预算 5000 元' });
    const known = resolveTripBrief({ goalSummary: '帮我规划上海三日游，预算 5000 元' });

    expect(unspecified.cityFallback).toBe(true);
    expect(unspecified.cityFallbackReason).toBe('city-unspecified');
    expect(unsupported.cityFallback).toBe(true);
    expect(unsupported.cityFallbackReason).toBe('unsupported-city');
    expect(unsupported.requestedCity).toBe('杭州');
    expect(known.cityFallback).toBe(false);
    expect(known.cityFallbackReason).toBe('none');

    // 两种回落给出的说法必须不同 —— 否则用户分不清"你要的我们没有"和"你没说"。
    expect(CITY_FALLBACK_NOTE['unsupported-city']).not.toBe(CITY_FALLBACK_NOTE['city-unspecified']);
    expect(CITY_FALLBACK_NOTE['none']).toBe('');
  });

  it('★ P1：parseTripBrief 认得出"用户写了城市"，哪怕这座城市我们没数据', () => {
    // 用 CITY_HINTS（不是 POI_FIXTURES 的键）去目标里找城市：
    // 支持与否由 resolveCityName 另判。混用会让"写了杭州"塌缩成"没写城市"。
    expect(parseTripBrief('帮我规划杭州三日游').city).toBe('杭州');
    expect(parseTripBrief('帮我规划三日游').city).toBeNull();
    expect(parseTripBrief('帮我规划上海三日游').city).toBe('上海');
  });

  it('★ P1：城市名**不在** CITY_HINTS 里（喀什 / 火星）→ 仍要回落并标注，绝不静默', () => {
    // 第二层根因的回归锁：CITY_HINTS 决定"用户有没有写城市"，表外的地名一律认不出来。
    // 它的失败模式必须是**标注后回落**，而不是静默给假数据 —— 这点必须被锁住，
    // 否则将来有人改坏这张表（比如手滑删掉几个城市），已知城市会被误判成"未指定"。
    for (const goal of ['帮我规划喀什三日游，预算 5000 元', '帮我规划火星三日游，预算 5000 元']) {
      const brief = resolveTripBrief({ goalSummary: goal });
      expect(brief.cityFallback).toBe(true);
      expect(brief.cityFallbackReason).toBe('city-unspecified');
      expect(CITY_FALLBACK_NOTE[brief.cityFallbackReason].length).toBeGreaterThan(0);
    }

    // 反例：在表里的城市（哪怕我们没数据）必须被认成"用户写了城市"，两种回落不能塌缩。
    expect(resolveTripBrief({ goalSummary: '帮我规划杭州三日游' }).cityFallbackReason).toBe(
      'unsupported-city',
    );
  });

  it('★ CITY_HINTS 必须覆盖所有有数据的城市（改坏这张表 = 已知城市被误判成未指定）', () => {
    for (const city of Object.keys(POI_FIXTURES)) {
      expect(CITY_HINTS).toContain(city);
    }
  });

  it('★ P1：回落标注真的进到 SourceRef.label（不只是留在 TripBrief 里）', async () => {
    const providers = createTripProviders().create(CTX);
    const poi = providers['travel.poi']!;

    const fallback = await poi.search({ city: '上海', category: 'attraction', cityFallback: 'city-unspecified' }, CTX);
    const unsupported = await poi.search({ city: '上海', category: 'attraction', cityFallback: 'unsupported-city' }, CTX);
    const exact = await poi.search({ city: '上海', category: 'attraction' }, CTX);

    const label = (source: unknown): string =>
      (source as { label?: string } | null)?.label ?? '';

    expect(label(fallback.source)).toContain('目标未指定城市');
    expect(label(unsupported.source)).toContain('目标城市无样例数据');
    expect(label(exact.source)).not.toContain('回落');
    expect(label(exact.source)).not.toContain('目标未指定城市');
  });
});

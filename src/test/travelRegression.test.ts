/**
 * ★ travel 领域**回归锁**（QA · 严过关，M2 独立验收产出）。
 *
 * 本文件用例来自 M2 的独立验收，不是工程师自报的那 164 个。
 * 它锁住的是**工程师的测试没覆盖、而 QA 证伪打出来的两个真缺陷**：
 *
 * | 锁 | 缺陷 | 当时的表现 |
 * |----|------|-----------|
 * | **P0** | `groupFactsByCategory` 用宽松记录硬填 `city:''/address:''` 去喂严格的 `zTripPoi`（`min(1)`） | travel 下一旦发生重排就抛 `ZodError`，整条 run 以 `INTERNAL_ERROR` 结束 —— 「内核通用、重规划照常工作」是假的 |
 * | **P1** | 目标里的城市解析不出来时直接套默认城市，`cityFallback` 恒为 `false` | 用户要杭州 → 拿到上海数据，界面还写着「来源：…上海…」—— 把假数据包装成可溯源的真数据，反幻觉防线反成了造假装置 |
 *
 * 为什么必须留在仓库里：工程师的 164 个用例**一个都没抓到这两条**（P0 因为重排场景都在执行前被拦下，
 * `realFacts` 恒空；P1 因为 `grep "回落" src/test/` 当时返回空）。留下来它们就不会再溜回去。
 *
 * ★ 本文件由 QA 维护。改动 travel 领域包时若它变红，**先怀疑领域代码**。
 */
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@/shared/stream/events';
import type { Plan, Step } from '@/shared/plan/types';
import type { DomainPack, ToolSet } from '@/shared/domain/types';
import { runGoal, type EngineInput, type EngineResult } from '@/src/core/run/engine';
import { getDomainPack, registerDomainPack } from '@/src/core/registry/domainRegistry';
import { createMockRuntime, type MockRuntimeOptions } from '@/src/core/runtime/mock';
import { registerAllDomains } from '@/src/domains';
import { TRAVEL_DOMAIN_ID, travelMeta } from '@/src/domains/travel/meta';
import { ITINERARY_COMPOSE_STEP_TYPE, POI_SEARCH_STEP_TYPE } from '@/src/domains/travel/planning';
import {
  collectCompletedFacts,
  composeItinerary,
  groupFactsByCategory,
  listPois,
  resolveTripBrief,
  validateTripPlan,
  type TripCategory,
} from '@/src/domains/travel/providers';
import { travelTools } from '@/src/domains/travel/tools';
import { makePlan, makeStep } from './fixtures';

const [, TRAVEL_ID] = registerAllDomains();

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

/** 与领域模板同形的计划（三路检索 + 一次编排）。 */
function templatePlan(goal: string, extra: Record<string, unknown> = {}): Plan {
  const search = (id: string, category: string, limit: number): Step =>
    makeStep({
      id,
      domainId: TRAVEL_DOMAIN_ID,
      type: POI_SEARCH_STEP_TYPE,
      title: `检索 ${category}`,
      intent: {
        toolName: 'travel.poiSearch',
        input: { category, limit, goalSummary: goal, ...extra },
        producesFacts: true,
      },
    });
  return makePlan(
    [
      search('s-1', 'attraction', 4),
      search('s-2', 'restaurant', 4),
      search('s-3', 'hotel', 3),
      makeStep({
        id: 's-4',
        domainId: TRAVEL_DOMAIN_ID,
        type: ITINERARY_COMPOSE_STEP_TYPE,
        title: '编排每日行程',
        dependsOn: ['s-1', 's-2', 's-3'],
        intent: {
          toolName: 'travel.itineraryCompose',
          input: { goalSummary: goal, ...extra },
          producesFacts: false,
        },
      }),
    ],
    { domainId: TRAVEL_DOMAIN_ID },
  );
}

/** 校验口径下 上海 / 3 天 / limit 4 的预估总价（= 预算拦截的真实分界线）。 */
const SHANGHAI_3D_COST = composeItinerary({
  city: '上海',
  days: 3,
  limitPerCategory: 4,
}).totalCostCNY;

function codesOf(plan: Plan | null): string[] {
  return ((plan?.steps ?? []) as Step[]).map((step) => step.type);
}

function labelsOf(plan: Plan | null): string[] {
  return (plan?.steps ?? []).flatMap((step) =>
    (step.result?.sourceRefs ?? []).map((ref) => ref.label),
  );
}

/* ================================================================== *
 * 1. 预算拦截的**边界**（工程师只测了 300 与 3000 两个点）
 * ================================================================== */

describe('QA · 预算拦截边界', () => {
  it(`基准：上海 3 天 / limit 4 的口径总价 = ${SHANGHAI_3D_COST}`, () => {
    expect(SHANGHAI_3D_COST).toBeGreaterThan(0);
    // 口径与 fixture 表一致：8 条游玩 + 3 晚住宿
    expect(SHANGHAI_3D_COST).toBe(2435);
  });

  it('刚好超一点点（cost - 1）→ 必须拦', () => {
    const budget = SHANGHAI_3D_COST - 1;
    const result = validateTripPlan(templatePlan(`上海三日游，预算 ${budget} 元`));
    expect(result.ok).toBe(false);
    expect(String(result.violations.map((v) => v.message).join('|'))).toContain('预算');
  });

  it('★ 刚好卡在上限（cost）→ 不能误杀', () => {
    const budget = SHANGHAI_3D_COST;
    const result = validateTripPlan(templatePlan(`上海三日游，预算 ${budget} 元`));
    expect(result.violations).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('预算充裕（cost + 1 / 100000）→ 通过', () => {
    expect(validateTripPlan(templatePlan(`上海三日游，预算 ${SHANGHAI_3D_COST + 1} 元`)).ok).toBe(true);
    expect(validateTripPlan(templatePlan('上海三日游，预算 100000 元')).ok).toBe(true);
  });

  it('远超（预算 300）→ 拦；预算 0 → 也拦（不是被当成"没写预算"放过）', () => {
    expect(validateTripPlan(templatePlan('上海三日游，预算 300 元')).ok).toBe(false);
    expect(validateTripPlan(templatePlan('上海三日游，预算 0 元')).ok).toBe(false);
  });

  it('★ 端到端边界：cost - 1 → awaiting_user；cost → completed（不误杀）', async () => {
    const tight = await run(`上海三日游，预算 ${SHANGHAI_3D_COST - 1} 元`);
    expect(tight.result.status).toBe('awaiting_user');
    expect(tight.result.reason).toBe('VALIDATION_ASK_USER');

    const exact = await run(`上海三日游，预算 ${SHANGHAI_3D_COST} 元`);
    expect(exact.result.status).toBe('completed');
    expect((exact.result.plan?.steps ?? []).every((step) => step.status === 'done')).toBe(true);
  });

  it('未写预算的目标 → 不触发超预算（budgetCNY 为 null 时不比较）', () => {
    expect(resolveTripBrief({ goalSummary: '上海三日游' }).budgetCNY).toBeNull();
    expect(validateTripPlan(templatePlan('上海三日游')).ok).toBe(true);
  });
});

/* ================================================================== *
 * 2. 反幻觉：逐条 POI 缺 source 到底能不能拦住
 * ================================================================== */

describe('QA · 反幻觉覆盖', () => {
  it('★ step 级 SourceRef 齐全、但逐条 POI 缺 source → 校验器必须报错', () => {
    const leaked = makeStep({
      id: 's-1',
      domainId: TRAVEL_DOMAIN_ID,
      type: POI_SEARCH_STEP_TYPE,
      title: '检索景点',
      status: 'done',
      intent: {
        toolName: 'travel.poiSearch',
        input: { category: 'attraction', goalSummary: '上海三日游，预算 3000 元' },
        producesFacts: true,
      },
      result: {
        ok: true,
        data: {
          pois: [
            { name: '甲', category: 'attraction', priceCNY: 10 },
            { name: '乙', category: 'attraction', priceCNY: 20, source: '' },
          ],
        },
        sourceRefs: [
          {
            providerId: 'travel.poi',
            namespace: 'travel.poi',
            uri: 'fixture://travel/poi/上海/attraction',
            label: 'fixture',
            retrievedAt: '2026-01-01T00:00:00.000Z',
            isEstimate: true,
          },
        ],
        isEstimate: true,
        durationMs: 0,
      },
    });
    const plan = makePlan(
      [
        leaked,
        makeStep({
          id: 's-2',
          domainId: TRAVEL_DOMAIN_ID,
          type: ITINERARY_COMPOSE_STEP_TYPE,
          title: '编排',
          dependsOn: ['s-1'],
          intent: {
            toolName: 'travel.itineraryCompose',
            input: { goalSummary: '上海三日游，预算 3000 元' },
            producesFacts: false,
          },
        }),
      ],
      { domainId: TRAVEL_DOMAIN_ID },
    );

    const result = validateTripPlan(plan);
    expect(result.ok).toBe(false);
    expect(String(result.violations.map((v) => v.message).join('|'))).toContain('缺少来源');
  });

  /**
   * ★ 覆盖缺口探测：只抽掉"逐条 source"、保留 step 级 SourceRef。
   * Observer 只查 step 级 → step 成功；校验只在执行前 / 重排后跑 →
   * 若全程没有重排，这一轮会带着无源条目 completed。
   */
  it('★ 缺口探测：无源条目 + 全程无重排 → 是否会带着假数据跑完', async () => {
    const leakyTools: ToolSet = {};
    for (const [name, spec] of Object.entries(travelTools)) {
      leakyTools[name] = {
        ...spec,
        async execute(input: never, ctx: Parameters<typeof spec.execute>[1]) {
          const base = await spec.execute(input, ctx);
          const data = base.data as { pois?: Array<Record<string, unknown>> } | undefined;
          if (!Array.isArray(data?.pois)) return base;
          return {
            ...base,
            data: {
              ...(data as Record<string, unknown>),
              pois: data.pois.map(({ source: _source, ...rest }) => rest),
            },
          };
        },
      };
    }
    const leakyPack: DomainPack = {
      meta: { ...travelMeta, id: 'travel-nosrc-item', displayName: 'travel（逐条无源注入）' },
      tools: leakyTools,
      providers: (await import('@/src/domains/travel/providers')).createTripProviders(),
      ui: (await import('@/src/domains/travel/ui')).travelUI,
      prompts: (await import('@/src/domains/travel/prompts')).travelPrompts,
      planning: (await import('@/src/domains/travel/planning')).travelPlanning,
      evaluation: (await import('@/src/domains/travel/evaluation')).travelEvaluation,
    };
    expect(registerDomainPack(leakyPack).ok).toBe(true);

    const { result } = await run('帮我规划上海三日游，预算 3000 元', {
      domainId: 'travel-nosrc-item',
    });

    // 记录事实：这个结果是"通过"还是"被拦住"，由人来判断是不是缺口。
    const unsourced = (result.plan?.steps ?? []).flatMap((step) => {
      const pois = (step.result?.data as { pois?: Array<{ source?: string }> } | undefined)?.pois ?? [];
      return pois.filter((poi) => typeof poi.source !== 'string' || poi.source.length === 0);
    });

     
    console.log(
      `[QA-探针] 逐条无源注入 → status=${result.status} reason=${result.reason ?? '-'} ` +
        `无源条目数=${unsourced.length}`,
    );
    expect(result.status).toBe('completed');
    expect(unsourced.length).toBeGreaterThan(0);
  });
});

/* ================================================================== *
 * 3. 未知城市回落：标注真的存在吗
 * ================================================================== */

/**
 * 是否"被标注"：**不绑定具体文案**。
 * 领域侧现在有两种回落说明（无样例数据 / 未指定城市），只要挂了任何一种就算达标；
 * 两种文案是否**能区分**，由下面「P1 回归锁」那一组单独锁。
 */
const isAnnotated = (plan: Plan | null): boolean =>
  labelsOf(plan).some((label) => label.includes('回落') || label.includes('默认'));

describe('QA · 未知城市回落标注', () => {
  it('★ 端到端：未知城市 → 落到默认城市且**必须被标注**', async () => {
    const { result } = await run('帮我规划火星三日游，预算 5000 元');
    expect(result.status).toBe('completed');

    const labels = labelsOf(result.plan);
    expect(labels.length).toBeGreaterThan(0);
    expect(isAnnotated(result.plan)).toBe(true);
    // 回落后城市必须是默认城市，不能是用户写的"火星"
    expect(labels.some((label) => label.includes('火星'))).toBe(false);
  });

  it('目标完全没写城市 → 同样回落并标注', async () => {
    const { result } = await run('帮我规划三日游，预算 5000 元');
    expect(result.status).toBe('completed');
    expect(isAnnotated(result.plan)).toBe(true);
  });

  it('已知城市 → 一个字都不许标', async () => {
    const { result } = await run('帮我规划北京三日游，预算 5000 元');
    expect(isAnnotated(result.plan)).toBe(false);
    expect(listPois('北京', 'attraction', 4).fallback).toBe(false);
  });
});

/* ================================================================== *
 * 4. 内核通用性：travel 下的重规划 / demo 回归 / 注册表
 * ================================================================== */

describe('QA · 内核通用性', () => {
  it('★ travel + simulate:fatal → 重规划与闸门照常工作', async () => {
    const { result, events } = await run('帮我规划成都二日游，预算 4000 元', {
      simulate: 'fatal',
    });
    const replanning = events.filter(
      (event) => event.type === 'plan_status' && event.status === 'replanning',
    );
    expect(replanning.length).toBeGreaterThan(0);
    expect(result.plan?.revision).toBeGreaterThanOrEqual(2);
    // 重排后要么跑完，要么被闸门拦下（都有明确 reason）—— 不能是"静默成功"
    expect(['completed', 'failed']).toContain(result.status);
     
    console.log(
      `[QA-探针] travel+fatal → status=${result.status} reason=${result.reason ?? '-'} ` +
        `revision=${result.plan?.revision}`,
    );
  });

  it('travel + replanMode:stagnant + fatal → NO_CONVERGENCE 闸门在 travel 下也生效', async () => {
    const { result } = await run('帮我规划成都二日游，预算 4000 元', { simulate: 'fatal' }, {
      replanMode: 'stagnant',
    });
     
    console.log(`[QA-探针] travel+stagnant+fatal → status=${result.status} reason=${result.reason ?? '-'}`);
    expect(result.status).toBe('failed');
  });

  it('★ demo 回归：不带 domainId → 默认领域仍是 demo 且能跑完', async () => {
    const events: StreamEvent[] = [];
    const result = await runGoal(
      { goal: '帮我把这件事拆成计划并一步步执行：两路采集后汇总成一版结论，预算不超过 500 元，三天内完成' },
      {
        runtime: createMockRuntime({ latencyMs: 0 }),
        emit: (event) => events.push(event),
        sleep: async () => undefined,
        streamDelayMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      },
    );
    expect(result.plan?.domainId).toBe('demo');
    expect(result.status).toBe('completed');
    expect(codesOf(result.plan)).not.toContain(POI_SEARCH_STEP_TYPE);
  });

  it('★ 注册表：demo 与 travel 同时可解析（UI 切领域不会找不到包）', () => {
    expect(getDomainPack('demo')).toBeDefined();
    expect(getDomainPack(TRAVEL_DOMAIN_ID)).toBeDefined();
    expect(registerAllDomains()[0]).toBe('demo');
  });

  it('★ DAYS_MISMATCH 在端到端里是否可达：模板步骤 input 里根本没有 days 字段', async () => {
    const { result } = await run('帮我规划上海三日游，预算 3000 元');
    const inputs = (result.plan?.steps ?? []).map((step) => step.intent?.input ?? {});
    const hasDays = inputs.some((input) => typeof (input as { days?: unknown }).days === 'number');
     
    console.log(`[QA-探针] e2e 步骤 input 中含 days 字段 = ${hasDays}`);
    expect(hasDays).toBe(false);
  });
});

/* ================================================================== *
 * 5. 事件时间线取证（与 /api/run 同一条 runGoal 代码路径，只差 HTTP 分帧）
 * ================================================================== */

function timeline(events: StreamEvent[]): string {
  return events
    .map((event) => {
      switch (event.type) {
        case 'plan_start':
          return `plan_start(domain=${event.domainId},rev=${event.revision})`;
        case 'plan_status':
          return `plan_status:${event.status}#${event.revision}`;
        case 'step_add':
          return `step_add(${event.step.id}:${event.step.type})`;
        case 'step_status':
          return `step_status(${event.stepId}:${event.status}${event.reason ? '/' + event.reason : ''})`;
        case 'component_start':
          return `component_start(${event.component})`;
        case 'component_props_delta':
          return `props_delta(${event.nodeId})`;
        case 'component_end':
          return `component_end(${event.nodeId})`;
        case 'error':
          return `error(${event.message})`;
        case 'done':
          return `done(${event.status}${event.reason ? '/' + event.reason : ''})`;
        default:
          return (event as { type: string }).type;
      }
    })
    .join(' → ');
}

describe('QA · 事件时间线取证', () => {
  it('① travel 正常路径', async () => {
    const { result, events } = await run('帮我规划上海三日游，预算 3000 元，想逛景点也吃本地菜');
     
    console.log(`[QA-时间线 ①] ${result.status}\n${timeline(events)}`);
    expect(result.status).toBe('completed');
  });

  it('② travel 超预算拦截', async () => {
    const { result, events } = await run('上海三日游，预算 300');
     
    console.log(`[QA-时间线 ②] ${result.status}/${result.reason}\n${timeline(events)}`);
    expect(result.status).toBe('awaiting_user');
  });

  it('③ travel 未知城市（杭州）→ 看看 UI 上呈现的是哪座城市', async () => {
    const { result } = await run('帮我规划杭州三日游，预算 5000 元');
    const cities = (result.plan?.steps ?? [])
      .map((step) => (step.result?.data as { city?: string } | undefined)?.city)
      .filter((city): city is string => typeof city === 'string');
     
    console.log(
      `[QA-时间线 ③] status=${result.status} 用户要"杭州"，实际返回城市=${[...new Set(cities)].join(',') || '-'}`,
    );
    expect(result.status).toBe('completed');
  });

  it('④ travel + simulate:fatal（重规划路径）—— P0 回归锁：修复后**不得**再抛异常', async () => {
    const events: StreamEvent[] = [];
    let thrown: string | null = null;
    let status = '-';
    try {
      const result = await runGoal(
        { goal: '帮我规划成都二日游，预算 4000 元', domainId: TRAVEL_ID, simulate: 'fatal' },
        {
          runtime: createMockRuntime({ latencyMs: 0 }),
          emit: (event) => events.push(event),
          sleep: async () => undefined,
          streamDelayMs: 0,
          now: () => new Date('2026-01-01T00:00:00.000Z'),
        },
      );
      status = `${result.status}/${result.reason ?? '-'}`;
    } catch (error) {
      thrown = error instanceof Error ? error.constructor.name + ': ' + error.message.split('\n')[0] : String(error);
    }
     
    console.log(
      `[QA-时间线 ④] status=${status} thrown=${thrown ?? '无'}\n${timeline(events)}`,
    );
    // ★ P0 回归：不再抛异常；且必须自己走到终态（不能靠 route.ts 兜底成 INTERNAL_ERROR）。
    expect(thrown).toBeNull();
    expect(status).toBe('completed/-');
    expect(events.some((event) => event.type === 'done' && event.status === 'completed')).toBe(true);
  });
});

/* ================================================================== *
 * 6. P0 / P1 回归锁（修复后必须转绿；转绿后本文件改名 travelRegression.test.ts）
 * ================================================================== */

/** 一步"已完成"的事实检索步骤，结果 = 真实 fixture 数据（走 P0 崩溃那条路径）。 */
function doneSearchStep(
  id: string,
  category: TripCategory,
  limit: number,
  goal: string,
  extraPois: Array<Record<string, unknown>> = [],
): Step {
  const pois = [...listPois('上海', category, limit).pois, ...extraPois];
  return makeStep({
    id,
    domainId: TRAVEL_DOMAIN_ID,
    type: POI_SEARCH_STEP_TYPE,
    title: `检索 ${category}`,
    status: 'done',
    intent: {
      toolName: 'travel.poiSearch',
      input: { category, limit, goalSummary: goal },
      producesFacts: true,
    },
    result: {
      ok: true,
      data: { pois },
      sourceRefs: [
        {
          providerId: 'travel.poi',
          namespace: 'travel.poi',
          uri: `fixture://travel/poi/上海/${category}`,
          label: `行程候选 fixture · 上海 · ${category}`,
          retrievedAt: '2026-01-01T00:00:00.000Z',
          isEstimate: true,
        },
      ],
      isEstimate: true,
      durationMs: 0,
    },
  });
}

/** 三路检索都已完成的计划（P0 的触发形状：realFacts 非空）。 */
function executedPlan(goal: string, extraPois: Array<Record<string, unknown>> = []): Plan {
  return makePlan(
    [
      doneSearchStep('s-1', 'attraction', 4, goal, extraPois),
      doneSearchStep('s-2', 'restaurant', 4, goal, extraPois),
      doneSearchStep('s-3', 'hotel', 3, goal, extraPois),
      makeStep({
        id: 's-4',
        domainId: TRAVEL_DOMAIN_ID,
        type: ITINERARY_COMPOSE_STEP_TYPE,
        title: '编排每日行程',
        dependsOn: ['s-1', 's-2', 's-3'],
        intent: {
          toolName: 'travel.itineraryCompose',
          input: { goalSummary: goal },
          producesFacts: false,
        },
      }),
    ],
    { domainId: TRAVEL_DOMAIN_ID },
  );
}

describe('QA · P0 回归锁（重排后按真实事实重算成本）', () => {
  it('★ 真实事实 → 重算成本**不得**抛异常，且必须等于 2435（不偏低、不漂移）', () => {
    const plan = executedPlan('上海三日游，预算 3000 元');
    const facts = collectCompletedFacts(plan);
    expect(facts.records.length).toBeGreaterThan(0);

    const grouped = groupFactsByCategory(facts.records);
    const total = composeItinerary({
      city: '上海',
      days: 3,
      limitPerCategory: 4,
      pois: grouped,
    }).totalCostCNY;

     
    console.log(`[QA-P0 回归] 真实事实重算总价 = ${total}（期望 2435）`);
    expect(total).toBe(SHANGHAI_3D_COST);
  });

  it('★ 混入"字段不全但有 source"的条目 → 不崩、不静默把成本算低', () => {
    // 这条记录有 source（不会被判无源），但没有 city / address —— 正是 P0 的触发形状。
    const partial = { name: '半条数据酒店', category: 'hotel', priceCNY: 9999, source: 'fixture://partial' };
    const plan = executedPlan('上海三日游，预算 3000 元', [partial]);
    const facts = collectCompletedFacts(plan);
    const grouped = groupFactsByCategory(facts.records);
    const total = composeItinerary({ city: '上海', days: 3, limitPerCategory: 4, pois: grouped }).totalCostCNY;

     
    // 注：这条 9999 的记录被三路步骤各带了一份，会挤进酒店池并顶掉真实住宿，
    // 所以总价高于基线是**预期**的 —— 本用例验的是"不崩 + 不静默算低"，不是精确值；
    // 精确值是否漂移由上一个用例（干净事实 → 2435）锁住。
    console.log(
      `[QA-P0 回归] 混入半条数据后总价 = ${total}（基线 ${SHANGHAI_3D_COST}，注入 9999×3 故偏高属预期）`,
    );
    // 要么被接受（+9999 房费），要么被显式跳过（=2435）—— 但绝不能归零、也不能低于基线。
    expect(total).toBeGreaterThanOrEqual(SHANGHAI_3D_COST);
  });

  it('★ 超预算不因"跳过条目"而误放行：真实事实 + 预算 300 → 仍是 error', () => {
    const plan = executedPlan('上海三日游，预算 300 元');
    const result = validateTripPlan(plan);
    expect(result.ok).toBe(false);
    expect(String(result.violations.map((v) => v.message).join('|'))).toContain('预算');
  });

  it('★ 预算 2435 + 真实事实 → 仍不误杀（修复没有把成本算高）', () => {
    const plan = executedPlan('上海三日游，预算 2435 元');
    expect(validateTripPlan(plan).ok).toBe(true);
  });

  it('★ 端到端：travel + simulate:fatal 走完重排到达 completed（不是 INTERNAL_ERROR）', async () => {
    const { result, events } = await run('帮我规划成都二日游，预算 4000 元', { simulate: 'fatal' });
     
    console.log(`[QA-P0 回归] e2e fatal → ${result.status}/${result.reason ?? '-'} revision=${result.plan?.revision}`);
    expect(result.status).toBe('completed');
    expect(result.reason).toBeUndefined();
    expect(
      events.some((event) => event.type === 'plan_status' && event.status === 'replanning'),
    ).toBe(true);
    expect(result.plan?.revision).toBeGreaterThanOrEqual(2);
  });
});

/**
 * 反幻觉的**升级版**：不只是"来的数据要可溯源"，**被丢掉的数据也要说出口**。
 *
 * 被 `groupFactsByCategory` 丢弃的条目不进成本重算 → 总价偏低 → 校验更容易通过。
 * 这与 P1「悄悄换城市不给标注」是同一类失败模式：**静默就是造假**。
 * 「丢得少」不构成豁免理由 —— 只要 dropped 不是 0，暗门就在。
 */
describe('QA · 反幻觉升级版（丢弃必须可见）', () => {
  /** 有合法 source、但**缺 name** 的记录：会被丢弃，其 priceCNY 不计入总价。 */
  const NO_NAME = { category: 'hotel', priceCNY: 9999, source: 'fixture://partial' };

  it('★ 部分记录缺字段被丢弃 → 必须产出 warning，且不阻断执行', () => {
    const plan = executedPlan('上海三日游，预算 3000 元', [NO_NAME]);
    const grouped = groupFactsByCategory(collectCompletedFacts(plan).records);

    expect(grouped.dropped).toBeGreaterThan(0);

    const result = validateTripPlan(plan);
    const messages = result.violations.map((violation) => String(violation.message));
    const codes = result.violations.map((violation) => String(violation.code));

     
    console.log(`[QA-丢弃可见] dropped=${grouped.dropped} codes=${codes.join(',')} ok=${result.ok}`);

    expect(codes).toContain('FACTS_DROPPED');
    expect(messages.some((message) => message.includes('未计入'))).toBe(true);
    // warning 级：不阻断执行（否则一条脏数据就能卡死整轮）
    expect(
      result.violations.find((violation) => String(violation.code) === 'FACTS_DROPPED')?.severity,
    ).toBe('warning');
    expect(result.ok).toBe(true);
  });

  it('★ 被丢弃的条目确实没进总价 —— 这就是"校验更容易通过"的暗门', () => {
    const droppedTotal = composeItinerary({
      city: '上海',
      days: 3,
      limitPerCategory: 4,
      pois: groupFactsByCategory(
        collectCompletedFacts(executedPlan('上海三日游，预算 3000 元', [NO_NAME])).records,
      ),
    }).totalCostCNY;

    // 对照组：同样的 9999，但**有 name**（字段齐全）→ 会被计入
    const keptTotal = composeItinerary({
      city: '上海',
      days: 3,
      limitPerCategory: 4,
      pois: groupFactsByCategory(
        collectCompletedFacts(
          executedPlan('上海三日游，预算 3000 元', [
            { ...NO_NAME, name: '半条数据酒店' },
          ]),
        ).records,
      ),
    }).totalCostCNY;

     
    console.log(`[QA-丢弃可见] 缺 name → 总价 ${droppedTotal}；有 name → 总价 ${keptTotal}`);
    expect(droppedTotal).toBe(SHANGHAI_3D_COST);
    expect(droppedTotal).toBeLessThan(keptTotal);
  });

  it('★ 对照组：干净事实 → dropped 为 0，且绝不出现 FACTS_DROPPED', () => {
    const plan = executedPlan('上海三日游，预算 3000 元');
    expect(groupFactsByCategory(collectCompletedFacts(plan).records).dropped).toBe(0);
    const codes = validateTripPlan(plan).violations.map((violation) => String(violation.code));
    expect(codes).not.toContain('FACTS_DROPPED');
  });
});

describe('QA · P1 回归锁（回落标注）', () => {
  /** 取出本轮所有 SourceRef.label 里的"回落标记"（没有则为空串）。 */
  const markerOf = (plan: Plan | null): string =>
    labelsOf(plan).find((label) => label.includes('回落') || label.includes('默认')) ?? '';

  it('★ (a) 指定了不被支持的城市（杭州）→ 必须标注回落', async () => {
    const { result } = await run('帮我规划杭州三日游，预算 5000 元');
    const brief = resolveTripBrief({ goalSummary: '帮我规划杭州三日游，预算 5000 元' });
     
    console.log(
      `[QA-P1 回归] 杭州 → cityFallback=${brief.cityFallback} city=${brief.city} requestedCity=${brief.requestedCity} marker="${markerOf(result.plan)}"`,
    );
    expect(brief.cityFallback).toBe(true);
    expect(markerOf(result.plan)).not.toBe('');
  });

  it('★ (b) 完全没写城市 → 也必须标注（与 (a) 的文案要能区分）', async () => {
    const { result } = await run('帮我规划三日游，预算 5000 元');
    const brief = resolveTripBrief({ goalSummary: '帮我规划三日游，预算 5000 元' });
    const marker = markerOf(result.plan);
     
    console.log(`[QA-P1 回归] 未指定 → cityFallback=${brief.cityFallback} marker="${marker}"`);
    expect(brief.cityFallback).toBe(true);
    expect(marker).not.toBe('');
  });

  it('★ (a) 与 (b) 是两种不同的回落，文案必须能区分', async () => {
    const unknown = await run('帮我规划杭州三日游，预算 5000 元');
    const unspecified = await run('帮我规划三日游，预算 5000 元');
    expect(markerOf(unknown.result.plan)).not.toBe(markerOf(unspecified.result.plan));
  });

  it('★ (c) 已知城市（上海 / 北京）→ 一个字都不许标', async () => {
    for (const goal of ['帮我规划上海三日游，预算 3000 元', '帮我规划北京三日游，预算 5000 元']) {
      const { result } = await run(goal);
      expect(markerOf(result.plan)).toBe('');
    }
  });

  /**
   * ★ 安全不变量（**不锁具体文案，只锁"必须被标注"**）：
   * 只要用户点了我们没数据的城市，就必须挂回落说明 —— 绝不能退化成 P1 那种
   * "静默给假数据还带着来源"。
   *
   * 领域侧用 `CITY_HINTS`（手写地名表）判断"用户有没有写城市"，表外的地名
   * （喀什 / 火星）会被当成"没写城市"、文案不精确 —— 这是**已知债**，可接受，
   * 但**绝不允许**退化成"不标注"。下面三个用例锁的正是这条底线。
   */
  it('★ 安全不变量：任何"我们没数据的城市"都必须被标注（表内 / 表外都不许静默）', async () => {
    for (const city of ['广州', '西安', '三亚']) {
      const { result } = await run(`帮我规划${city}三日游，预算 5000 元`);
      const brief = resolveTripBrief({ goalSummary: `帮我规划${city}三日游，预算 5000 元` });
       
      console.log(`[QA-P1 安全不变量] ${city}（表内）→ reason=${brief.cityFallbackReason} cityFallback=${brief.cityFallback}`);
      expect(brief.cityFallback).toBe(true);
      expect(isAnnotated(result.plan)).toBe(true);
    }
  });

  it('★ 安全不变量：城市名不在 CITY_HINTS 里（喀什 / 火星）→ 文案可能不精确，但仍必须被标注', async () => {
    for (const city of ['喀什', '火星']) {
      const { result } = await run(`帮我规划${city}三日游，预算 5000 元`);
      const brief = resolveTripBrief({ goalSummary: `帮我规划${city}三日游，预算 5000 元` });
       
      console.log(`[QA-P1 安全不变量] ${city}（表外）→ reason=${brief.cityFallbackReason} cityFallback=${brief.cityFallback}`);
      // 底线：不管归到哪一类，都必须标注；且实际返回的是默认城市，不是用户写的那个。
      expect(brief.cityFallback).toBe(true);
      expect(isAnnotated(result.plan)).toBe(true);
      expect(brief.city).toBe('上海');
    }
  });
});

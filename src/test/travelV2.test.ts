/**
 * travel v2 回归锁（设计 §9 T03 / T04）。
 *
 * 三条主线：
 * 1. **Q-1 顺序（专门验收 A）**：未识别图的第一动作必须是工具澄清，不是 error；
 * 2. **error 兜底触发条件（专门验收 B）**：步骤还在 pending / 用户已选 skip 时都不得报 `IMAGE_UNRESOLVED`；
 * 3. 覆盖度四态 / `origin` / 填充占比 / markdown blocks / `@` 三态的端到端行为。
 *
 * ★ 断言一律锁**语义**（status / code / patch path / state / ratio），不锁文案字面量。
 */
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@/shared/stream/events';
import type { Attachment } from '@/shared/plan/types';
import type { RuntimeAdapter } from '@/src/core/runtime/adapter';
import { runGoal, type EngineInput, type EngineResult } from '@/src/core/run/engine';
import { createMockRuntime, createDefaultMockScript } from '@/src/core/runtime/mock';
import { registerAllDomains } from '@/src/domains';
import { TRAVEL_DOMAIN_ID } from '@/src/domains/travel/meta';
import { IMAGE_FIRST_TEMPLATE_ID, IMAGE_UNDERSTAND_STEP_TYPE } from '@/src/domains/travel/planning';
import {
  UNRESOLVED_ACTION_FIELD,
  SKIP_OPTION_ID,
  MENTION_ACTION_FIELD,
  IGNORE_MENTION_OPTION_ID,
  IMAGE_QUESTION_ID,
  BRIEF_QUESTION_ID,
  travelTools,
} from '@/src/domains/travel/tools';
import { composeItineraryV2, validateTripPlan } from '@/src/domains/travel/providers';
import { makePlan, makeStep } from './fixtures';
import { makeFormKey } from '@/shared/plan/types';
import { zRunContext } from '@/shared/run/types';

const [, TRAVEL_ID] = registerAllDomains();

const IMAGE_QUESTION_PREFIX = IMAGE_QUESTION_ID;

function attachment(id: string, name: string): Attachment {
  return { id, kind: 'image', name };
}

const CTX = zRunContext.parse({
  runId: 'run-v2',
  traceId: 'trace-v2',
  goalId: 'goal-v2',
  domainId: TRAVEL_DOMAIN_ID,
  revision: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  deadlineAt: '2026-01-01T00:00:25.000Z',
  signals: ['text', 'image'],
  meta: { simulate: 'none', answers: {} },
});

/**
 * ★ MockRuntime 只回放 `templates[0]`，而 `templates[0]` 必须是 `travel.basic`
 * （既有回归锁断言首轮 4 步）。这里注入一个"选图片模板"的 script，
 * **不动 `src/core`** 就能端到端跑图片链路。
 */
function imageFirstRuntime(): RuntimeAdapter {
  const base = createDefaultMockScript();
  return createMockRuntime({
    latencyMs: 0,
    script: {
      plan: (request, ctx) =>
        base.plan(
          {
            ...request,
            templates: request.templates.filter((item) => item.id === IMAGE_FIRST_TEMPLATE_ID),
          },
          ctx,
        ),
      replan: (request, ctx) => base.replan(request, ctx),
      tool: (call, ctx) => base.tool(call, ctx),
    },
  });
}

async function run(
  goal: string,
  overrides: Partial<EngineInput> = {},
): Promise<{ result: EngineResult; events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  const result = await runGoal(
    { goal, simulate: 'none', domainId: TRAVEL_ID, ...overrides },
    {
      runtime: imageFirstRuntime(),
      emit: (event) => events.push(event),
      sleep: async () => undefined,
      streamDelayMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    },
  );
  return { result, events };
}

/** 取出 ClarifyOptions 的 props patch（按 JSON Patch 的 `add /fields/-` 还原）。 */
function clarifyFieldValues(events: StreamEvent[]): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.type !== 'component_props_delta') continue;
    for (const operation of event.patch) {
      if (operation.op === 'add' && operation.path === '/fields/-') {
        values.push(operation.value as Record<string, unknown>);
      }
    }
  }
  return values;
}

/* ------------------------------------------------------------------ *
 * ★ 专门验收 A：Q-1 顺序
 * ------------------------------------------------------------------ */

describe('★ 验收 A · 未识别图的第一动作是澄清，不是 error', () => {
  it('① 第一个到 UI 的动作是 awaiting_user + 带 fields 的 ClarifyOptions，不是 error', async () => {
    const { result, events } = await run('帮我规划上海三日游，预算 3000 元', {
      attachments: [attachment('u-1', 'IMG_9001.jpg'), attachment('u-2', 'IMG_9002.jpg')],
    });

    expect(result.status).toBe('awaiting_user');
    expect(result.reason).toBe('STEP_AWAITING_USER');
    // ★ 反向断言：绝不能先出现 error 事件（那意味着"跳过"这条路径变成了不可达代码）。
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);

    const clarify = events.find(
      (event) => event.type === 'component_start' && event.component === 'ClarifyOptions',
    );
    expect(clarify).toBeDefined();
    // 第一个到达 UI 的组件就是 ClarifyOptions（不是任何领域卡片）。
    const firstComponent = events.find((event) => event.type === 'component_start');
    expect(firstComponent?.type === 'component_start' && firstComponent.component).toBe(
      'ClarifyOptions',
    );
    expect(clarifyFieldValues(events).length).toBeGreaterThan(0);
  });

  it('② 表单里存在「跳过这 N 张」选项，且**未预选**', async () => {
    const { events } = await run('帮我规划上海三日游，预算 3000 元', {
      attachments: [attachment('u-1', 'IMG_9001.jpg'), attachment('u-2', 'IMG_9002.jpg')],
    });

    const fields = clarifyFieldValues(events);
    const action = fields.find((field) => field['id'] === UNRESOLVED_ACTION_FIELD);
    expect(action).toBeDefined();

    const options = (action?.['options'] ?? []) as Array<Record<string, string>>;
    const skip = options.find((option) => option['id'] === SKIP_OPTION_ID);
    expect(skip).toBeDefined();
    expect(skip?.['label']).toContain('跳过');

    // ★ 未预选：多选项字段没有 default，且 required=false（不选就继续停在 awaiting_user）。
    expect(action?.['default']).toBeUndefined();
    expect(action?.['required']).toBe(false);
  });

  it('③ 不选跳过 → 仍然停在 awaiting_user（不静默放行）', async () => {
    const attachments = [attachment('u-1', 'IMG_9001.jpg'), attachment('u-2', 'IMG_9002.jpg')];
    const { result: first } = await run('帮我规划上海三日游，预算 3000 元', { attachments });
    const plan = first.plan;
    expect(plan).toBeDefined();
    const imageStep = plan!.steps.find((step) => step.type === IMAGE_UNDERSTAND_STEP_TYPE);
    expect(imageStep).toBeDefined();

    // 用户选了「我改天补图」而不是「跳过」→ 工具下一轮仍然要澄清。
    const { result: second } = await run('帮我规划上海三日游，预算 3000 元', {
      attachments,
      resumePlan: plan,
      edit: { kind: 'retryStep', stepId: imageStep!.id },
      answers: { [makeFormKey(IMAGE_QUESTION_PREFIX, UNRESOLVED_ACTION_FIELD)]: JSON.stringify(['later']) },
    });

    expect(second.status).toBe('awaiting_user');
    expect(second.reason).toBe('STEP_AWAITING_USER');
  });

  it('★ 反向：选了跳过 → 下一轮放行并跑完（跳过这条路径真的可达）', async () => {
    const attachments = [attachment('u-1', 'IMG_9001.jpg'), attachment('u-2', 'IMG_9002.jpg')];
    const { result: first } = await run('帮我规划上海三日游，预算 3000 元', { attachments });
    const plan = first.plan!;
    const imageStep = plan.steps.find((step) => step.type === IMAGE_UNDERSTAND_STEP_TYPE)!;

    const { result: second } = await run('帮我规划上海三日游，预算 3000 元', {
      attachments,
      resumePlan: plan,
      edit: { kind: 'retryStep', stepId: imageStep.id },
      answers: {
        [makeFormKey(IMAGE_QUESTION_PREFIX, UNRESOLVED_ACTION_FIELD)]: JSON.stringify([SKIP_OPTION_ID]),
      },
    });

    expect(second.status).toBe('completed');
    const skippedStep = second.plan!.steps.find((step) => step.type === IMAGE_UNDERSTAND_STEP_TYPE);
    const data = skippedStep?.result?.data as { skippedAssetIds?: string[] } | undefined;
    expect(data?.skippedAssetIds ?? []).toEqual(['u-1', 'u-2']);
  });
});

/* ------------------------------------------------------------------ *
 * ★ 专门验收 B：error 兜底的触发条件
 * ------------------------------------------------------------------ */

describe('★ 验收 B · IMAGE_UNRESOLVED 只在两种情况下报 error', () => {
  const unresolvedResult = {
    ok: true,
    data: { identified: [], unresolved: ['u-1'], skippedAssetIds: [], mentions: { unresolvedTokens: [] } },
    sourceRefs: [
      {
        providerId: 'travel.vision',
        namespace: 'travel.vision',
        label: 'x',
        retrievedAt: '2026-01-01T00:00:00.000Z',
        isEstimate: true,
      },
    ],
    isEstimate: true,
    durationMs: 0,
  };

  const ctxWithImages = zRunContext.parse({ ...CTX, attachments: [attachment('u-1', 'IMG_9001.jpg')] });

  it('步骤仍在 pending → 不得报（澄清还没走完，不能替用户判定）', () => {
    const plan = makePlan([
      makeStep({
        id: 's-img',
        type: IMAGE_UNDERSTAND_STEP_TYPE,
        status: 'pending',
        intent: { toolName: 'travel.imageUnderstand', input: {}, producesFacts: true },
        result: unresolvedResult,
      }),
    ]);
    const result = validateTripPlan(plan, ctxWithImages);
    expect(result.violations.map((v) => v.code)).not.toContain('IMAGE_UNRESOLVED');
    expect(result.ok).toBe(true);
  });

  it('用户已选 skip → 不得报', () => {
    const plan = makePlan([
      makeStep({
        id: 's-img',
        type: IMAGE_UNDERSTAND_STEP_TYPE,
        status: 'done',
        intent: { toolName: 'travel.imageUnderstand', input: {}, producesFacts: true },
        result: {
          ...unresolvedResult,
          data: { ...unresolvedResult.data, skippedAssetIds: ['u-1'] },
        },
      }),
    ]);
    const result = validateTripPlan(plan, ctxWithImages);
    expect(result.violations.map((v) => v.code)).not.toContain('IMAGE_UNRESOLVED');
  });

  it('① 澄清无果（done 且 unresolved 非空且无 skip）→ 报 error', () => {
    const plan = makePlan([
      makeStep({
        id: 's-img',
        type: IMAGE_UNDERSTAND_STEP_TYPE,
        status: 'done',
        intent: { toolName: 'travel.imageUnderstand', input: {}, producesFacts: true },
        result: unresolvedResult,
      }),
    ]);
    const result = validateTripPlan(plan, ctxWithImages);
    expect(result.violations.map((v) => v.code)).toContain('IMAGE_UNRESOLVED');
    expect(result.ok).toBe(false);
  });

  it('② 澄清路径不可用：步骤 failed / 根本没有该步骤 → 报 error', () => {
    const failed = makePlan([
      makeStep({
        id: 's-img',
        type: IMAGE_UNDERSTAND_STEP_TYPE,
        status: 'failed',
        intent: { toolName: 'travel.imageUnderstand', input: {}, producesFacts: true },
      }),
    ]);
    expect(validateTripPlan(failed, ctxWithImages).violations.map((v) => v.code)).toContain(
      'IMAGE_UNRESOLVED',
    );

    const noStep = makePlan([]);
    expect(validateTripPlan(noStep, ctxWithImages).violations.map((v) => v.code)).toContain(
      'IMAGE_UNRESOLVED',
    );
    // 但**没有图片**时不得报（无图不该被拦）。
    expect(validateTripPlan(noStep, CTX).violations.map((v) => v.code)).not.toContain(
      'IMAGE_UNRESOLVED',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 覆盖度四态 / origin / 填充占比
 * ------------------------------------------------------------------ */

describe('覆盖度四态与 origin（composeItineraryV2）', () => {
  const pois = {
    attraction: [
      { id: 'a1', name: '外滩', city: '上海', category: 'attraction' as const, rating: 4.7, priceLevel: 1, priceCNY: 0, address: 'x', tags: [], source: 'fixture://a1' },
      { id: 'a2', name: '豫园', city: '上海', category: 'attraction' as const, rating: 4.5, priceLevel: 2, priceCNY: 40, address: 'x', tags: [], source: 'fixture://a2' },
    ],
    restaurant: [
      { id: 'r1', name: '南翔馒头店', city: '上海', category: 'restaurant' as const, rating: 4.4, priceLevel: 2, priceCNY: 90, address: 'x', tags: [], source: 'fixture://r1' },
    ],
    hotel: [
      { id: 'h1', name: '全季', city: '上海', category: 'hotel' as const, rating: 4.3, priceLevel: 2, priceCNY: 420, address: 'x', tags: [], source: 'fixture://h1' },
    ],
  };

  it('已排入：图片项 origin=image 且计入覆盖度分子（填充项不计入）', () => {
    const plan = composeItineraryV2({
      city: '上海',
      days: 1,
      anchors: [{ assetIds: ['g1'], name: '外滩' }],
      pois,
      requiredAssetIds: ['g1'],
    });
    const items = plan.days[0].items;
    expect(items.filter((item) => item.origin === 'image').map((i) => i.name)).toEqual(['外滩']);
    expect(items.filter((item) => item.origin === 'image')[0].assetIds).toEqual(['g1']);
    expect(plan.coverage).toMatchObject({ total: 1, covered: 1, ratio: 1 });
    // 1 张图时填充上限 = floor(1 * 0.3 / 0.7) = 0：填充是"连接用"，不是"凑数用"。
    // 所以这里断言的是"填充项绝不携带 assetId"而不是"一定有填充项"。
    expect(items.filter((item) => item.origin === 'fill').every((i) => i.assetIds.length === 0)).toBe(
      true,
    );
    expect(plan.coverage.fillRatio).toBeLessThanOrEqual(0.3);
  });

  it('填充项只在占比闸门允许时出现，且永不携带 assetId', () => {
    const many = composeItineraryV2({
      city: '上海',
      days: 1,
      anchors: [
        { assetIds: ['g1'], name: '外滩' },
        { assetIds: ['g2'], name: '豫园' },
        { assetIds: ['g3'], name: '南翔馒头店' },
      ],
      pois,
      requiredAssetIds: ['g1', 'g2', 'g3'],
    });
    expect(many.coverage.covered).toBe(3);
    expect(many.coverage.fillRatio).toBeLessThanOrEqual(0.3);
    for (const item of many.days[0].items) {
      if (item.origin === 'fill') expect(item.assetIds).toEqual([]);
    }
  });

  it('已跳过：用户显式跳过的 assetId 不进 missing，也不进 covered', () => {
    const plan = composeItineraryV2({
      city: '上海',
      days: 1,
      anchors: [],
      pois,
      requiredAssetIds: ['g1', 'g2'],
      skippedAssetIds: ['g2'],
    });
    expect(plan.coverage.covered).toBe(0);
    expect(plan.coverage.skippedAssetIds).toEqual(['g2']);
    expect(plan.coverage.missingAssetIds).toEqual(['g1']);
  });

  it('已阻断（漏排）：识别出来了但排不进去 → missing 非空，不静默', () => {
    const plan = composeItineraryV2({
      city: '上海',
      days: 1,
      anchors: [],
      pois,
      requiredAssetIds: ['g1'],
    });
    expect(plan.coverage.missingAssetIds).toEqual(['g1']);
  });

  it('无图片：ratio = 1（没有图片就不存在漏排）', () => {
    const plan = composeItineraryV2({ city: '上海', days: 1, pois });
    expect(plan.coverage.total).toBe(0);
    expect(plan.coverage.ratio).toBe(1);
  });

  it('★ 填充占比不超过 MAX_FILL_RATIO（0.3）：填充是连接用，不是凑数用', () => {
    const anchors = [
      { assetIds: ['g1'], name: '外滩' },
      { assetIds: ['g2'], name: '豫园' },
    ];
    const plan = composeItineraryV2({ city: '上海', days: 1, anchors, pois, requiredAssetIds: ['g1', 'g2'] });
    expect(plan.coverage.fillRatio).toBeLessThanOrEqual(0.3);
  });
});

/* ------------------------------------------------------------------ *
 * 工具层：坑 1（ok:false）+ @ 三态 + 口径表单
 * ------------------------------------------------------------------ */

describe('travel.imageUnderstand 工具', () => {
  it('★ 坑 1：需要澄清时返回 ok:false（否则 observer 会先判 SOURCE_MISSING 而不是 clarify）', async () => {
    const outcome = await travelTools['travel.imageUnderstand'].execute(
      { goalSummary: '帮我规划上海三日游' } as never,
      zRunContext.parse({ ...CTX, attachments: [attachment('u-1', 'IMG_9001.jpg')] }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.needsClarification).toBe(true);
    expect((outcome.question?.fields ?? []).length).toBeGreaterThan(0);
  });

  it('识别成功时 ok:true + 非空 sourceRefs（producesFacts 的硬要求）', async () => {
    const outcome = await travelTools['travel.imageUnderstand'].execute(
      { goalSummary: '帮我规划上海三日游' } as never,
      zRunContext.parse({ ...CTX, attachments: [attachment('g-1', '外滩.jpg')] }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.sourceRefs.length).toBeGreaterThan(0);
    const data = outcome.data as { identified: Array<{ assetId: string }>; unresolved: string[] };
    expect(data.identified.map((item) => item.assetId)).toEqual(['g-1']);
    expect(data.unresolved).toEqual([]);
  });

  it('@ 提及 0 命中 → 出现在澄清字段里，且给出"忽略"出口（不静默丢弃、也不死循环）', async () => {
    const ctx = zRunContext.parse({ ...CTX, attachments: [attachment('g-1', '外滩.jpg')] });
    const outcome = await travelTools['travel.imageUnderstand'].execute(
      { goalSummary: '@不存在的图 想拍夜景，帮我规划上海三日游' } as never,
      ctx,
    );
    expect(outcome.ok).toBe(false);
    const ids = (outcome.question?.fields ?? []).map((field) => field.id);
    expect(ids.some((id) => id.startsWith('mention:'))).toBe(true);
    expect(ids).toContain(MENTION_ACTION_FIELD);

    // 选了"忽略" → 下一轮放行（不会出现"永远澄清下去"的死路）。
    const resumed = await travelTools['travel.imageUnderstand'].execute(
      { goalSummary: '@不存在的图 想拍夜景，帮我规划上海三日游' } as never,
      zRunContext.parse({
        ...ctx,
        meta: {
          simulate: 'none',
          answers: {
            [makeFormKey(IMAGE_QUESTION_PREFIX, MENTION_ACTION_FIELD)]: JSON.stringify([
              IGNORE_MENTION_OPTION_ID,
            ]),
          },
        },
      }),
    );
    expect(resumed.ok).toBe(true);
  });

  it('同名 2 张 → ambiguous：全部关联，不静默挑第一个', async () => {
    const outcome = await travelTools['travel.imageUnderstand'].execute(
      { goalSummary: '@IMG_001.jpg 想拍夜景' } as never,
      zRunContext.parse({
        ...CTX,
        attachments: [attachment('g-1', 'IMG_001.jpg'), attachment('g-2', 'IMG_001.jpg')],
      }),
    );
    const data = outcome.data as { mentions: { ambiguous: number } };
    expect(data.mentions.ambiguous).toBe(1);
  });
});

describe('travel.tripBrief 工具（S7：目标没写天数 → 表单问一次）', () => {
  it('没写天数 → needsClarification，带 number 字段', async () => {
    const outcome = await travelTools['travel.tripBrief'].execute(
      { goalSummary: '帮我规划上海旅游' } as never,
      CTX,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.needsClarification).toBe(true);
    expect(outcome.question?.fields?.[0]?.kind).toBe('number');
  });

  it('填了天数 → 放行', async () => {
    const outcome = await travelTools['travel.tripBrief'].execute(
      { goalSummary: '帮我规划上海旅游' } as never,
      zRunContext.parse({
        ...CTX,
        meta: { simulate: 'none', answers: { [makeFormKey(BRIEF_QUESTION_ID, 'days')]: '3' } },
      }),
    );
    expect(outcome.ok).toBe(true);
    const data = outcome.data as { days: number };
    expect(data.days).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * 端到端：图片链路跑完
 * ------------------------------------------------------------------ */

describe('travel v2 · 端到端（图片优先模板）', () => {
  it('3 张可识别的图 → 跑完，覆盖度 3/3，行程卡片带 coverage 与 markdown blocks', async () => {
    const { result, events } = await run('帮我规划上海三日游，预算 6000 元', {
      attachments: [
        attachment('g-1', '外滩.jpg'),
        attachment('g-2', '豫园.jpg'),
        attachment('g-3', '南翔馒头店.jpg'),
      ],
    });

    expect(result.status).toBe('completed');
    const compose = result.plan!.steps.find((step) => step.type === 'itinerary_compose');
    expect(compose?.status).toBe('done');
    const data = compose?.result?.data as
      | { coverage?: { total: number; covered: number }; summaryBlocks?: unknown[] }
      | undefined;
    expect(data?.coverage?.total).toBe(3);
    expect(data?.coverage?.covered).toBe(3);
    expect((data?.summaryBlocks ?? []).length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });
});

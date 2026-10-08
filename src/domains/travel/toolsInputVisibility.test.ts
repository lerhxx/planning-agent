/**
 * ★ 工具入参校验失败的**可见性**回归（真模型路径的一次真实故障）。
 *
 * ## 为什么住在 `src/domains/travel/` 而不是 `src/test/`
 *
 * 其余领域测试都收在 `src/test/`，但那些文件断言的是**内核/领域包的通用行为**，
 * 用中性措辞即可。本文件不同：它的核心断言**必须**引用领域词
 * （枚举的三个合法取值、模型会误填的中文标签）——
 * 换成中性措辞就等于把断言改弱成"有渲染"、"会失败"，那正是本仓最忌讳的假通过。
 * 而 `src/test/` 在内核领域词扫描的范围内（见 `src/test/mastraBoundary.test.ts`
 * 与 `v2IndependentVerify.test.ts` 两条守卫的分工），`src/domains/**` 才是
 * 领域词合法的区域 —— 与守卫文件自己"搬出被扫描目录"是同一套理由。
 *
 * ## 故障现象
 *
 * `Error: 重规划未能继续：MAX_REPLANS（触发=FATAL_ERROR，受影响步骤=…）`，
 * 四个步骤全失败，而**没有** `PLAN_GENERATION_FAILED` ——
 * 说明工具名是对的（那一轮校验通过了），失败发生在**工具执行期**。
 *
 * ## 根因（两层，都属于"静默"）
 *
 * ① **入参不合法被静默替换成默认值**：
 *    `safeParse` 失败时走 `zXxxInput.parse({})`，产出"每项都合法、但全是默认值"的入参。
 *    于是内核刚注入的 `goalSummary` 被丢掉、枚举落回默认、Provider 收到一个什么都为空的请求，
 *    而抛出的错误与"入参字段取值不合法"完全对不上。
 *    模型照着 description 里的中文标签填 `category`，而真实契约只认英文枚举值 ——
 *    这是上面那个静默替换的**触发原因**。
 * ② **模型看不到入参的合法取值**：工具清单只渲染工具名与说明，
 *    不渲染 `intent.input` 的结构，模型只能猜字段取值。
 *
 * ## 本文件守住什么
 *
 * - ①的回归锁：`category` 填中文标签 ⇒ 必须 `ok:false` + 精确错误（字段名 + 合法枚举值），
 *   且**错误里必须提到 `goalSummary` 这个键名**（证明它没被静默丢弃成空串这件事被掩盖）。
 *   ★ 并且错误**不得**包含用户输入的内容（值可能含用户原文，只打键名）。
 * - ② 的回归锁：prompt 的工具清单里能读到那三个合法枚举值。
 *
 * ## 为什么断言"错误里出现合法枚举值"而不是只断言"失败"
 *
 * 只断言"失败"的话，把错误文案换成`工具执行失败` 也能过 ——
 * 而那正是本次故障的真实形态（错误与病因对不上，排查方向被带偏）。
 * 判据必须是「用户/模型看完能回答"我该改哪个字段成什么值"」。
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { getToolBriefs, registerDomainPack } from '@/src/core/registry/domainRegistry';
import { planSystemPrompt, replanSystemPrompt } from '@/src/core/runtime/mastra/prompts';
import { zPlanRequest, zReplanRequest } from '@/src/core/runtime/adapter';
import { TRAVEL_DOMAIN_ID } from '@/src/domains/travel/meta';
import { travelEvaluation } from '@/src/domains/travel/evaluation';
import { travelPlanning } from '@/src/domains/travel/planning';
import { travelPrompts } from '@/src/domains/travel/prompts';
import { travelUI } from '@/src/domains/travel/ui';
import { createTripProviders } from '@/src/domains/travel/providers';
import { travelTools, zPoiSearchResult } from '@/src/domains/travel/tools';
import { KERNEL_ERROR_CODES, zGoal, zStep } from '@/shared/plan/types';
import type { DomainPack } from '@/shared/domain/types';
import type { RunContext } from '@/shared/run/types';

/** pack 组装（与 `travelDomain.test.ts` 同一写法：测试内联构造，不污染注册表）。 */
function packForTest(): DomainPack {
  return {
    meta: {
      id: TRAVEL_DOMAIN_ID,
      displayName: '旅行',
      version: '1.0.0',
      schemaVersion: 1,
      description: '目的地行程规划',
      matcher: { keywords: [], patterns: [], negativeKeywords: [], scoreBySignals: {} },
      requiredSignals: [],
      capabilities: {
        vision: true,
        geo: false,
        providers: true,
        timeSequence: true,
      },
    },
    tools: travelTools,
    providers: createTripProviders(),
    ui: travelUI,
    prompts: travelPrompts,
    planning: travelPlanning,
    evaluation: travelEvaluation,
  };
}

const CTX: RunContext = {
  runId: 'run-input-visibility',
  traceId: 'trace-input-visibility',
  goalId: 'goal-input-visibility',
  domainId: TRAVEL_DOMAIN_ID,
  revision: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  deadlineAt: '2026-01-01T00:00:25.000Z',
  budgetRemainingCNY: 2,
  signals: ['text'],
  meta: {},
};

/** 目标里写明城市/天数/预算，让 `resolveTripBrief` 有东西可解析。 */
const GOAL_SUMMARY = '帮我规划上海三日游，预算 3000 元';

/**★ 模型最容易犯的错：照着 description 里的中文标签填枚举字段。 */
const CHINESE_CATEGORY_LABEL = '景点';

describe('工具入参不合法 ⇒ 精确失败（不再静默降级成默认值）', () => {
  it('① poiSearch收到中文类别标签 ⇒ ok:false，且错误指明字段名与全部合法取值', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      { goalSummary: GOAL_SUMMARY, category: CHINESE_CATEGORY_LABEL } as never,
      CTX,
    );

    expect(outcome.ok).toBe(false);
    const message = outcome.error?.message ?? '';
    // 字段名
    expect(message).toContain('category');
    // ★ 合法枚举值必须三个都在：模型（与用户）要能据此一次改对。
    for (const legal of ['attraction', 'restaurant', 'hotel']) {
      expect(message).toContain(legal);
    }
  });

  it('① ★ 回归锁：错误里提到 goalSummary 键名（证明没被静默丢弃成空串）', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      { goalSummary: GOAL_SUMMARY, category: CHINESE_CATEGORY_LABEL } as never,
      CTX,
    );

    // 旧写法下 goalSummary 会被 parse({}) 吞成空串、且**没有任何地方提到它**——
    // 那样"入参不合法"这件事就被"目标摘要丢失"掩盖了。
    const message = outcome.error?.message ?? '';
    expect(message).toContain('goalSummary');
  });

  it('① ★错误里只打键名，不回显用户输入的值', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      {
        goalSummary: GOAL_SUMMARY,
        category: CHINESE_CATEGORY_LABEL,
        city: '用户自己写的城市名',
      } as never,
      CTX,
    );

    const message = outcome.error?.message ?? '';
    // 值可能含用户原文（目标摘要 / @提及），回显进错误就等于把不可信文本
    // 复制到日志、告警与错误卡片里。键名可以打，值不行。
    expect(message).not.toContain(CHINESE_CATEGORY_LABEL);
    expect(message).not.toContain('用户自己写的城市名');
    expect(message).not.toContain('3000');
  });

  it('① 失败时错误码取自内核白名单（红线 10：不新造码）', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      { goalSummary: GOAL_SUMMARY, category: CHINESE_CATEGORY_LABEL } as never,
      CTX,
    );

    expect(outcome.error?.code).toBe('PROVIDER_VALIDATION_FAILED');
    expect(KERNEL_ERROR_CODES).toContain(outcome.error?.code ?? '');
  });

  it('① 入参不合法是确定性失败 ⇒ 不可重试（否则白耗maxAttempts 才进重排）', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      { goalSummary: GOAL_SUMMARY, category: CHINESE_CATEGORY_LABEL } as never,
      CTX,
    );

    expect(outcome.error?.retryable).toBe(false);
  });

  it('① producesFacts 的工具失败时不带任何 sourceRefs（不宣称"这些事实有来源"）', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      { goalSummary: GOAL_SUMMARY, category: CHINESE_CATEGORY_LABEL } as never,
      CTX,
    );

    expect(outcome.sourceRefs).toEqual([]);
  });

  it('② 合法入参 ⇒ 正常返回，sourceRefs 非空', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      { goalSummary: GOAL_SUMMARY, category: 'attraction', limit: 4 } as never,
      CTX,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.sourceRefs.length).toBeGreaterThan(0);
    const payload = zPoiSearchResult.parse(outcome.data);
    expect(payload.pois.length).toBeGreaterThan(0);
  });

  it('② ★ goalSummary 合法时原样透传到结果里（没有被替换/截断）', async () => {
    const outcome = await travelTools['travel.poiSearch'].execute(
      { goalSummary: GOAL_SUMMARY, category: 'attraction' } as never,
      CTX,
    );

    expect(outcome.ok).toBe(true);
    expect(zPoiSearchResult.parse(outcome.data).goalSummary).toBe(GOAL_SUMMARY);
  });

  it('③ 同一套写法在另两个工具上同样成立（不是只修了一个）', async () => {
    const brief = await travelTools['travel.tripBrief'].execute(
      // 声明字段的类型不对 ⇒ 类型不合法
      { goalSummary: 123 } as never,
      CTX,
    );
    expect(brief.ok).toBe(false);
    expect(brief.error?.code).toBe('PROVIDER_VALIDATION_FAILED');
    expect(brief.error?.message).toContain('goalSummary');

    const compose = await travelTools['travel.itineraryCompose'].execute(
      // 超过上限 ⇒ 数值越界
      { goalSummary: GOAL_SUMMARY, limitPerCategory: 99 } as never,
      CTX,
    );
    expect(compose.ok).toBe(false);
    expect(compose.error?.code).toBe('PROVIDER_VALIDATION_FAILED');
    expect(compose.error?.message).toContain('limitPerCategory');
    expect(compose.error?.message).toContain('12');
  });
});

/* ------------------------------------------------------------------ *
 * ② prompt 必须把入参的合法取值告诉模型
 * ------------------------------------------------------------------ */

describe('工具清单渲染入参约束（模型不再靠猜）', () => {
  beforeAll(() => {
    registerDomainPack(packForTest());
  });

  /*
   * ★ fixture 一律走 `zGoal` / `zReplanRequest` / `zStep` 的 `parse`，**不手搓字面量**。
   *   与 `prompts.test.ts` 同一条纪律：schema 一旦改（加字段、改枚举），本文件会
   *   **响亮地**抛错，而不是悄悄拿一份过期fixture 通过 ——
   *   后者会让守卫失真，比没有守卫更危险。
   */
  const GOAL = zGoal.parse({
    id: 'g-1',
    runId: 'run-1',
    raw: GOAL_SUMMARY,
    summary: GOAL_SUMMARY,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  /** 用真实的注册表装配清单 —— 与 `MastraRuntime.plan` 走同一条路。 */
  function renderPlanPrompt(): string {
    return planSystemPrompt(
      zPlanRequest.parse({
        goal: GOAL,
        stepTypes: [],
        tools: getToolBriefs(TRAVEL_DOMAIN_ID),
        templates: [],
        signals: ['文本输入'],
        revision: 1,
      }),
    );
  }

  it('① ★ 清单里能读到 category 的三个合法枚举值', () => {
    const text = renderPlanPrompt();
    // 这三个值就是模型必须填的取值；断言具体值而不是"有渲染"，
    // 否则把渲染换成一句"请填合法类别"也能假通过。
    for (const legal of ['attraction', 'restaurant', 'hotel']) {
      expect(text).toContain(`"${legal}"`);
    }
  });

  it('② 指明了字段名与"必填/可选"，模型据此知道能不能省', () => {
    const text = renderPlanPrompt();
    expect(text).toMatch(/category/);
    expect(text).toMatch(/必填|可选/);
  });

  it('③ 入参 schema 是从工具真实 schema 推导的，不是手抄（改 schema 清单跟着变）', () => {
    // 直接断言内核装配出的清单：它读的就是注册表里那份 zod schema。
    const brief = getToolBriefs(TRAVEL_DOMAIN_ID).find((item) => item.name === 'travel.poiSearch');
    expect(brief).toBeDefined();
    expect(brief?.inputSchema.fields['category']?.enum).toEqual([
      'attraction',
      'restaurant',
      'hotel',
    ]);
    // 带默认值的字段在"调用方要填什么"的视角下不是必填
    expect(brief?.inputSchema.required).toEqual([]);
    // 数值约束也在（模型爱自己发挥数字，越界同样是静默拒收）
    expect(brief?.inputSchema.fields['limit']?.bounds['maximum']).toBe(12);
  });

  it('④ ★ 重排 prompt 同样带清单（重排换掉的就是调工具的那几步）', () => {
    const text = replanSystemPrompt(
      zReplanRequest.parse({
        goal: GOAL,
        revision: 2,
        trigger: 'FATAL_ERROR',
        failedStepIds: ['s-1'],
        impactedStepIds: ['s-1'],
        retainedSteps: [],
        impactedSteps: [],
        stepTypes: [],
        tools: getToolBriefs(TRAVEL_DOMAIN_ID),
        templates: [],
      }),
    );

    for (const legal of ['attraction', 'restaurant', 'hotel']) {
      expect(text).toContain(`"${legal}"`);
    }
  });

  it('⑤ ★ 重排 prompt 带上失败步骤的失败原因（否则精确报错只到内核为止）', () => {
    const text = replanSystemPrompt(
      zReplanRequest.parse({
        goal: GOAL,
        revision: 2,
        trigger: 'FATAL_ERROR',
        failedStepIds: ['s-1'],
        impactedStepIds: ['s-1'],
        retainedSteps: [],
        impactedSteps: [
          zStep.parse({
            id: 's-1',
            domainId: TRAVEL_DOMAIN_ID,
            type: 'poi_search',
            order: 0,
            title: '检索候选',
            origin: { kind: 'planner', revision: 1 },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            error: {
              code: 'PROVIDER_VALIDATION_FAILED',
              message: 'travel.poiSearch 的入参未通过校验：字段 category 的取值不合法',
              retryable: false,
            },
          }),
        ],
        stepTypes: [],
        tools: getToolBriefs(TRAVEL_DOMAIN_ID),
        templates: [],
      }),
    );

    // 模型此刻无法凭空知道上次错在哪 —— 不给失败原因，它只能换个写法再撞一次。
    expect(text).toContain('字段 category 的取值不合法');
  });
});
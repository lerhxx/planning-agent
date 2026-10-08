/**
 * 领域段 ②：tools。
 *
 * 铁律：
 * - `producesFacts: true` 的工具返回**必须带 `SourceRef`**（否则引擎判失败）；
 * - 事实数据只能来自 Provider，工具里不写任何候选数据；
 * - MockRuntime 下每个 step 只能拿到自己的静态 `intent.input`，拿不到上游 step 的结果，
 *   因此编排工具以**同一套检索口径**重新向 Provider 取同一批事实（幂等、零副作用），
 *   而不是引入跨 step 的隐藏状态。
 *
 * ★ v2 的两条新纪律：
 * - **坑 1**：`imageUnderstand` 需要澄清时**必须返回 `ok:false`**。
 *   `observer.ts` 的 `producesFacts` 检查形如 `outcome.ok && producesFacts && sourceRefs 为空 → fail`；
 *   返回 `ok:false` 会让第一条检查跳过，直接落到 `needsClarification`（否则会先被判 SOURCE_MISSING）。
 * - **坑 2（Q-1 顺序）**：未识别的图**第一动作是工具澄清**，不是 error。
 *   `engine.ts` 的 `askUserForValidation(prompt)` 连 options 参数都没有（硬编码 replan/abort），
 *   一旦校验先拦下，用户就永远看不到"跳过这 N 张" —— 那等于把 P0 做成不可达代码。
 */
import { z } from 'zod';
import { makeFormKey, zSourceRef, type SourceRef } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import type { ProviderAdapter, ToolResult, ToolSet } from '@/shared/domain/types';
import {
  CATEGORY_LABEL,
  MAX_TRIP_DAYS,
  TRIP_CATEGORIES,
  TRIP_DISCLAIMER,
  composeItinerary,
  composeItineraryV2,
  createTripProviders,
  listPoisByCategory,
  resolveTripBrief,
  zItineraryOrigin,
  zItineraryNote,
  zCoverage,
  zTripCategory,
  zTripPoi,
  buildMentionClarifyPayload,
  parseImageMentions,
  listVisionRecords,
  makeVisionSourceRef,
  VISION_DISCLAIMER,
  type TripCategory,
  type TripPoi,
} from './providers';
import { markdownToBlocks, zMdBlock } from './markdown';

/* ------------------------------------------------------------------ *
 * 澄清问题 id（**确定性**：重试同一工具时还能读到上一轮的答案）
 * ------------------------------------------------------------------ */

export const IMAGE_QUESTION_ID = 'clarify:travel.image-understand';
export const BRIEF_QUESTION_ID = 'clarify:travel.trip-brief';
/** 跳过语义的字段 id 与选项 id（沿用既有语义，K5）。 */
export const UNRESOLVED_ACTION_FIELD = 'unresolved_action';
export const SKIP_OPTION_ID = 'skip';
/** `@` 提及未命中的处置字段与选项 id（与 skip 对称：都不预选，不选就继续问）。 */
export const MENTION_ACTION_FIELD = 'mention_action';
export const IGNORE_MENTION_OPTION_ID = 'ignore';
/** 用户为某张图补充信息的字段前缀。 */
export const ASSET_FIELD_PREFIX = 'asset:';

/* ------------------------------------------------------------------ *
 * 答案读取
 * ------------------------------------------------------------------ */

/**
 * 读 `ctx.meta.answers`（引擎把 `input.answers` 过桥到这里，`engine.ts:269`）。
 *
 * ★★★ 为什么这里读 `answers`，而不是读 `result.data`？（三件事，改代码前请读完）★★★
 *
 * ① 「用户上一轮选了什么」**根本不在 `result.data` 里**。
 *    `result.data` 是**本工具上一轮的产出**；`answers` 才是用户本人的输入。
 *    想从产出里反推用户输入，本身就绕了一层，而且推不出来（澄清轮 `ok:false`，
 *    `result.data.skippedAssetIds` 恒为 `[]`）。
 *
 * ② `retryStep` 会把该步骤的 `result` 清空成 `undefined`
 *    （`src/core/planning/edit.ts:238`，`result: undefined` + `status: 'pending'`）。
 *    所以在"发澄清 → 用户填表 → retryStep 重跑"这条主链路上，
 *    若改成读 `result.data`，拿到的**必然是 `undefined`**。
 *
 * ③ ⚠️ 明确警告：**不要"顺手"把它改成读 `result.data`**——那看起来更自然，但是错的。
 *    后果链：retryStep 清 result → 读不到"已跳过" → 本轮重新判定为"未识别"
 *    → 再次发澄清 → 用户再选一次跳过 → 再 retryStep 再清空……
 *    即：**用户跳过的图会重新变成未识别并被反复拦截，形成死循环**，
 *    而且每一步单独看都"完全合理"（没报错、没丢数据、只是又问了一次）。
 *    这正是"静默"失败类型最难查的一种：**没有异常，只有用户永远走不出去。**
 *
 * ❤️‍🩹 与 K5「领域只读 `result.data`」的字面偏差，是有意为之：
 *    K5 要防的是「领域绕过 Provider 编造事实」，而 `answers` 是**用户输入**不是事实来源，
 *    读它不违反红线 16。下游（compose / planCheck）仍然只读 `result.data`，
 *    单一真源的边界没有被破坏——本工具每一轮都把决策结果重新写进
 *    `result.data.skippedAssetIds`（`zImageUnderstandResult`）。
 *
 * 🔒 这条行为由 `src/test/travelV2.test.ts` 的「★ K5 · retryStep 后 skippedAssetIds 仍然可读」
 *    5 条锁守着（含反向锁：retryStep 但不带 answers → 回到 `awaiting_user`）。
 *    **改坏了测试会红，但注释是给改代码的人看的——两个都要。**
 */
function readAnswers(ctx: RunContext): Record<string, string> {
  const raw = ctx.meta['answers'];
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** `multi` 字段的值：按 K4 用 `JSON.stringify([...])` 编码。 */
function readMultiAnswer(answers: Record<string, string>, questionId: string, fieldId: string): string[] {
  const raw = answers[makeFormKey(questionId, fieldId)];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 输入 / 返回 schema
 * ------------------------------------------------------------------ */

export const zPoiSearchInput = z.object({
  goalSummary: z.string().default(''),
  city: z.string().min(1).optional(),
  category: zTripCategory.default('attraction'),
  limit: z.number().int().positive().max(12).default(4),
});
export type PoiSearchInput = z.infer<typeof zPoiSearchInput>;

export const zItineraryComposeInput = z.object({
  goalSummary: z.string().default(''),
  city: z.string().min(1).optional(),
  days: z.number().int().positive().max(MAX_TRIP_DAYS).optional(),
  budgetCNY: z.number().nonnegative().optional(),
  limitPerCategory: z.number().int().positive().max(12).default(4),
});
export type ItineraryComposeInput = z.infer<typeof zItineraryComposeInput>;

export const zImageUnderstandInput = z.object({
  goalSummary: z.string().default(''),
});
export type ImageUnderstandInput = z.infer<typeof zImageUnderstandInput>;

export const zTripBriefInput = z.object({
  goalSummary: z.string().default(''),
});
export type TripBriefInput = z.infer<typeof zTripBriefInput>;

export const zPoiSearchResult = z.object({
  city: z.string().default(''),
  category: zTripCategory.default('attraction'),
  categoryLabel: z.string().default(''),
  pois: z.array(zTripPoi).default([]),
  sourceRefs: z.array(zSourceRef).default([]),
  goalSummary: z.string().default(''),
  disclaimer: z.string().optional(),
});
export type PoiSearchResult = z.infer<typeof zPoiSearchResult>;

/** v2 的每日条目：在既有字段上补 `origin` / `assetIds`（**老字段一个不动**）。 */
const zItineraryComposeItem = z.object({
  name: z.string().default(''),
  category: zTripCategory.default('attraction'),
  categoryLabel: z.string().default(''),
  slot: z.string().default(''),
  priceCNY: z.number().nonnegative().default(0),
  source: z.string().default(''),
  origin: zItineraryOrigin.default('fill'),
  assetIds: z.array(z.string()).default([]),
});

const zItineraryComposeDay = z.object({
  day: z.number().int().positive().default(1),
  theme: z.string().default(''),
  items: z.array(zItineraryComposeItem).default([]),
  notes: z.array(zItineraryNote).default([]),
  stayName: z.string().optional(),
  stayPriceCNY: z.number().nonnegative().default(0),
  costCNY: z.number().nonnegative().default(0),
});

export const zItineraryComposeResult = z.object({
  city: z.string().default(''),
  days: z.array(zItineraryComposeDay).default([]),
  totalCostCNY: z.number().nonnegative().default(0),
  budgetCNY: z.number().nonnegative().nullable().default(null),
  /** ★ 覆盖度走**数据通道**（进 props），不走违规通道（§3.2 口径 4）。 */
  coverage: zCoverage.optional(),
  summaryBlocks: z.array(zMdBlock).default([]),
  sourceRefs: z.array(zSourceRef).default([]),
  goalSummary: z.string().default(''),
  disclaimer: z.string().optional(),
});
export type ItineraryComposeResult = z.infer<typeof zItineraryComposeResult>;

export const zImageUnderstandResult = z.object({
  identified: z
    .array(
      z.object({
        assetId: z.string().default(''),
        identifiedName: z.string().default(''),
        /** ★ 置信度是**数值事实**，只能来自 Provider（红线 16），模型不得编造；缺省即"Provider 没给"。 */
        confidence: z.number().min(0).max(1).optional(),
        /** ★ 反幻觉：每条已识别项都要能点开看来源（`VisionResultCard` 逐条展示）。 */
        source: z.string().optional(),
      }),
    )
    .default([]),
  unresolved: z.array(z.string()).default([]),
  skippedAssetIds: z.array(z.string()).default([]),
  /** 用户在表单里补的名字（**不是 Provider 识别的**，单独列出以免被当成识别事实）。 */
  userIdentified: z
    .array(z.object({ assetId: z.string().default(''), name: z.string().default('') }))
    .default([]),
  mentions: z
    .object({
      matched: z.number().int().nonnegative().default(0),
      ambiguous: z.number().int().nonnegative().default(0),
      unresolved: z.number().int().nonnegative().default(0),
    })
    .default({ matched: 0, ambiguous: 0, unresolved: 0 }),
  sourceRefs: z.array(zSourceRef).default([]),
  goalSummary: z.string().default(''),
  disclaimer: z.string().optional(),
});
export type ImageUnderstandResult = z.infer<typeof zImageUnderstandResult>;

export const zTripBriefResult = z.object({
  city: z.string().default(''),
  requestedCity: z.string().default(''),
  days: z.number().int().positive().default(1),
  budgetCNY: z.number().nonnegative().nullable().default(null),
  limitPerCategory: z.number().int().positive().default(4),
  cityFallback: z.boolean().default(false),
  goalSummary: z.string().default(''),
});
export type TripBriefResult = z.infer<typeof zTripBriefResult>;

function toSourceRefs(source: unknown): SourceRef[] {
  const parsed = zSourceRef.safeParse(source);
  return parsed.success ? [parsed.data] : [];
}

/* ------------------------------------------------------------------ *
 * 入参校验：**失败必须精确可见**
 * ------------------------------------------------------------------ */

/**
 * ★ zod issue → 一句"哪个字段不合法、期望什么"的话。
 *
 * ## 为什么不用 `issue.message` 直接拼
 *
 * zod 的 `message` 里带`expected` 但**不带字段的合法取值清单**（枚举那句是
 * `Invalid option: expected one of "a"|"b"`），够用但不稳：不同 zod 版本的措辞会变，
 * 而这条消息是要**给人看**的（用户看到的报错就是它）。所以这里自己按issue 结构拼，
 * 保证「字段名 + 合法取值」永远在，且措辞由本仓掌控。
 *
 * ## 绝不回显收到的值
 *
 * 入参里可能有用户原文（目标摘要、@提及），回显进error message 就等于
 * 把不可信文本复制到日志/告警/错误卡片里。只用issue 自带的**约束信息**
 * （`expected` / `values` / `maximum` …），那些是 schema 定义的常量，不是用户输入。
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(根)';
  switch (issue.code) {
    case 'invalid_value': {
      const values = issue.values.map((value) => `"${String(value)}"`).join(' / ');
      return `字段 ${path} 的取值不合法，只能是 ${values}`;
    }
    case 'invalid_type':
      return `字段 ${path} 的类型不合法，应为 ${issue.expected}`;
    case 'too_big':
      return `字段 ${path} 超出上界（最大 ${issue.maximum}）`;
    case 'too_small':
      return `字段 ${path} 低于下界（最小 ${issue.minimum}）`;
    case 'unrecognized_keys':
      return `存在未声明的字段：${issue.keys.join('、')}`;
    case 'invalid_format':
      return `字段 ${path} 的格式不合法（要求 ${issue.format}）`;
    default:
      return `字段 ${path} 不满足约束（${issue.code}）`;
  }
}

/**
 * ★ 入参不合法的**唯一出口**：返回精确失败，绝不替换成默认值。
 *
 * ## 这段替换掉的是什么（一次真实故障的完整后果链）
 *
 * 旧写法是 `parsed.success ? parsed.data : zXxxInput.parse({})`。失败时
 * `parse({})` 造出一个"**每项都合法、但全是默认值**"的入参，于是：
 *
 * 1. 刚由内核注入的 `goalSummary` 被**静默丢弃**（变成空串）；
 * 2. 枚举字段落回默认值，工具拿着一个"什么都为空"的请求去跑；
 * 3. 抛出的错误（多半来自下游 Provider）与真实病因"入参字段取值不合法"**完全对不上**。
 *
 * 三条里最致命的是第3 条：它把排查方向整个带偏 —— 而每一步单看都"完全合理"。
 *
 * ## 为什么 `error` 里带上"收到的原始入参键名"
 *
 * 这是**回归锁**：证明 `goalSummary` 没有被静默替换成空串这件事被掩盖了。
 * 只打**键名**不打值 —— 值可能含用户输入。
 *
 * ## 为什么码选`PROVIDER_VALIDATION_FAILED`
 *
 * `KERNEL_ERROR_CODES` 里与"入参不合法"语义最贴近的就是它：
 * 触发码表的既有含义是"**上游交回来的东西没过校验**"（`parse.ts` 用它标
 * "模型返回的计划未通过 schema 校验"），而模型给的 `intent.input` 正是同一类
 * "上游交回来的不可信数据"。`TOOL_FAILED` 太宽（会与真正的执行期故障混同），
 * 新造一个码则破坏白名单的穷尽性（红线 10）。
 *
 * ## `retryable` 为什么是 false
 *
 * 入参不合法是**确定性**失败：同样的入参再跑一次必然同样失败，
 * 标成可重试只会白白耗掉 `maxAttempts` 再进重排。重排是唯一正确的出路，
 * 而重排 prompt 现在能看到精确的失败原因（`trigger` +步骤 id）。
 */
function inputRejected(
  toolName: string,
  issues: z.core.$ZodIssue[],
  rawInput: unknown,
  startedAt: number,
): ToolResult<never> {
  const detail = issues.slice(0, 3).map(describeIssue).join('；');
  const receivedKeys =
    typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
      ? Object.keys(rawInput as Record<string, unknown>)
      : [];
  return {
    ok: false,
    // ★ 空数组是刻意的：`producesFacts` 的步骤一旦带上事实性sourceRefs
    //   就等于宣称"这些事实有来源"，而此刻一把事实都没拿到。
    sourceRefs: [],
    isEstimate: false,
    durationMs: Date.now() - startedAt,
    error: {
      code: 'PROVIDER_VALIDATION_FAILED',
      message:
        `${toolName} 的入参未通过校验：${detail}` +
        `（收到的字段名：${receivedKeys.length > 0 ? receivedKeys.join('、') : '无'}）`,
      retryable: false,
    },
  };
}

/** 本轮的图片附件（引用优先：只带描述符，字节不进请求体）。 */
function imageAttachments(ctx: RunContext): Array<{ id: string; name: string }> {
  return (ctx.attachments ?? [])
    .filter((item) => item.kind === 'image')
    .map((item) => ({ id: item.id, name: item.name }));
}

/* ------------------------------------------------------------------ *
 * 工具集
 * ------------------------------------------------------------------ */

export const travelTools: ToolSet = {
  'travel.poiSearch': {
    name: 'travel.poiSearch',
    description:
      '按城市 + 类别（景点 / 餐厅 / 酒店）检索候选，返回带来源的事实数据（名称、类别、评分、价位、地址）',
    inputSchema: zPoiSearchInput,
    producesFacts: true,
    idempotent: true,
    timeoutMs: 5_000,
    retryable: true,
    stepType: 'poi_search',

    async execute(input: unknown, ctx: RunContext) {
      const startedAt = Date.now();
      const parsed = zPoiSearchInput.safeParse(input ?? {});
      // ★ 入参不合法 ⇒ 精确失败，不再 `parse({})` 静默替换成"全默认值"
      //   （那会丢掉 goalSummary 并让错误与病因对不上，见 inputRejected 的注释）。
      if (!parsed.success) {
        return inputRejected('travel.poiSearch', parsed.error.issues, input, startedAt);
      }
      const request = parsed.data;
      const brief = resolveTripBrief({ goalSummary: request.goalSummary, city: request.city });

      const providers = createTripProviders().create(ctx);
      const provider = providers['travel.poi'] as ProviderAdapter<
        Record<string, unknown>,
        TripPoi
      >;
      // ★ cityFallback 必须显式往下传：brief.city 已经是"回落后的城市名"，
      // 只传城市名的话 Provider 会认为它命中了 fixture，"已回落"标注就永远出不来。
      const result = await provider.search(
        {
          city: brief.city,
          category: request.category,
          limit: request.limit,
          cityFallback: brief.cityFallbackReason,
        },
        ctx,
      );

      // ★ 来源引用同样要校验：Provider 给出的 source 不合法时，宁可让 step 失败也不放无源事实过去。
      const sourceRefs = toSourceRefs(result.source);
      const pois = result.data ?? [];

      return {
        ok: result.ok,
        data: {
          city: brief.city,
          category: request.category,
          categoryLabel: CATEGORY_LABEL[request.category],
          pois,
          sourceRefs,
          goalSummary: request.goalSummary,
          disclaimer: result.disclaimer,
        } satisfies PoiSearchResult,
        sourceRefs,
        isEstimate: true,
        durationMs: Date.now() - startedAt,
        disclaimer: result.disclaimer,
      };
    },
  },

  'travel.tripBrief': {
    name: 'travel.tripBrief',
    description: '确认本次行程的口径（城市 / 天数 / 预算）；目标里没写天数时用流式表单问一次',
    inputSchema: zTripBriefInput,
    producesFacts: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryable: true,
    stepType: 'trip_brief',

    async execute(input: unknown, ctx: RunContext) {
      const startedAt = Date.now();
      const parsed = zTripBriefInput.safeParse(input ?? {});
      if (!parsed.success) {
        return inputRejected('travel.tripBrief', parsed.error.issues, input, startedAt);
      }
      const request = parsed.data;
      const brief = resolveTripBrief({ goalSummary: request.goalSummary });
      const answers = readAnswers(ctx);

      // ★ S7：目标里没写天数 → **工具发澄清**（UI 流式长出表单），不硬猜一个天数。
      // 这是 Q-1 顺序的直接体现：先问，而不是先拦。
      if (brief.daysFromGoal === null) {
        const answeredDays = Number(answers[makeFormKey(BRIEF_QUESTION_ID, 'days')]);
        if (!Number.isFinite(answeredDays) || answeredDays <= 0) {
          return {
            ok: false,
            data: { goalSummary: request.goalSummary },
            sourceRefs: [],
            isEstimate: false,
            durationMs: Date.now() - startedAt,
            needsClarification: true,
            question: {
              id: BRIEF_QUESTION_ID,
              prompt: '这次出行想安排几天？（目标里没写天数，我不想猜一个）',
              options: [],
              fields: [
                {
                  id: 'days',
                  kind: 'number',
                  label: '天数',
                  description: '1 ~ 14 天',
                  required: true,
                  options: [],
                  min: 1,
                  max: MAX_TRIP_DAYS,
                },
              ],
              multi: false,
            },
          };
        }
        return {
          ok: true,
          data: {
            city: brief.city,
            requestedCity: brief.requestedCity,
            days: Math.trunc(answeredDays),
            budgetCNY: brief.budgetCNY,
            limitPerCategory: brief.limitPerCategory,
            cityFallback: brief.cityFallback,
            goalSummary: request.goalSummary,
          } satisfies TripBriefResult,
          sourceRefs: [],
          isEstimate: false,
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        ok: true,
        data: {
          city: brief.city,
          requestedCity: brief.requestedCity,
          days: brief.days,
          budgetCNY: brief.budgetCNY,
          limitPerCategory: brief.limitPerCategory,
          cityFallback: brief.cityFallback,
          goalSummary: request.goalSummary,
        } satisfies TripBriefResult,
        sourceRefs: [],
        isEstimate: false,
        durationMs: Date.now() - startedAt,
      };
    },
  },

  'travel.imageUnderstand': {
    name: 'travel.imageUnderstand',
    description:
      '理解本轮上传的图片（离线 fixture 识别），并把文本里的 @提及关联到具体图片；未识别的图会发澄清让用户补信息或跳过',
    inputSchema: zImageUnderstandInput,
    producesFacts: true,
    idempotent: true,
    timeoutMs: 5_000,
    retryable: true,
    stepType: 'image_understand',

    async execute(input: unknown, ctx: RunContext) {
      const startedAt = Date.now();
      const parsed = zImageUnderstandInput.safeParse(input ?? {});
      if (!parsed.success) {
        return inputRejected('travel.imageUnderstand', parsed.error.issues, input, startedAt);
      }
      const request = parsed.data;
      const goalText = request.goalSummary ?? '';

      const attachments = imageAttachments(ctx);
      const vision = listVisionRecords(attachments);
      const mentions = parseImageMentions(goalText, attachments);
      // ★ 读 `answers`（不是 `result.data`）：`retryStep` 会清空本步骤的 result，
      //   "用户选了跳过"只可能存在这里。详见 `readAnswers` 的注释——**勿改**。
      const answers = readAnswers(ctx);

      // ① 用户在表单里补的名字（不是 Provider 识别的，单独归类）
      const userIdentified = vision.unresolvedAssetIds.flatMap((assetId) => {
        const value = answers[makeFormKey(IMAGE_QUESTION_ID, `${ASSET_FIELD_PREFIX}${assetId}`)];
        const name = typeof value === 'string' ? value.trim() : '';
        return name.length > 0 ? [{ assetId, name }] : [];
      });
      const userResolvedIds = new Set(userIdentified.map((item) => item.assetId));

      // ② 用户是否显式跳过 / 忽略（K5：选项 id 沿用既有语义，**不预选**；没选就不放行）
      const action = readMultiAnswer(answers, IMAGE_QUESTION_ID, UNRESOLVED_ACTION_FIELD);
      const skipped = action.includes(SKIP_OPTION_ID);
      const stillUnresolved = vision.unresolvedAssetIds.filter((id) => !userResolvedIds.has(id));
      const mentionAction = readMultiAnswer(answers, IMAGE_QUESTION_ID, MENTION_ACTION_FIELD);
      const mentionIgnored = mentionAction.includes(IGNORE_MENTION_OPTION_ID);
      const unresolvedMentionTokens = mentions.unresolvedTokens;

      const sourceRefs = vision.identified.map((record) =>
        zSourceRef.parse(makeVisionSourceRef(record.identifiedName)),
      );
      // ★ 整批结果也要有 SourceRef（producesFacts 且 ok:true 时，空 sourceRefs 会被判 SOURCE_MISSING）。
      const batchRef = zSourceRef.parse({
        providerId: 'travel.vision',
        namespace: 'travel.vision',
        uri: 'fixture://travel/vision/batch',
        label: `图片识别 fixture · 本次 ${attachments.length} 张`,
        retrievedAt: new Date().toISOString(),
        isEstimate: true,
      });

      // ★ 坑 1 / 坑 2：还有没着落的东西 → **第一动作是澄清**，返回 ok:false 让 observer 走 clarify。
      // 绝不在这里返回 error（校验先拦 = 用户永远看不到"跳过"），也绝不静默放行。
      const needImageDecision = stillUnresolved.length > 0 && !skipped;
      const needMentionDecision = unresolvedMentionTokens.length > 0 && !mentionIgnored;

      if (needImageDecision || needMentionDecision) {
        const nameOf = new Map(attachments.map((item) => [item.id, item.name]));
        const fields = [
          ...stillUnresolved.map((assetId) => ({
            id: `${ASSET_FIELD_PREFIX}${assetId}`,
            kind: 'text' as const,
            label: `「${nameOf.get(assetId) ?? assetId}」是什么地方？`,
            description: '可留空：留空表示这张图先不参与规划',
            required: false,
            options: [],
          })),
          ...(needImageDecision
            ? [
                {
                  id: UNRESOLVED_ACTION_FIELD,
                  kind: 'multi' as const,
                  label: `还有 ${stillUnresolved.length} 张图没认出来，怎么处理？`,
                  description: '不勾选就不会继续（不会静默跳过）',
                  required: false,
                  options: [
                    { id: SKIP_OPTION_ID, label: `跳过这 ${stillUnresolved.length} 张` },
                    { id: 'later', label: '我改天补图' },
                  ],
                },
              ]
            : []),
          ...buildMentionClarifyPayload(mentions, attachments).fields,
          ...(needMentionDecision
            ? [
                {
                  id: MENTION_ACTION_FIELD,
                  kind: 'multi' as const,
                  label: `有 ${unresolvedMentionTokens.length} 处 @提及没匹配到图片，怎么处理？`,
                  description: '不选就继续问（不会静默丢弃这段说明）',
                  required: false,
                  options: [
                    { id: IGNORE_MENTION_OPTION_ID, label: '这段说明不关联任何图，直接继续' },
                  ],
                },
              ]
            : []),
        ];

        return {
          ok: false,
          data: {
            identified: vision.identified.map((record) => ({
              assetId: record.assetId,
              identifiedName: record.identifiedName,
              confidence: record.confidence,
              source: record.source,
            })),
            unresolved: stillUnresolved,
            skippedAssetIds: [],
            userIdentified,
            mentions: mentions.counts,
            sourceRefs: [batchRef],
            goalSummary: goalText,
            disclaimer: VISION_DISCLAIMER,
          } satisfies ImageUnderstandResult,
          sourceRefs: [batchRef, ...sourceRefs],
          isEstimate: true,
          durationMs: Date.now() - startedAt,
          disclaimer: VISION_DISCLAIMER,
          needsClarification: true,
          question: {
            id: IMAGE_QUESTION_ID,
            prompt:
              stillUnresolved.length > 0
                ? `有 ${stillUnresolved.length} 张图没认出来，你可以补充说明，也可以跳过这几张`
                : `有 ${unresolvedMentionTokens.length} 处 @提及没匹配到图片，指一下是哪张，或选择忽略`,
            options: [],
            fields,
            multi: false,
          },
        };
      }

      return {
        ok: true,
        data: {
          identified: vision.identified.map((record) => ({
            assetId: record.assetId,
            identifiedName: record.identifiedName,
            confidence: record.confidence,
            source: record.source,
          })),
          unresolved: [],
          skippedAssetIds: skipped ? vision.unresolvedAssetIds : [],
          userIdentified,
          mentions: mentions.counts,
          sourceRefs: [batchRef, ...sourceRefs],
          goalSummary: goalText,
          disclaimer: VISION_DISCLAIMER,
        } satisfies ImageUnderstandResult,
        sourceRefs: [batchRef, ...sourceRefs],
        isEstimate: true,
        durationMs: Date.now() - startedAt,
        disclaimer: VISION_DISCLAIMER,
      };
    },
  },

  'travel.itineraryCompose': {
    name: 'travel.itineraryCompose',
    description:
      '以同一检索口径重新向 Provider 取回三类候选，并按天编排成行程（含每日安排、总成本与图片覆盖度）',
    inputSchema: zItineraryComposeInput,
    producesFacts: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryable: true,
    stepType: 'itinerary_compose',

    async execute(input: unknown, ctx: RunContext) {
      const startedAt = Date.now();
      const parsed = zItineraryComposeInput.safeParse(input ?? {});
      if (!parsed.success) {
        return inputRejected('travel.itineraryCompose', parsed.error.issues, input, startedAt);
      }
      const request = parsed.data;
      const brief = resolveTripBrief({
        goalSummary: request.goalSummary,
        city: request.city,
        days: request.days,
        budgetCNY: request.budgetCNY,
        limitPerCategory: request.limitPerCategory,
      });

      const providers = createTripProviders().create(ctx);
      const provider = providers['travel.poi'] as ProviderAdapter<
        Record<string, unknown>,
        TripPoi
      >;

      // 编排所需的每一条候选都必须来自 Provider，且每条都要带 source，
      // 缺 source 的条目会被直接丢弃 —— 编排不掺入任何无源数据。
      const sourceRefs: SourceRef[] = [];
      const pools: Record<TripCategory, TripPoi[]> = {
        attraction: [],
        restaurant: [],
        hotel: [],
      };

      for (const category of TRIP_CATEGORIES) {
        const result = await provider.search(
          {
            city: brief.city,
            category,
            limit: brief.limitPerCategory,
            cityFallback: brief.cityFallbackReason,
          },
          ctx,
        );
        const refs = toSourceRefs(result.source);
        if (refs.length > 0) sourceRefs.push(...refs);
        for (const poi of result.data ?? []) {
          if (typeof poi.source === 'string' && poi.source.length > 0) pools[category].push(poi);
        }
      }

      // 防御：Provider 完全不可用时不编造假数据，而是回退到 fixture 的同口径估算并标记。
      const usablePools = TRIP_CATEGORIES.every((category) => pools[category].length === 0)
        ? undefined
        : pools;

      /* ---- 图片侧：与检索口径一致地重新识别一遍（幂等，零副作用） ---- */
      const attachments = imageAttachments(ctx);
      const vision = listVisionRecords(attachments);
      // ★ 同上：这里也必须读 `answers`（compose 是重试链路的下游，result 同样会被清空）。
      const answers = readAnswers(ctx);
      const skipped =
        readMultiAnswer(answers, IMAGE_QUESTION_ID, UNRESOLVED_ACTION_FIELD).includes(
          SKIP_OPTION_ID,
        );
      const userIdentified = vision.unresolvedAssetIds.flatMap((assetId) => {
        const value = answers[makeFormKey(IMAGE_QUESTION_ID, `${ASSET_FIELD_PREFIX}${assetId}`)];
        const name = typeof value === 'string' ? value.trim() : '';
        return name.length > 0 ? [{ assetId, name }] : [];
      });

      const anchors = [
        ...vision.identified.map((record) => ({
          assetIds: [record.assetId],
          name: record.identifiedName,
          ...(TRIP_CATEGORIES.includes(record.category as TripCategory)
            ? { category: record.category as TripCategory }
            : {}),
        })),
        ...userIdentified.map((item) => ({ assetIds: [item.assetId], name: item.name })),
      ];

      const mentions = parseImageMentions(request.goalSummary ?? '', attachments);
      const notes = mentions.mentions
        .filter((mention) => mention.note.length > 0 && mention.assetIds.length > 0)
        .flatMap((mention) =>
          mention.assetIds.map((assetId) => ({ assetId, text: mention.note })),
        );

      const hasImages = attachments.length > 0;
      const v2 = hasImages
        ? composeItineraryV2({
            city: brief.city,
            days: brief.days,
            limitPerCategory: brief.limitPerCategory,
            anchors,
            ...(usablePools ? { pois: usablePools } : {}),
            requiredAssetIds: attachments.map((item) => item.id),
            ...(skipped ? { skippedAssetIds: vision.unresolvedAssetIds } : {}),
            notes,
          })
        : null;

      // ★ 无图片时**沿用 M2 既有口径**（v1），保证既有回归锁一个字节都不变。
      const fallbackPools = usablePools ?? listPoisByCategory(brief.city, brief.limitPerCategory);
      const itinerary = v2 ?? composeItinerary({
        city: brief.city,
        days: brief.days,
        limitPerCategory: brief.limitPerCategory,
        pois: fallbackPools,
      });

      const summaryMd = [
        `## ${brief.city} ${itinerary.days.length} 天行程总述`,
        `- 来自图片：${anchors.length} 项`,
        ...(v2
          ? [
              `- 覆盖度：${v2.coverage.covered}/${v2.coverage.total}`,
              `- 填充占比：${Math.round(v2.coverage.fillRatio * 100)}%`,
            ]
          : []),
        TRIP_DISCLAIMER,
      ].join('\n');

      return {
        ok: true,
        data: {
          city: itinerary.city,
          days: itinerary.days.map((day) => ({
            day: day.day,
            theme: day.theme,
            items: day.items.map((item) => ({
              name: item.name,
              category: item.category,
              categoryLabel: item.categoryLabel,
              slot: item.slot,
              priceCNY: item.priceCNY,
              source: item.source,
              ...(v2
                ? {
                    origin: (item as { origin?: 'image' | 'fill' }).origin ?? 'fill',
                    assetIds: (item as { assetIds?: string[] }).assetIds ?? [],
                  }
                : { origin: 'fill' as const, assetIds: [] }),
            })),
            notes: (day as { notes?: Array<{ assetId?: string; text: string }> }).notes ?? [],
            stayName: day.stayName,
            stayPriceCNY: day.stayPriceCNY,
            costCNY: day.costCNY,
          })),
          totalCostCNY: itinerary.totalCostCNY,
          budgetCNY: brief.budgetCNY,
          ...(v2 ? { coverage: v2.coverage } : {}),
          summaryBlocks: markdownToBlocks(summaryMd),
          sourceRefs,
          goalSummary: request.goalSummary,
          disclaimer: TRIP_DISCLAIMER,
        } satisfies ItineraryComposeResult,
        sourceRefs,
        isEstimate: true,
        durationMs: Date.now() - startedAt,
        disclaimer: TRIP_DISCLAIMER,
      };
    },
  },
};

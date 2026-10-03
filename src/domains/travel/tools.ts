/**
 * 领域段 ②：tools。
 *
 * 铁律：
 * - `producesFacts: true` 的工具返回**必须带 `SourceRef`**（否则引擎判失败）；
 * - 事实数据只能来自 Provider，工具里不写任何候选数据；
 * - MockRuntime 下每个 step 只能拿到自己的静态 `intent.input`，拿不到上游 step 的结果，
 *   因此编排工具以**同一套检索口径**重新向 Provider 取同一批事实（幂等、零副作用），
 *   而不是引入跨 step 的隐藏状态。
 */
import { z } from 'zod';
import { zSourceRef, type SourceRef } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import type { ProviderAdapter, ToolSet } from '@/shared/domain/types';
import {
  CATEGORY_LABEL,
  MAX_TRIP_DAYS,
  TRIP_CATEGORIES,
  TRIP_DISCLAIMER,
  composeItinerary,
  createTripProviders,
  listPoisByCategory,
  resolveTripBrief,
  zItinerary,
  zTripCategory,
  zTripPoi,
  type TripCategory,
  type TripPoi,
} from './providers';

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

/* ------------------------------------------------------------------ *
 * 返回体（领域侧再和 UI 侧各校验一次）
 * ------------------------------------------------------------------ */

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

export const zItineraryComposeResult = z.object({
  city: z.string().default(''),
  days: zItinerary.shape.days.default([]),
  totalCostCNY: z.number().nonnegative().default(0),
  budgetCNY: z.number().nonnegative().nullable().default(null),
  sourceRefs: z.array(zSourceRef).default([]),
  goalSummary: z.string().default(''),
  disclaimer: z.string().optional(),
});
export type ItineraryComposeResult = z.infer<typeof zItineraryComposeResult>;

function toSourceRefs(source: unknown): SourceRef[] {
  const parsed = zSourceRef.safeParse(source);
  return parsed.success ? [parsed.data] : [];
}

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
      const request = parsed.success ? parsed.data : zPoiSearchInput.parse({});
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

  'travel.itineraryCompose': {
    name: 'travel.itineraryCompose',
    description:
      '以同一检索口径重新向 Provider 取回三类候选，并按天编排成行程（含每日安排与总成本）',
    inputSchema: zItineraryComposeInput,
    producesFacts: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryable: true,
    stepType: 'itinerary_compose',

    async execute(input: unknown, ctx: RunContext) {
      const startedAt = Date.now();
      const parsed = zItineraryComposeInput.safeParse(input ?? {});
      const request = parsed.success ? parsed.data : zItineraryComposeInput.parse({});
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
      const fallbackPools =
        TRIP_CATEGORIES.every((category) => pools[category].length === 0)
          ? listPoisByCategory(brief.city, brief.limitPerCategory)
          : undefined;

      const itinerary = composeItinerary({
        city: brief.city,
        days: brief.days,
        limitPerCategory: brief.limitPerCategory,
        pois: fallbackPools ?? pools,
      });

      return {
        ok: true,
        data: {
          city: itinerary.city,
          days: itinerary.days,
          totalCostCNY: itinerary.totalCostCNY,
          budgetCNY: brief.budgetCNY,
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

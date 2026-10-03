/**
 * 领域段 ③ · 子模块 ③：`compose.ts` —— **行程编排口径**。
 *
 * 边界（设计 §5.2）：
 * - **做**：把候选（POI / 后续的图片识别结果）编成按天行程，产出确定性结果；
 * - **不做**：任何计划级校验（那是 `planCheck.ts` 的事，它才拿得到整份 `Plan`）。
 *
 * 依赖方向：`compose.ts` → `poi.ts`（+ 后续 `vision.ts`）；**禁止反向**（设计 §5.3）。
 *
 * ★ 本文件全部是**纯函数**：同样的入参 → 同样的行程与总价，可单测、可重放。
 * v2 新增的 `origin` / 覆盖度 / 填充产出将在下一批落在这里（等契约 `zAttachment`  landed）。
 */
import { z } from 'zod';
import {
  CATEGORY_LABEL,
  DEFAULT_LIMIT_PER_CATEGORY,
  clampTripDays,
  listPoisByCategory,
  zTripCategory,
  type TripCategory,
  type TripPoi,
} from './poi';

/** 单日安排条目超过该数量 → 行程过满（warning，不阻断执行）。 */
export const MAX_ITEMS_PER_DAY = 4;

const SLOT_SEQUENCE: readonly string[] = ['上午', '下午', '晚上', '夜间加场', '机动时段'];

/* ------------------------------------------------------------------ *
 * 行程数据结构
 * ------------------------------------------------------------------ */

export const zItineraryItem = z.object({
  name: z.string().min(1),
  category: zTripCategory,
  categoryLabel: z.string().min(1),
  slot: z.string().min(1),
  priceCNY: z.number().nonnegative(),
  source: z.string().min(1),
});
export type ItineraryItem = z.infer<typeof zItineraryItem>;

export const zItineraryDay = z.object({
  day: z.number().int().positive(),
  theme: z.string().min(1),
  items: z.array(zItineraryItem).default([]),
  stayName: z.string().optional(),
  stayPriceCNY: z.number().nonnegative().default(0),
  costCNY: z.number().nonnegative().default(0),
});
export type ItineraryDay = z.infer<typeof zItineraryDay>;

export const zItinerary = z.object({
  city: z.string().min(1),
  days: z.array(zItineraryDay).default([]),
  totalCostCNY: z.number().nonnegative().default(0),
});
export type Itinerary = z.infer<typeof zItinerary>;

/* ------------------------------------------------------------------ *
 * 纯函数：编排
 * ------------------------------------------------------------------ */

/** 按天轮流分发（round-robin），保证每天尽量都有安排。**纯函数**。 */
export function spreadOverDays<T>(items: readonly T[], days: number): T[][] {
  const buckets: T[][] = Array.from({ length: Math.max(1, days) }, () => []);
  items.forEach((item, index) => {
    buckets[index % buckets.length].push(item);
  });
  return buckets;
}

export interface ComposeItineraryInput {
  city: string;
  days: number;
  limitPerCategory?: number;
  /** 传入则用真实取回的事实；不传则用 fixture 估算同一份数据（口径一致）。 */
  pois?: Partial<Record<TripCategory, readonly TripPoi[]>>;
}

function toItineraryItem(poi: TripPoi, index: number): ItineraryItem {
  return {
    name: poi.name,
    category: poi.category,
    categoryLabel: CATEGORY_LABEL[poi.category],
    slot: SLOT_SEQUENCE[index] ?? `活动 ${index + 1}`,
    priceCNY: poi.priceCNY,
    source: poi.source,
  };
}

/**
 * 把候选编排成按天的行程。**纯函数**：同样的入参 → 同样的行程与总价。
 *
 * 规则（确定性）：
 * - 景点与餐厅按 **round-robin** 分到各天，保证每天都有安排；
 * - 酒店按天轮换，每晚计一次房费，计入当天成本；
 * - 单日成本 = 当日所有条目价格之和 + 当晚房费。
 */
export function composeItinerary(input: ComposeItineraryInput): Itinerary {
  const requestedDays = clampTripDays(input.days);
  const limit = input.limitPerCategory ?? DEFAULT_LIMIT_PER_CATEGORY;
  const pools = input.pois ?? listPoisByCategory(input.city, limit);

  const attractions = pools.attraction ?? [];
  const restaurants = pools.restaurant ?? [];
  const hotels = pools.hotel ?? [];

  const attractionBuckets = spreadOverDays(attractions, requestedDays);
  const restaurantBuckets = spreadOverDays(restaurants, requestedDays);

  const days: ItineraryDay[] = [];
  for (let index = 0; index < requestedDays; index += 1) {
    const items: ItineraryItem[] = [];
    for (const poi of attractionBuckets[index]) {
      items.push(toItineraryItem(poi, items.length));
    }
    for (const poi of restaurantBuckets[index]) {
      items.push(toItineraryItem(poi, items.length));
    }
    const stay = hotels.length > 0 ? hotels[index % hotels.length] : undefined;
    const visitCostCNY = items.reduce((sum, item) => sum + item.priceCNY, 0);
    const stayPriceCNY = stay?.priceCNY ?? 0;
    const headline = items[0]?.name ?? '机动・自由活动';

    days.push({
      day: index + 1,
      theme: `第 ${index + 1} 天 · ${headline}`,
      items,
      ...(stay ? { stayName: stay.name } : {}),
      stayPriceCNY,
      costCNY: visitCostCNY + stayPriceCNY,
    });
  }

  return {
    city: input.city,
    days,
    totalCostCNY: days.reduce((sum, day) => sum + day.costCNY, 0),
  };
}

/**
 * 领域段 ③ · 子模块 ③：`compose.ts` —— **行程编排口径**。
 *
 * 边界（设计 §5.2）：
 * - **做**：把候选（POI / 图片识别结果）编成按天行程，产出确定性结果，
 *   并给出 `origin`（意图溯源）/ `coverage`（覆盖度）/ `notes`（@ 说明）；
 * - **不做**：任何计划级校验（那是 `planCheck.ts` 的事，它才拿得到整份 `Plan`）。
 *
 * 依赖方向：`compose.ts` → `poi.ts`（+ `vision.ts` 的类型）；**禁止反向**（设计 §5.3）。
 *
 * ★ 本文件全部是**纯函数**：同样的入参 → 同样的行程与总价，可单测、可重放。
 *
 * ★ `origin` 有两套语义，**禁止复用 `zStepOrigin`**（K6 / §3.3）：
 * 这里的 `origin` 是**意图溯源**（`image` 来自图片 / `fill` 是填充推荐），
 * `Step.origin` 是**编辑溯源**（这一步谁造的）。两者同名不同义。
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

/** 填充项上限：每天最多 2 条（K14，工程判断）。 */
export const MAX_FILL_PER_DAY = 2;
/** 填充项占总条目的上限 0.3（K14；PRD 明标：无实测依据的工程判断，需真机校准）。 */
export const MAX_FILL_RATIO = 0.3;

const SLOT_SEQUENCE: readonly string[] = ['上午', '下午', '晚上', '夜间加场', '机动时段'];

/* ------------------------------------------------------------------ *
 * 行程数据结构（v1：M2 既有口径，行为不变）
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
 * 行程数据结构（v2：图片驱动）
 * ------------------------------------------------------------------ */

/**
 * 行程条目的**意图溯源**。
 * - `image`：这一项来自用户上传的图片（参与覆盖度分子）；
 * - `fill`：这一项是 Provider 给的填充推荐（**不参与**覆盖度分子，PRD §3.3）。
 */
export const zItineraryOrigin = z.enum(['image', 'fill']);
export type ItineraryOrigin = z.infer<typeof zItineraryOrigin>;

/** 用户的 `@图片名` 说明。**关联关系必须是数据，不是字符串**（PRD §3.6）。 */
export const zItineraryNote = z.object({
  /** 有值 = 这段说明绑定到某张图；无值 = 全局说明。 */
  assetId: z.string().optional(),
  text: z.string().min(1),
});
export type ItineraryNote = z.infer<typeof zItineraryNote>;

export const zItineraryItemV2 = zItineraryItem.extend({
  origin: zItineraryOrigin,
  /** `origin:'image'` 时非空（同名多命中会带上**全部** assetId）。 */
  assetIds: z.array(z.string()).default([]),
});
export type ItineraryItemV2 = z.infer<typeof zItineraryItemV2>;

export const zItineraryDayV2 = z.object({
  day: z.number().int().positive(),
  theme: z.string().min(1),
  items: z.array(zItineraryItemV2).default([]),
  notes: z.array(zItineraryNote).default([]),
  stayName: z.string().optional(),
  stayPriceCNY: z.number().nonnegative().default(0),
  costCNY: z.number().nonnegative().default(0),
});
export type ItineraryDayV2 = z.infer<typeof zItineraryDayV2>;

/**
 * 覆盖度（§3.2 四条口径）：
 * ① 度量对象 = **assetId 集合**（不是名称、不是像素，同名共存下只有 assetId 稳定）；
 * ④ 它标注进 `ItineraryCard` props，**不进 violations**（violations 用户看不到）。
 */
export const zCoverage = z.object({
  /** 分母：本轮输入的图片总数。 */
  total: z.number().int().nonnegative(),
  /** 分子：已排进行程的 assetId 数（**填充项不计入**）。 */
  covered: z.number().int().nonnegative(),
  /** 已排入之外、用户**显式跳过**的 assetId。 */
  skippedAssetIds: z.array(z.string()).default([]),
  /** 既没排进也没跳过的 assetId —— 这是"漏排"，必须在 UI 上可见。 */
  missingAssetIds: z.array(z.string()).default([]),
  /** covered / total；total=0 时为 1（没有图片就不存在漏排）。 */
  ratio: z.number().min(0).max(1),
  fillCount: z.number().int().nonnegative(),
  fillRatio: z.number().min(0).max(1),
});
export type Coverage = z.infer<typeof zCoverage>;

export const zItineraryV2 = z.object({
  city: z.string().min(1),
  days: z.array(zItineraryDayV2).default([]),
  totalCostCNY: z.number().nonnegative().default(0),
  coverage: zCoverage,
});
export type ItineraryV2 = z.infer<typeof zItineraryV2>;

/**
 * 图片锚点：一张（或多张同名）图 + 它识别出的名字。
 *
 * ★ 这里存的是**名字**而不是 POI：识别结果来自 `vision.ts`（数据源），
 * "这个名字对应哪条 POI 事实"由本文件的 `joinAnchorToPoi` 去 POI 池里查 ——
 * 查不到就**不能编一条**，只能记为 missing（红线 16）。
 */
export const zImageAnchor = z.object({
  assetIds: z.array(z.string()).default([]),
  name: z.string().min(1),
  category: zTripCategory.optional(),
});
export type ImageAnchor = z.infer<typeof zImageAnchor>;

/* ------------------------------------------------------------------ *
 * 纯函数：v1 编排（M2 既有口径）
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

/* ------------------------------------------------------------------ *
 * 纯函数：v2 编排（图片驱动 + 覆盖度 + 填充）
 * ------------------------------------------------------------------ */

export interface ComposeV2Input {
  city: string;
  days: number;
  limitPerCategory?: number;
  /** 来自图片识别的锚点（origin:'image' 的候选来源）。 */
  anchors?: readonly ImageAnchor[];
  /** Provider 取回的候选池：既是锚点的 POI 来源，也是填充来源。 */
  pois?: Partial<Record<TripCategory, readonly TripPoi[]>>;
  /** 覆盖度分母：本轮输入的图片 assetId 全集。 */
  requiredAssetIds?: readonly string[];
  /** 用户**显式跳过**的 assetId（不进 missing，也不进 covered）。 */
  skippedAssetIds?: readonly string[];
  /** 用户的 `@` 说明（带 assetId 关联）。 */
  notes?: readonly ItineraryNote[];
}

/** 名字归一：与 `vision.ts` 的口径保持一致（trim + 小写）。 */
function normalizeName(name: string): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * 锚点 → POI 事实的 join。**纯函数**。
 *
 * ★ 查不到就返回 `undefined`（**绝不造一条**），调用方把它记成 missing ——
 * "识别出来了但我们没有这条事实"与"压根没识别出来"是两种不同的未覆盖，
 * 但两者都必须**可见**，都不能靠填充项蒙混过去。
 */
export function joinAnchorToPoi(
  anchor: ImageAnchor,
  pools: Partial<Record<TripCategory, readonly TripPoi[]>>,
): TripPoi | undefined {
  const target = normalizeName(anchor.name);
  const candidates = anchor.category
    ? (pools[anchor.category] ?? [])
    : [...(pools.attraction ?? []), ...(pools.restaurant ?? []), ...(pools.hotel ?? [])];

  const exact = candidates.find((poi) => normalizeName(poi.name) === target);
  if (exact) return exact;
  // 去扩展名再试一次（识别结果可能带 `.jpg`，POI 名不带）。
  return candidates.find((poi) => normalizeName(poi.name.replace(/\.[^.]*$/, '')) === target);
}

/**
 * 把「识别结果 + POI 候选」编成按天行程，并产出覆盖度。**纯函数**。
 *
 * 规则（确定性）：
 * - 图片锚点先按 round-robin 落到各天（`origin:'image'`），**它们优先**，因为覆盖度是硬约束；
 * - 各天再补最多 `MAX_FILL_PER_DAY` 条填充（`origin:'fill'`，来自 Provider，绝不编造）；
 * - 全局填充占比超过 `MAX_FILL_RATIO` 就从**最后一天往前**裁（PRD §3.3：填充是"连接用"不是"凑数用"）；
 * - 酒店按天轮换，每晚计一次房费。
 */
export function composeItineraryV2(input: ComposeV2Input): ItineraryV2 {
  const requestedDays = clampTripDays(input.days);
  const limit = input.limitPerCategory ?? DEFAULT_LIMIT_PER_CATEGORY;
  const pools = input.pois ?? listPoisByCategory(input.city, limit);
  const anchors = input.anchors ?? [];
  const skipped = new Set(input.skippedAssetIds ?? []);

  /* ① 锚点 → 条目（查不到 POI 的锚点不进条目，其 assetId 落到 missing） */
  const imageItems: Array<ItineraryItemV2 & { dayIndex: number }> = [];
  const placedAssetIds = new Set<string>();
  const bucketOf = spreadOverDays(anchors, requestedDays);

  for (let dayIndex = 0; dayIndex < requestedDays; dayIndex += 1) {
    for (const anchor of bucketOf[dayIndex]) {
      const poi = joinAnchorToPoi(anchor, pools);
      if (!poi) continue;
      for (const id of anchor.assetIds) placedAssetIds.add(id);
      imageItems.push({
        ...toItineraryItem(poi, 0),
        origin: 'image',
        assetIds: [...new Set(anchor.assetIds)],
        dayIndex,
      });
    }
  }

  /* ② 填充：每天最多 MAX_FILL_PER_DAY 条，且不许与已排条目重名 */
  const usedNames = new Set(imageItems.map((item) => normalizeName(item.name)));
  const fillPool: TripPoi[] = [
    ...(pools.attraction ?? []),
    ...(pools.restaurant ?? []),
  ].filter((poi) => !usedNames.has(normalizeName(poi.name)));

  const fillItems: Array<ItineraryItemV2 & { dayIndex: number }> = [];
  let cursor = 0;
  for (let dayIndex = 0; dayIndex < requestedDays; dayIndex += 1) {
    for (let slot = 0; slot < MAX_FILL_PER_DAY; slot += 1) {
      const poi = fillPool[cursor];
      if (!poi) break;
      cursor += 1;
      usedNames.add(normalizeName(poi.name));
      fillItems.push({ ...toItineraryItem(poi, 0), origin: 'fill', assetIds: [], dayIndex });
    }
  }

  /* ③ 填充占比闸门：fill/(image+fill) ≤ MAX_FILL_RATIO（没有图片项时不设上限） */
  let keptFill = fillItems;
  if (imageItems.length > 0) {
    // fill ≤ image * r / (1 - r)
    const cap = Math.floor((imageItems.length * MAX_FILL_RATIO) / (1 - MAX_FILL_RATIO));
    keptFill = fillItems.slice(0, Math.max(0, cap));
  }

  /* ④ 组装每天（slot 按天内的实际顺序重新编号，保证展示口径一致） */
  const hotels = pools.hotel ?? [];
  const days: ItineraryDayV2[] = [];
  let fillCount = 0;

  for (let dayIndex = 0; dayIndex < requestedDays; dayIndex += 1) {
    const raw = [
      ...imageItems.filter((item) => item.dayIndex === dayIndex),
      ...keptFill.filter((item) => item.dayIndex === dayIndex),
    ];
    const items: ItineraryItemV2[] = raw.map((item, index) => ({
      name: item.name,
      category: item.category,
      categoryLabel: item.categoryLabel,
      slot: SLOT_SEQUENCE[index] ?? `活动 ${index + 1}`,
      priceCNY: item.priceCNY,
      source: item.source,
      origin: item.origin,
      assetIds: item.assetIds,
    }));
    fillCount += items.filter((item) => item.origin === 'fill').length;

    const stay = hotels.length > 0 ? hotels[dayIndex % hotels.length] : undefined;
    const visitCostCNY = items.reduce((sum, item) => sum + item.priceCNY, 0);
    const stayPriceCNY = stay?.priceCNY ?? 0;
    const headline = items[0]?.name ?? '机动・自由活动';

    days.push({
      day: dayIndex + 1,
      theme: `第 ${dayIndex + 1} 天 · ${headline}`,
      items,
      notes: [],
      ...(stay ? { stayName: stay.name } : {}),
      stayPriceCNY,
      costCNY: visitCostCNY + stayPriceCNY,
    });
  }

  /* ⑤ 说明文本落到"它关联的那张图所在的天"；没关联的落到第 1 天 */
  const dayOfAsset = new Map<string, number>();
  for (let dayIndex = 0; dayIndex < requestedDays; dayIndex += 1) {
    for (const item of days[dayIndex].items) {
      for (const id of item.assetIds) {
        if (!dayOfAsset.has(id)) dayOfAsset.set(id, dayIndex);
      }
    }
  }
  for (const note of input.notes ?? []) {
    const dayIndex = note.assetId ? dayOfAsset.get(note.assetId) : undefined;
    const target = days[dayIndex ?? 0];
    if (!target) continue;
    target.notes = [...target.notes, { ...(note.assetId ? { assetId: note.assetId } : {}), text: note.text }];
  }

  /* ⑥ 覆盖度（分母 = assetId 集合，填充项不计入分子） */
  const required = [...new Set(input.requiredAssetIds ?? [])];
  const covered = required.filter((id) => placedAssetIds.has(id) && !skipped.has(id));
  const missing = required.filter((id) => !placedAssetIds.has(id) && !skipped.has(id));
  const totalItems = imageItems.length + fillCount;

  return zItineraryV2.parse({
    city: input.city,
    days,
    totalCostCNY: days.reduce((sum, day) => sum + day.costCNY, 0),
    coverage: {
      total: required.length,
      covered: covered.length,
      skippedAssetIds: required.filter((id) => skipped.has(id)),
      missingAssetIds: missing,
      ratio: required.length === 0 ? 1 : covered.length / required.length,
      fillCount,
      fillRatio: totalItems === 0 ? 0 : fillCount / totalItems,
    },
  });
}

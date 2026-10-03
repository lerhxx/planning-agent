/**
 * 领域段 ③ · 子模块 ①：`poi.ts` —— **POI 事实数据源 + 通用口径解析**。
 *
 * 边界（设计 §5.2）：
 * - **做**：fixture 数据源（`travel.poi` Provider）、「城市 / 天数 / 预算」三条口径的解析与回落判定；
 * - **不做**：行程编排（→ `compose.ts`）、计划级校验（→ `planCheck.ts`）、图片理解（→ `vision.ts`）。
 *
 * 依赖方向：**只依赖 `shared/**`，不依赖同目录任何子模块**（禁止反向与循环，设计 §5.3）。
 *
 * 全部 fixture 都是本地常量表，**零网络、零密钥**。
 * 每条候选都带 `source` 字段，整批结果带 `SourceRef`，且 `isEstimate: true` + 免责声明。
 */
import { z } from 'zod';
import type { ProviderAdapter } from '@/shared/domain/types';
import type { RunContext } from '@/shared/run/types';

/* ------------------------------------------------------------------ *
 * 常量与基础 schema
 * ------------------------------------------------------------------ */

export const SOURCE_NAMESPACE = 'travel.poi';
export const POI_PROVIDER_ID = 'travel.poi';

export const DEFAULT_TRIP_CITY = '上海';
export const DEFAULT_TRIP_DAYS = 3;
export const DEFAULT_LIMIT_PER_CATEGORY = 4;
export const MAX_TRIP_DAYS = 14;

export const TRIP_DISCLAIMER =
  '价格、评分与地址均来自领域内置 fixture Provider（离线样例数据），不代表实时报价，出行前请自行复核';

export const zTripCategory = z.enum(['attraction', 'restaurant', 'hotel']);
export type TripCategory = z.infer<typeof zTripCategory>;

export const TRIP_CATEGORIES: readonly TripCategory[] = ['attraction', 'restaurant', 'hotel'];

export const CATEGORY_LABEL: Record<TripCategory, string> = {
  attraction: '景点',
  restaurant: '餐厅',
  hotel: '酒店',
};

/**
 * 城市回落的原因。
 *
 * 两种回落**必须能被区分**：用户写了"杭州"（我们没数据）与用户压根没写城市，
 * 界面上的说法不该一样 —— 前者是"你要的我们没有"，后者是"你没说，我们先用了默认"。
 */
export const zCityFallbackReason = z.enum(['none', 'unsupported-city', 'city-unspecified']);
export type CityFallbackReason = z.infer<typeof zCityFallbackReason>;

/** 回落到默认城市时，SourceRef.label 上要挂的说明。'none' 表示没回落，不挂任何东西。 */
export const CITY_FALLBACK_NOTE: Readonly<Record<CityFallbackReason, string>> = {
  none: '',
  'unsupported-city': '（目标城市无样例数据，已回落到默认城市）',
  'city-unspecified': '（目标未指定城市，已使用默认城市样例）',
};

/* ------------------------------------------------------------------ *
 * 单条候选 + 查询
 * ------------------------------------------------------------------ */

export const zTripPoi = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  city: z.string().min(1),
  category: zTripCategory,
  rating: z.number().min(0).max(5),
  priceLevel: z.number().int().min(1).max(4),
  /** 门票 / 人均参考价，单位：元。 */
  priceCNY: z.number().nonnegative(),
  address: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** ★ 反幻觉：每条事实都要能溯源。 */
  source: z.string().min(1),
});
export type TripPoi = z.infer<typeof zTripPoi>;

/**
 * 从**步骤结果**还原出来的候选。
 *
 * 参与成本重算的只有 `name` / `category` / `priceCNY` / `source` 四项；
 * `city` 与 `address` 在上游结果里可能根本不存在。因此这里**放宽**：
 *
 * ★ 不能拿 `city: ''` / `address: ''` 去喂 `zTripPoi`（两者都是 `min(1)`）——
 * 那会在「事实步骤已产出结果之后发生重排」时抛 ZodError，
 * 把整条 run 打成 `INTERNAL_ERROR`（P0：travel 下任何重排都崩）。
 */
export const zFactDerivedPoi = zTripPoi.omit({ city: true, address: true }).extend({
  city: z.string(),
  address: z.string(),
});
export type FactDerivedPoi = z.infer<typeof zFactDerivedPoi>;

export const zPoiQuery = z.object({
  city: z.string().min(1).default(DEFAULT_TRIP_CITY),
  category: zTripCategory.default('attraction'),
  limit: z.number().int().positive().max(12).default(DEFAULT_LIMIT_PER_CATEGORY),
  /**
   * 调用方已判定的回落原因，显式传入。
   * 不传则按 `resolveCityName(city)` 自行判断 —— 但那样只能识别"城市名不在表里"，
   * 识别不出"目标里压根没写城市"（见 `resolveTripBrief`）。
   */
  cityFallback: zCityFallbackReason.optional(),
});
export type PoiQuery = z.infer<typeof zPoiQuery>;

/* ------------------------------------------------------------------ *
 * fixture 数据（离线常量表）
 * ------------------------------------------------------------------ */

export const POI_FIXTURES: Readonly<Record<string, Readonly<Record<TripCategory, readonly TripPoi[]>>>> = {
  上海: {
    attraction: [
      { id: 'sh-a-1', name: '外滩', city: '上海', category: 'attraction', rating: 4.7, priceLevel: 1, priceCNY: 0, address: '上海市黄浦区中山东一路', tags: ['江景', '夜景'], source: 'fixture://travel/poi/sh-a-1' },
      { id: 'sh-a-2', name: '豫园', city: '上海', category: 'attraction', rating: 4.5, priceLevel: 2, priceCNY: 40, address: '上海市黄浦区安仁街137号', tags: ['园林', '老城厢'], source: 'fixture://travel/poi/sh-a-2' },
      { id: 'sh-a-3', name: '上海博物馆', city: '上海', category: 'attraction', rating: 4.8, priceLevel: 1, priceCNY: 0, address: '上海市黄浦区人民大道201号', tags: ['博物馆', '室内'], source: 'fixture://travel/poi/sh-a-3' },
      { id: 'sh-a-4', name: '田子坊', city: '上海', category: 'attraction', rating: 4.3, priceLevel: 2, priceCNY: 0, address: '上海市黄浦区泰康路210弄', tags: ['街区', '文创'], source: 'fixture://travel/poi/sh-a-4' },
    ],
    restaurant: [
      { id: 'sh-r-1', name: '南翔馒头店', city: '上海', category: 'restaurant', rating: 4.4, priceLevel: 2, priceCNY: 90, address: '上海市黄浦区豫园路85号', tags: ['小笼', '本帮'], source: 'fixture://travel/poi/sh-r-1' },
      { id: 'sh-r-2', name: '老吉士酒家', city: '上海', category: 'restaurant', rating: 4.6, priceLevel: 3, priceCNY: 220, address: '上海市徐汇区天平路41号', tags: ['本帮', '需要排队'], source: 'fixture://travel/poi/sh-r-2' },
      { id: 'sh-r-3', name: '阿娘面馆', city: '上海', category: 'restaurant', rating: 4.3, priceLevel: 1, priceCNY: 45, address: '上海市黄浦区思南路36号', tags: ['面馆', '黄鱼面'], source: 'fixture://travel/poi/sh-r-3' },
      { id: 'sh-r-4', name: '光明邨大酒家', city: '上海', category: 'restaurant', rating: 4.2, priceLevel: 2, priceCNY: 120, address: '上海市黄浦区淮海中路588号', tags: ['鲜肉月饼', '家常'], source: 'fixture://travel/poi/sh-r-4' },
    ],
    hotel: [
      { id: 'sh-h-1', name: '费尔蒙和平饭店', city: '上海', category: 'hotel', rating: 4.8, priceLevel: 4, priceCNY: 980, address: '上海市黄浦区南京东路20号', tags: ['外滩景观', '老建筑'], source: 'fixture://travel/poi/sh-h-1' },
      { id: 'sh-h-2', name: '锦江都城经典上海南京东路店', city: '上海', category: 'hotel', rating: 4.4, priceLevel: 3, priceCNY: 520, address: '上海市黄浦区南京东路505号', tags: ['地铁直达'], source: 'fixture://travel/poi/sh-h-2' },
      { id: 'sh-h-3', name: '全季酒店上海外滩店', city: '上海', category: 'hotel', rating: 4.3, priceLevel: 2, priceCNY: 420, address: '上海市黄浦区中山南路318号', tags: ['性价比'], source: 'fixture://travel/poi/sh-h-3' },
    ],
  },
  北京: {
    attraction: [
      { id: 'bj-a-1', name: '故宫博物院', city: '北京', category: 'attraction', rating: 4.9, priceLevel: 2, priceCNY: 60, address: '北京市东城区景山前街4号', tags: ['世界遗产', '需预约'], source: 'fixture://travel/poi/bj-a-1' },
      { id: 'bj-a-2', name: '颐和园', city: '北京', category: 'attraction', rating: 4.7, priceLevel: 2, priceCNY: 30, address: '北京市海淀区新建宫门路19号', tags: ['皇家园林'], source: 'fixture://travel/poi/bj-a-2' },
      { id: 'bj-a-3', name: '天坛公园', city: '北京', category: 'attraction', rating: 4.6, priceLevel: 2, priceCNY: 15, address: '北京市东城区天坛路甲1号', tags: ['古建筑'], source: 'fixture://travel/poi/bj-a-3' },
      { id: 'bj-a-4', name: '798艺术区', city: '北京', category: 'attraction', rating: 4.4, priceLevel: 1, priceCNY: 0, address: '北京市朝阳区酒仙桥路4号', tags: ['展览', '工业风'], source: 'fixture://travel/poi/bj-a-4' },
    ],
    restaurant: [
      { id: 'bj-r-1', name: '全聚德前门店', city: '北京', category: 'restaurant', rating: 4.3, priceLevel: 3, priceCNY: 260, address: '北京市东城区前门大街30号', tags: ['烤鸭'], source: 'fixture://travel/poi/bj-r-1' },
      { id: 'bj-r-2', name: '姚记炒肝店', city: '北京', category: 'restaurant', rating: 4.1, priceLevel: 1, priceCNY: 40, address: '北京市东城区鼓楼东大街311号', tags: ['小吃', '卤煮'], source: 'fixture://travel/poi/bj-r-2' },
      { id: 'bj-r-3', name: '花家怡园簋街店', city: '北京', category: 'restaurant', rating: 4.5, priceLevel: 3, priceCNY: 180, address: '北京市东城区簋街东直门内大街235号', tags: ['京菜', '夜宵'], source: 'fixture://travel/poi/bj-r-3' },
      { id: 'bj-r-4', name: '聚宝源牛街输入胡同店', city: '北京', category: 'restaurant', rating: 4.4, priceLevel: 2, priceCNY: 130, address: '北京市西城区输入胡同58号', tags: ['涮肉'], source: 'fixture://travel/poi/bj-r-4' },
    ],
    hotel: [
      { id: 'bj-h-1', name: '王府井希尔顿酒店', city: '北京', category: 'hotel', rating: 4.6, priceLevel: 4, priceCNY: 900, address: '北京市东城区王府井东街8号', tags: ['步行可达故宫'], source: 'fixture://travel/poi/bj-h-1' },
      { id: 'bj-h-2', name: '北京饭店诺金', city: '北京', category: 'hotel', rating: 4.7, priceLevel: 4, priceCNY: 850, address: '北京市东城区东长安街33号', tags: ['长安街'], source: 'fixture://travel/poi/bj-h-2' },
      { id: 'bj-h-3', name: '如家酒店北京前门店', city: '北京', category: 'hotel', rating: 4.1, priceLevel: 1, priceCNY: 320, address: '北京市西城区粮食店街61号', tags: ['性价比'], source: 'fixture://travel/poi/bj-h-3' },
    ],
  },
  成都: {
    attraction: [
      { id: 'cd-a-1', name: '成都大熊猫繁育研究基地', city: '成都', category: 'attraction', rating: 4.8, priceLevel: 2, priceCNY: 55, address: '成都市成华区熊猫大道1375号', tags: ['亲子', '早场人少'], source: 'fixture://travel/poi/cd-a-1' },
      { id: 'cd-a-2', name: '宽窄巷子', city: '成都', category: 'attraction', rating: 4.5, priceLevel: 1, priceCNY: 0, address: '成都市青羊区长顺上街127号', tags: ['街区', '茶馆'], source: 'fixture://travel/poi/cd-a-2' },
      { id: 'cd-a-3', name: '武侯祠', city: '成都', category: 'attraction', rating: 4.6, priceLevel: 2, priceCNY: 50, address: '成都市武侯区武侯祠大街231号', tags: ['三国', '园林'], source: 'fixture://travel/poi/cd-a-3' },
      { id: 'cd-a-4', name: '锦里古街', city: '成都', category: 'attraction', rating: 4.4, priceLevel: 1, priceCNY: 0, address: '成都市武侯区武侯祠大街231号附1号', tags: ['夜景', '小吃'], source: 'fixture://travel/poi/cd-a-4' },
    ],
    restaurant: [
      { id: 'cd-r-1', name: '陈麻婆豆腐骡马市店', city: '成都', category: 'restaurant', rating: 4.4, priceLevel: 2, priceCNY: 90, address: '成都市青羊区西玉龙街197号', tags: ['川菜', '麻婆豆腐'], source: 'fixture://travel/poi/cd-r-1' },
      { id: 'cd-r-2', name: '小龙坎火锅春熙路店', city: '成都', category: 'restaurant', rating: 4.5, priceLevel: 2, priceCNY: 160, address: '成都市锦江区春熙路街道中纱帽街8号', tags: ['火锅', '需排队'], source: 'fixture://travel/poi/cd-r-2' },
      { id: 'cd-r-3', name: '钟水饺春熙路店', city: '成都', category: 'restaurant', rating: 4.2, priceLevel: 1, priceCNY: 35, address: '成都市锦江区春熙路南段6-8号', tags: ['小吃', '红油'], source: 'fixture://travel/poi/cd-r-3' },
      { id: 'cd-r-4', name: '马旺子川小馆', city: '成都', category: 'restaurant', rating: 4.3, priceLevel: 3, priceCNY: 190, address: '成都市锦江区中纱帽街8号', tags: ['川菜', '宴请'], source: 'fixture://travel/poi/cd-r-4' },
    ],
    hotel: [
      { id: 'cd-h-1', name: '成都太古里博舍酒店', city: '成都', category: 'hotel', rating: 4.7, priceLevel: 4, priceCNY: 700, address: '成都市锦江区中纱帽街8号', tags: ['设计感'], source: 'fixture://travel/poi/cd-h-1' },
      { id: 'cd-h-2', name: '川投国际酒店', city: '成都', category: 'hotel', rating: 4.4, priceLevel: 3, priceCNY: 480, address: '成都市武侯区临江西路1号', tags: ['商务'], source: 'fixture://travel/poi/cd-h-2' },
      { id: 'cd-h-3', name: '如家成都春熙路店', city: '成都', category: 'hotel', rating: 4.1, priceLevel: 1, priceCNY: 300, address: '成都市锦江区荔枝巷27号', tags: ['性价比'], source: 'fixture://travel/poi/cd-h-3' },
    ],
  },
};

/* ------------------------------------------------------------------ *
 * 纯函数：城市解析 / 目标口径解析
 * ------------------------------------------------------------------ */

export function clampTripDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_TRIP_DAYS;
  return Math.max(1, Math.min(MAX_TRIP_DAYS, Math.trunc(days)));
}

/** 城市名归一：命中 fixture 表则用真实键，否则回落到默认城市（并标记 fallback）。 */
export function resolveCityName(raw: string): { city: string; fallback: boolean } {
  const text = (raw ?? '').trim();
  const hit = Object.keys(POI_FIXTURES).find((key) => text.includes(key));
  if (hit) return { city: hit, fallback: false };
  return { city: DEFAULT_TRIP_CITY, fallback: true };
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/**
 * 城市名提示表 —— **与 `POI_FIXTURES` 刻意分开的两张表**。
 *
 * - `CITY_HINTS` 回答的是「用户有没有写城市」；
 * - `POI_FIXTURES` 的键回答的是「我们有没有这座城市的数据」。
 *
 * 混用这两者（早期实现就是用 fixture 键去目标里找）会让
 * "写了杭州但我们没数据"塌缩成"压根没写城市" —— 两种回落的文案就再也分不开了（P1）。
 * 前三个是有数据的城市，其余只是常见地名，用来识别"用户确实指定了城市"。
 */
export const CITY_HINTS: readonly string[] = [
  '上海', '北京', '成都',
  '杭州', '广州', '深圳', '西安', '重庆', '南京', '苏州', '厦门', '三亚',
  '青岛', '武汉', '长沙', '天津', '昆明', '大理', '丽江', '桂林', '张家界',
  '哈尔滨', '乌鲁木齐', '拉萨', '香港', '澳门', '台北',
  '东京', '大阪', '曼谷', '新加坡', '巴黎', '伦敦', '纽约',
];

const DAYS_ARABIC_PATTERN = /(\d+)\s*(?:日|天)/;
const DAYS_CN_PATTERN = /([一二两三四五六七八九十])\s*(?:日|天)/;
const BUDGET_PATTERN = /(?:预算|花费|不超过|控制在|最多花)[^\d]{0,10}(\d+(?:\.\d+)?)/;
const SIMPLE_BUDGET_PATTERN = /(\d+(?:\.\d+)?)\s*(?:元|块|rmb|cny)/i;

/** 从自然语言目标里抽取「城市 / 天数 / 预算」三条通用口径。**纯函数**。 */
export function parseTripBrief(
  raw: string,
): { city: string | null; days: number | null; budgetCNY: number | null } {
  const text = raw ?? '';

  // ★ 用 CITY_HINTS（不是 POI_FIXTURES 的键）：这里要的是"用户写了哪座城市"，
  // 而不是"我们有哪些城市"。支持与否由 `resolveCityName` 另行判断。
  const city = CITY_HINTS.find((key) => text.includes(key)) ?? null;

  let days: number | null = null;
  const arabic = DAYS_ARABIC_PATTERN.exec(text);
  if (arabic) {
    days = Number(arabic[1]);
  } else {
    const chinese = DAYS_CN_PATTERN.exec(text);
    if (chinese) days = CN_DIGITS[chinese[1]] ?? null;
  }
  if (days !== null && (!Number.isFinite(days) || days <= 0)) days = null;

  let budgetCNY: number | null = null;
  const budget = BUDGET_PATTERN.exec(text) ?? SIMPLE_BUDGET_PATTERN.exec(text);
  if (budget) {
    const value = Number(budget[1]);
    if (Number.isFinite(value) && value >= 0) budgetCNY = value;
  }

  return { city, days, budgetCNY };
}

export const zTripBriefOverrides = z.object({
  goalSummary: z.string().optional(),
  city: z.string().optional(),
  days: z.number().optional(),
  budgetCNY: z.number().nonnegative().optional(),
  limitPerCategory: z.number().int().positive().max(12).optional(),
});
export type TripBriefOverrides = z.infer<typeof zTripBriefOverrides>;

export interface TripBrief {
  /** 用户原话里写明的城市（可能是自由文本）。 */
  requestedCity: string;
  /** 实际用于检索的城市（回落到 fixture 支持的城市之一）。 */
  city: string;
  cityFallback: boolean;
  /** 为什么回落到默认城市（`none` 表示没回落）。决定 SourceRef 上的标注文案。 */
  cityFallbackReason: CityFallbackReason;
  days: number;
  budgetCNY: number | null;
  limitPerCategory: number;
  /** 目标里明确写了天数时才有值，用于「天数与目标不一致」校验。 */
  daysFromGoal: number | null;
}

/**
 * 把「领域侧显式入参」与「目标原话解析结果」合成一条口径。
 *
 * 优先级：**显式入参 > 目标原话 > 默认值**。纯函数。
 */
export function resolveTripBrief(input: TripBriefOverrides): TripBrief {
  const parsed = parseTripBrief(input.goalSummary ?? '');
  // ★ 区分「没写城市」与「写了城市」：先取出显式写法，再决定要不要补默认值。
  // 直接 `(input.city ?? parsed.city ?? DEFAULT_TRIP_CITY)` 会让"目标里压根没写城市"
  // 与"目标写了上海"塌缩成同一个值，于是后者恒命中、fallback 恒为 false ——
  // 用户要杭州却拿到上海数据，界面还写着可溯源（P1）。
  const explicitCity = (input.city ?? parsed.city ?? '').trim();
  const requestedCity = explicitCity.length > 0 ? explicitCity : DEFAULT_TRIP_CITY;
  const resolution = resolveCityName(requestedCity);
  // 两种情况都算回落：**没写城市**（用户没指定）与 **写了但 fixture 没有**（有指定但无数据）。
  // 两者拿的都是默认城市的样例，必须在 SourceRef 上标注，否则等于把假数据包装成可溯源的真数据。
  const cityFallbackReason: CityFallbackReason =
    explicitCity.length === 0
      ? 'city-unspecified'
      : resolution.fallback
        ? 'unsupported-city'
        : 'none';
  return {
    requestedCity,
    city: resolution.city,
    cityFallback: cityFallbackReason !== 'none',
    cityFallbackReason,
    days: clampTripDays(input.days ?? parsed.days ?? DEFAULT_TRIP_DAYS),
    budgetCNY: input.budgetCNY ?? parsed.budgetCNY ?? null,
    limitPerCategory: input.limitPerCategory ?? DEFAULT_LIMIT_PER_CATEGORY,
    daysFromGoal: parsed.days === null ? null : clampTripDays(parsed.days),
  };
}

/* ------------------------------------------------------------------ *
 * 纯函数：候选检索
 * ------------------------------------------------------------------ */

/**
 * 按城市 + 类别 + 条数取候选。**纯函数**（不查进程状态，可单测）。
 *
 * @param fallbackOverride 调用方已判定的回落原因，显式传入。
 *   不传则按 `resolveCityName(city)` 判断，但那只认得"城市名不在 fixture 表里"。
 */
export function listPois(
  city: string,
  category: TripCategory,
  limit: number = DEFAULT_LIMIT_PER_CATEGORY,
  fallbackOverride?: CityFallbackReason,
): { city: string; fallback: boolean; fallbackReason: CityFallbackReason; pois: TripPoi[] } {
  const resolution = resolveCityName(city);
  const pool = POI_FIXTURES[resolution.city]?.[category] ?? [];
  const capped = Math.max(1, Math.min(12, Math.trunc(limit) || DEFAULT_LIMIT_PER_CATEGORY));
  const fallbackReason = fallbackOverride ?? (resolution.fallback ? 'unsupported-city' : 'none');
  return {
    city: resolution.city,
    fallback: fallbackReason !== 'none',
    fallbackReason,
    pois: pool.slice(0, capped).map((poi) => zTripPoi.parse(poi)),
  };
}

/** 三类候选一次取全（编排与预算估算都用它，保证口径一致）。 */
export function listPoisByCategory(
  city: string,
  limit: number = DEFAULT_LIMIT_PER_CATEGORY,
  fallbackOverride?: CityFallbackReason,
): Record<TripCategory, TripPoi[]> {
  return {
    attraction: listPois(city, 'attraction', limit, fallbackOverride).pois,
    restaurant: listPois(city, 'restaurant', limit, fallbackOverride).pois,
    hotel: listPois(city, 'hotel', limit, fallbackOverride).pois,
  };
}

/* ------------------------------------------------------------------ *
 * ProviderAdapter：fixture 数据源
 * ------------------------------------------------------------------ */

function makePoiSourceRef(city: string, category: TripCategory, fallback: CityFallbackReason): {
  providerId: string;
  namespace: string;
  uri: string;
  label: string;
  retrievedAt: string;
  isEstimate: boolean;
} {
  return {
    providerId: POI_PROVIDER_ID,
    namespace: SOURCE_NAMESPACE,
    uri: `fixture://travel/poi/${encodeURIComponent(city)}/${category}`,
    // ★ 回落说明必须出现在 SourceRef 上，而不是只写在日志里：
    // 拿默认城市的样例冒充用户要的城市，若不标注，就是把假数据包装成可溯源的真数据（P1）。
    label: `行程候选 fixture · ${city}${CITY_FALLBACK_NOTE[fallback]} · ${CATEGORY_LABEL[category]}`,
    retrievedAt: new Date().toISOString(),
    isEstimate: true,
  };
}

/** POI fixture Provider（零网络、零密钥，全部数据来自 `POI_FIXTURES`）。 */
export function createPoiProvider(): ProviderAdapter<Record<string, unknown>, TripPoi> {
  return {
    id: POI_PROVIDER_ID,

    async search(query, _ctx: RunContext) {
      const startedAt = Date.now();
      const parsed = zPoiQuery.safeParse(query ?? {});
      const request = parsed.success
        ? parsed.data
        : zPoiQuery.parse({});
      const result = listPois(
        request.city,
        request.category,
        request.limit,
        request.cityFallback,
      );

      return {
        ok: true,
        data: result.pois,
        source: makePoiSourceRef(result.city, request.category, result.fallbackReason),
        isEstimate: true,
        disclaimer: TRIP_DISCLAIMER,
        durationMs: Date.now() - startedAt,
      };
    },

    async detail(id, _ctx: RunContext) {
      const startedAt = Date.now();
      const found =
        Object.values(POI_FIXTURES)
          .flatMap((bucket) => TRIP_CATEGORIES.flatMap((category) => bucket[category]))
          .find((poi) => poi.id === id) ?? null;

      return {
        ok: found !== null,
        data: found === null ? null : zTripPoi.parse(found),
        // 查不到就返回 ok:false + data:null，不编造；此时回落原因无从谈起（'none'）。
        source: makePoiSourceRef(
          found?.city ?? DEFAULT_TRIP_CITY,
          found?.category ?? 'attraction',
          'none',
        ),
        isEstimate: true,
        disclaimer: TRIP_DISCLAIMER,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

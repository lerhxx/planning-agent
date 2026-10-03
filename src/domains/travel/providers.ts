/**
 * 领域段 ③：providers —— **事实数据的唯一来源**（反幻觉强制点）。
 *
 * 全部 fixture 都是本地常量表，**零网络、零密钥**。
 * 每条候选都带 `source` 字段，整批结果带 `SourceRef`，且 `isEstimate: true` + 免责声明。
 *
 * 本文件同时导出一批**纯函数**（口径解析 / 行程编排 / 计划校验），
 * 供 tools、planning、ui 与单测复用 —— 领域内的口径只有一处定义。
 */
import { z } from 'zod';
import type {
  DomainProviders,
  ProviderAdapter,
  ValidatingProvider,
  ValidationResult,
} from '@/shared/domain/types';
import type { Plan } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';

/* ------------------------------------------------------------------ *
 * 常量与基础 schema
 * ------------------------------------------------------------------ */

export const SOURCE_NAMESPACE = 'travel.poi';
export const POI_PROVIDER_ID = 'travel.poi';
export const VALIDATOR_ID = 'travel.validator';

export const DEFAULT_TRIP_CITY = '上海';
export const DEFAULT_TRIP_DAYS = 3;
export const DEFAULT_LIMIT_PER_CATEGORY = 4;
export const MAX_TRIP_DAYS = 14;
/** 单日安排条目超过该数量 → 行程过满（warning，不阻断执行）。 */
export const MAX_ITEMS_PER_DAY = 4;

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

const SLOT_SEQUENCE: readonly string[] = ['上午', '下午', '晚上', '夜间加场', '机动时段'];

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
 * 纯函数：候选检索 / 行程编排
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
 * 计划校验（★ 内核只消费 ok 与 severity）
 * ------------------------------------------------------------------ */

/** 从计划里各步骤的 `intent.input` 还原口径（盘输入来自 Planner，一律 `safeParse`）。 */
export const zLooseStepInput = z.object({
  goalSummary: z.string().optional(),
  city: z.string().optional(),
  category: zTripCategory.optional(),
  days: z.number().optional(),
  budgetCNY: z.number().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  limitPerCategory: z.number().int().positive().optional(),
});

export function readPlanBrief(
  plan: Plan,
): { brief: TripBrief; declaredDays: number | null } {
  let goalSummary = '';
  let city: string | undefined;
  let days: number | undefined;
  let budgetCNY: number | undefined;
  let limitPerCategory: number | undefined;

  for (const step of plan.steps) {
    const parsed = zLooseStepInput.safeParse(step.intent?.input ?? {});
    if (!parsed.success) continue;
    const data = parsed.data;
    if (goalSummary.length === 0 && typeof data.goalSummary === 'string') {
      goalSummary = data.goalSummary;
    }
    city = city ?? data.city;
    days = days ?? data.days;
    budgetCNY = budgetCNY ?? data.budgetCNY;
    limitPerCategory = limitPerCategory ?? data.limitPerCategory ?? data.limit;
  }

  return {
    brief: resolveTripBrief({ goalSummary, city, days, budgetCNY, limitPerCategory }),
    declaredDays: days === undefined ? null : clampTripDays(days),
  };
}

/**
 * 步骤结果里的事实记录用**宽松** schema 解析：缺 source 也要能被识别出来（而不是被丢掉）。
 *
 * `city` / `address` 一并带过来（上游通常有），但不强求 —— 重算成本只需要
 * `category` / `priceCNY`，缺了这两项才影响判定。
 */
const zLoosePoiRecord = z.object({
  name: z.string().optional(),
  category: zTripCategory.optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  priceCNY: z.number().nonnegative().optional(),
  source: z.string().optional(),
});

const zLoosePoiPayload = z.object({
  pois: z.array(zLoosePoiRecord).default([]),
});

export interface CompletedFacts {
  records: z.infer<typeof zLoosePoiRecord>[];
  /** 产出了事实但没有 SourceRef 的步骤 —— 反幻觉硬违规。 */
  missingRefStepIds: string[];
  hasAnyFactStep: boolean;
}

/** 收集计划里**已完成**的事实步骤产出的记录。**纯函数**。 */
export function collectCompletedFacts(plan: Plan): CompletedFacts {
  const records: z.infer<typeof zLoosePoiRecord>[] = [];
  const missingRefStepIds: string[] = [];
  let hasAnyFactStep = false;

  for (const step of plan.steps) {
    if (step.intent?.producesFacts !== true) continue;
    hasAnyFactStep = true;
    const result = step.result;
    if (!result) continue;
    if ((result.sourceRefs ?? []).length === 0) missingRefStepIds.push(step.id);
    const parsed = zLoosePoiPayload.safeParse(result.data ?? {});
    if (parsed.success) records.push(...parsed.data.pois);
  }

  return { records, missingRefStepIds, hasAnyFactStep };
}

/**
 * 按类别归拢后的事实桶。**同时携带 `dropped`（被丢弃的条数）**。
 *
 * ★ `dropped` 是刻意外露的，不是内部细节：
 *
 * 1. **静默丢弃 = 悄悄把成本算低**。被丢掉的条目不进桶，它的 `priceCNY` 就不计入总价，
 *    而总价越低越容易通过预算校验 —— 于是"丢数据"会变成"放行超预算"的暗门。
 * 2. **这与 P1 是同一类失败模式**。P1 的教训是"悄悄换城市不给标注"，把反幻觉防线
 *    变成了造假装置；"悄悄丢掉一部分事实不给任何提示"是同一个错误的另一面。
 *    这个项目的整个反幻觉主张就是**不可静默**，所以丢弃必须可观测。
 */
export type FactBuckets = Record<TripCategory, TripPoi[]> & { dropped: number };

/** 把散落的事实按类别归拢（用于「按真实取回的数据」重算成本）。 */
export function groupFactsByCategory(
  records: readonly z.infer<typeof zLoosePoiRecord>[],
): FactBuckets {
  const buckets: Record<TripCategory, TripPoi[]> = { attraction: [], restaurant: [], hotel: [] };
  let dropped = 0;

  records.forEach((record, index) => {
    if (!record.category || !record.name || !record.source) {
      dropped += 1;
      return;
    }
    // ★ safeParse + 丢弃：用宽松 schema（`zFactDerivedPoi`）。
    // 绝不能抛异常 —— 这个函数跑在 `validateCurrent(candidate)` 里，抛出去就是整条 run 的
    // INTERNAL_ERROR；也绝不能硬填空串去喂严格的 `zTripPoi`（city/address 都是 min(1)）。
    // 但**丢弃必须计数**（`dropped`），由调用方转成一条 warning 说出去 —— 见 `validateTripPlan`。
    const candidate = zFactDerivedPoi.safeParse({
      id: `${record.category}-${index}`,
      name: record.name,
      city: record.city ?? '',
      category: record.category,
      rating: 0,
      priceLevel: 1,
      priceCNY: record.priceCNY ?? 0,
      address: record.address ?? '',
      tags: [],
      source: record.source,
    });
    if (!candidate.success) {
      dropped += 1;
      return;
    }
    buckets[record.category].push(candidate.data);
  });

  // 保持 `Record<TripCategory, TripPoi[]>` 的形状（调用方可以直接当 pois 用），
  // 只是额外挂一个 `dropped` —— 这样既有调用点不用改，丢弃量又不再是不可见的。
  return { ...buckets, dropped };
}

interface TravelViolation {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  suggestion?: string;
}

/**
 * ★ 行程计划校验。**纯函数**，供 `createValidator` 与单测复用。
 *
 * 违规只暴露 `severity`；`code` / `message` / `suggestion` 是给**人与日志**看的，
 * 内核按契约不会去读它们（红线 9/10）。
 */
export function validateTripPlan(plan: Plan): ValidationResult {
  const violations: TravelViolation[] = [];
  const { brief, declaredDays } = readPlanBrief(plan);

  /* ① 反幻觉：事实必须可溯源 */
  const facts = collectCompletedFacts(plan);
  for (const stepId of facts.missingRefStepIds) {
    violations.push({
      severity: 'error',
      code: 'SOURCE_MISSING',
      message: `步骤 ${stepId} 产出了事实但没有带来源引用，结果不可信`,
      suggestion: '重新向 Provider 取数，不得由模型补全',
    });
  }
  const unsourced = facts.records.filter(
    (record) => typeof record.source !== 'string' || record.source.length === 0,
  );
  if (unsourced.length > 0) {
    violations.push({
      severity: 'error',
      code: 'SOURCE_MISSING',
      message: `有 ${unsourced.length} 条候选缺少来源，无法保证不是编造的`,
      suggestion: '丢弃无来源条目后重新编排',
    });
  }

  /* ② 结构：检索步骤必须被编排步骤消费 */
  const searchSteps = plan.steps.filter((step) => step.type === 'poi_search');
  const composeSteps = plan.steps.filter((step) => step.type === 'itinerary_compose');
  if (searchSteps.length > 0 && composeSteps.length === 0) {
    violations.push({
      severity: 'error',
      code: 'COMPOSE_STEP_MISSING',
      message: '计划里有检索步骤却没有编排步骤，检索结果不会被使用',
      suggestion: '补一个由检索步骤推导出来的编排步骤',
    });
  }
  if (composeSteps.length > 1) {
    violations.push({
      severity: 'warning',
      code: 'COMPOSE_STEP_DUPLICATED',
      message: '出现多个编排步骤，可能产生互相冲突的行程',
    });
  }
  for (const compose of composeSteps) {
    const dependsOnSearch = compose.dependsOn.some((id) =>
      searchSteps.some((step) => step.id === id),
    );
    if (!dependsOnSearch) {
      violations.push({
        severity: 'error',
        code: 'COMPOSE_STEP_ORPHAN',
        message: `编排步骤 ${compose.id} 没有依赖任何检索步骤`,
        suggestion: '让编排步骤依赖至少一个检索步骤',
      });
    }
  }

  /* ③ 行程天数与目标不一致 → error */
  if (declaredDays !== null && brief.daysFromGoal !== null && declaredDays !== brief.daysFromGoal) {
    violations.push({
      severity: 'error',
      code: 'DAYS_MISMATCH',
      message: `计划按 ${declaredDays} 天编排，但目标写的是 ${brief.daysFromGoal} 天`,
      suggestion: '把编排天数改成与目标一致，或让用户确认改期',
    });
  }

  /* ④ 过满（warning）与超预算（error）：优先用真实事实，没有事实时用 fixture 估算同一口径 */
  // ★ 把**全部**已产出的事实交给 groupFactsByCategory（不再先按 category/source 预筛一遍）：
  // 预筛会让"缺字段的记录"连被计数的机会都没有，`dropped` 就失去意义了。
  const grouped = groupFactsByCategory(facts.records);
  const usableFacts = TRIP_CATEGORIES.reduce(
    (total, category) => total + grouped[category].length,
    0,
  );
  const itinerary = composeItinerary({
    city: brief.city,
    days: brief.days,
    limitPerCategory: brief.limitPerCategory,
    // 一条可用事实都没有时回落到 fixture 估算 —— 绝不能用"空桶"算出 ¥0 从而放行超预算。
    ...(usableFacts > 0 ? { pois: grouped } : {}),
  });

  const packedDays = itinerary.days.filter((day) => day.items.length > MAX_ITEMS_PER_DAY);
  if (packedDays.length > 0) {
    violations.push({
      severity: 'warning',
      code: 'OVERPACKED_DAY',
      message: `第 ${packedDays.map((day) => day.day).join('、')} 天安排超过 ${MAX_ITEMS_PER_DAY} 项，行程偏满`,
      suggestion: '把部分条目挪到相邻日期，或增加一天',
    });
  }

  if (brief.budgetCNY !== null && itinerary.totalCostCNY > brief.budgetCNY) {
    violations.push({
      severity: 'error',
      code: 'BUDGET_OVERRUN',
      message: `按当前安排，${brief.days} 天预计花费 ¥${itinerary.totalCostCNY}，超过目标里的 ¥${brief.budgetCNY} 预算上限`,
      suggestion: '降低住宿档次、减少付费景点，或让用户上调预算',
    });
  }

  /* ⑤ 事实被丢弃 → warning（不阻断，但必须说出口） */
  // 被丢弃的条目不进成本重算 → 总价偏低 → 校验更容易通过。
  // 这与"悄悄换城市"是同一类失败模式：**静默就是造假**。所以哪怕不阻断也要报出来。
  if (grouped.dropped > 0) {
    violations.push({
      severity: 'warning',
      code: 'FACTS_DROPPED',
      message: `有 ${grouped.dropped} 条已产出的事实因字段缺失（名称 / 类别 / 来源）未计入成本重算，当前总价 ¥${itinerary.totalCostCNY} 可能偏低`,
      suggestion: '检查上游 Provider 的返回完整性；缺来源的条目不得参与编排',
    });
  }

  return {
    ok: !violations.some((violation) => violation.severity === 'error'),
    violations,
  };
}

/* ------------------------------------------------------------------ *
 * DomainProviders
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

export function createTripProviders(): DomainProviders {
  return {
    namespace: SOURCE_NAMESPACE,

    create(_ctx: RunContext): Record<string, ProviderAdapter> {
      const poi: ProviderAdapter<Record<string, unknown>, TripPoi> = {
        id: POI_PROVIDER_ID,

        async search(query, _ctx) {
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

        async detail(id, _ctx) {
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

      return { [POI_PROVIDER_ID]: poi };
    },

    /**
     * 校验型 Provider：只为内核提供 `ok` 与 `violations[].severity` 两个信号。
     * `code` / `message` / `suggestion` 写得再领域化也安全 —— 内核按契约不会去读。
     */
    createValidator(_ctx: RunContext): ValidatingProvider {
      return {
        id: VALIDATOR_ID,
        validate(plan: Plan): ValidationResult {
          return validateTripPlan(plan);
        },
      };
    },
  };
}

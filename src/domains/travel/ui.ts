/**
 * 领域段 ④：ui —— 组件集 + 降级链 + `stepRenderers` 映射。
 *
 * ★ `toProps` 必须是**纯函数**（同样的入参 → 同样的 props），便于单测与重放。
 * 这里只声明元数据与 schema（服务端安全）；`load` 懒加载入口由 `register-ui.ts` 补齐。
 *
 * ★ `degradeChain` 写 `CORE_DEGRADE_CHAIN`：它是服务端概念，前端恒用内核通用链
 * （客户端不注册领域 pack，否则 providers/tools 会被拖进客户端 bundle）。
 */
import { CORE_DEGRADE_CHAIN, type DomainUIContribution } from '@/shared/domain/types';
import type { RunContext } from '@/shared/run/types';
import type { Step } from '@/shared/plan/types';
import { CATEGORY_LABEL, MAX_ITEMS_PER_DAY, type TripCategory } from './providers';
import { zItineraryComposeResult, zPoiSearchResult } from './tools';
import { zPoiCardProps } from './components/PoiCard/schema';
import { zItineraryCardProps } from './components/ItineraryCard/schema';

export const POI_CARD_COMPONENT = 'PoiCard';
export const ITINERARY_CARD_COMPONENT = 'ItineraryCard';

const DEGRADED_DISCLAIMER = '结果格式异常，已降级为原始载荷';

function categoryLabelOf(category: string): string {
  return CATEGORY_LABEL[category as TripCategory] ?? category;
}

export const travelUI: DomainUIContribution = {
  components: [
    {
      name: POI_CARD_COMPONENT,
      description: '候选卡片：展示 Provider 取回的目的地候选（名称 / 类别 / 评分 / 价位 / 地址 / 来源）',
      schema: zPoiCardProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
    },
    {
      name: ITINERARY_CARD_COMPONENT,
      description: '行程卡片：按天展示编排结果、每日花费与总预算对照',
      schema: zItineraryCardProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
    },
  ],

  degradeChain: CORE_DEGRADE_CHAIN,

  stepRenderers: {
    poi_search: {
      component: POI_CARD_COMPONENT,
      toProps(result: unknown, step: Step, _ctx: RunContext): Record<string, unknown> {
        const parsed = zPoiSearchResult.safeParse(result ?? {});
        if (!parsed.success) {
          return {
            title: step.title,
            city: '',
            categoryLabel: '',
            items: [],
            sourceRefs: [],
            disclaimer: DEGRADED_DISCLAIMER,
            isEstimate: true,
          };
        }

        const data = parsed.data;
        return {
          title: step.title,
          city: data.city,
          categoryLabel: data.categoryLabel || categoryLabelOf(data.category),
          items: data.pois.map((poi) => ({
            id: poi.id,
            name: poi.name,
            categoryLabel: categoryLabelOf(poi.category),
            rating: poi.rating,
            priceLevel: poi.priceLevel,
            priceCNY: poi.priceCNY,
            address: poi.address,
            tags: poi.tags,
            source: poi.source,
          })),
          sourceRefs: data.sourceRefs.map((ref) => ({ label: ref.label, uri: ref.uri })),
          disclaimer: data.disclaimer,
          isEstimate: true,
          ...(data.pois.length === 0
            ? { note: '这个类别没有检索到候选，可以换一个城市或类别再试' }
            : {}),
        };
      },
    },

    itinerary_compose: {
      component: ITINERARY_CARD_COMPONENT,
      toProps(result: unknown, step: Step, _ctx: RunContext): Record<string, unknown> {
        const parsed = zItineraryComposeResult.safeParse(result ?? {});
        if (!parsed.success) {
          return {
            title: step.title,
            city: '',
            days: [],
            totalCostCNY: 0,
            budgetCNY: null,
            overBudget: false,
            sourceRefs: [],
            disclaimer: DEGRADED_DISCLAIMER,
            isEstimate: true,
          };
        }

        const data = parsed.data;
        const budgetCNY = data.budgetCNY ?? null;
        const overBudget = budgetCNY !== null && data.totalCostCNY > budgetCNY;
        const busiest = data.days.reduce((max, day) => Math.max(max, day.items.length), 0);

        return {
          title: step.title,
          city: data.city,
          days: data.days.map((day) => ({
            day: day.day,
            theme: day.theme,
            items: day.items.map((item) => ({
              name: item.name,
              categoryLabel: item.categoryLabel || categoryLabelOf(item.category),
              slot: item.slot,
              priceCNY: item.priceCNY,
              source: item.source,
            })),
            stayName: day.stayName,
            stayPriceCNY: day.stayPriceCNY,
            costCNY: day.costCNY,
          })),
          totalCostCNY: data.totalCostCNY,
          budgetCNY,
          overBudget,
          sourceRefs: data.sourceRefs.map((ref) => ({ label: ref.label, uri: ref.uri })),
          disclaimer: data.disclaimer,
          isEstimate: true,
          ...(busiest > MAX_ITEMS_PER_DAY
            ? { note: `有某一天安排超过 ${MAX_ITEMS_PER_DAY} 项，行程偏紧` }
            : {}),
        };
      },
    },
  },
};

'use client';

/**
 * 前端侧补齐 travel 领域组件的**懒加载入口**（`load`）。
 *
 * 为什么要和 `pack.ts` 分开：pack 会被服务端 import，而 `load` 指向 React 组件；
 * 把懒加载入口收在这里，服务端包体不必携带任何组件代码。
 */
import { registerDomainComponents } from '@/src/components/generative-ui/registry';
import { TRAVEL_DOMAIN_ID } from './meta';
import { zPoiCardProps } from './components/PoiCard/schema';
import { zItineraryCardProps } from './components/ItineraryCard/schema';

let registered = false;

export function registerTravelUIComponents(): void {
  if (registered) return;
  registered = true;

  registerDomainComponents(TRAVEL_DOMAIN_ID, [
    {
      name: 'PoiCard',
      description: '候选卡片：展示 Provider 取回的目的地候选（名称 / 类别 / 评分 / 价位 / 地址 / 来源）',
      schema: zPoiCardProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
      load: () => import('./components/PoiCard'),
    },
    {
      name: 'ItineraryCard',
      description: '行程卡片：按天展示编排结果、每日花费与总预算对照',
      schema: zItineraryCardProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
      load: () => import('./components/ItineraryCard'),
    },
  ]);
}

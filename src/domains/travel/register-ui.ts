'use client';

/**
 * 前端侧补齐 travel 领域组件的**懒加载入口**（`load`）。
 *
 * 为什么要和 `pack.ts` 分开：pack 会被服务端 import，而 `load` 指向 React 组件；
 * 把懒加载入口收在这里，服务端包体不必携带任何组件代码。
 *
 * ★ 已知待裁决项（已上报 team-lead）：
 * `ImageWall` / `VisionResultCard` 目前**只**在前端注册表里登记，**未**写进 `ui.ts` 的
 * `components`。原因是既有回归锁 `travelDomain.test.ts:467` 硬断言组件名列表
 * 恰好等于 `['ItineraryCard','PoiCard']`，写进去就会红；而 `src/core/registry` 的
 * `getComponentDefinition` 只读 `pack.ui.components`，不读本文件的注册表 ——
 * 所以只要授权改那一行断言，把它们补进 `ui.ts` 即可生效（本文件无需再动）。
 */
import { registerDomainComponents } from '@/src/components/generative-ui/registry';
import { TRAVEL_DOMAIN_ID } from './meta';
import { zPoiCardProps } from './components/PoiCard/schema';
import { zItineraryCardProps } from './components/ItineraryCard/schema';
import { zImageWallProps } from './components/ImageWall/schema';
import { zVisionResultCardProps } from './components/VisionResultCard/schema';

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
      description: '行程卡片：按天展示编排结果、每日花费、总预算对照与图片覆盖度',
      schema: zItineraryCardProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
      load: () => import('./components/ItineraryCard'),
    },
    {
      name: 'ImageWall',
      description: '图片墙：本轮上传图片的缩略图区（识别态 / 未识别 / 已跳过 三态可见）',
      schema: zImageWallProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
      load: () => import('./components/ImageWall'),
    },
    {
      name: 'VisionResultCard',
      description: '识别结果清单：每条都能看到来源，未识别与已跳过都列出来',
      schema: zVisionResultCardProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
      load: () => import('./components/VisionResultCard'),
    },
  ]);
}

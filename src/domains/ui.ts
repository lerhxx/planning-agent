'use client';

/**
 * 领域包的**客户端唯一入口**（桶文件）。
 *
 * ★ 与 `./index`（服务端桶）成对存在：本文件只被前端页面引用，
 * 服务端永远不 import 它，因此 React 组件代码不会进入服务端包体。
 */
import { registerCoreUIComponents } from '@/src/components/generative-ui/coreComponents';
import { registerDemoUIComponents } from './demo/register-ui';
import { registerTravelUIComponents } from './travel/register-ui';
import { demoDomainId } from './demo/register';
import { travelDomainId } from './travel/register';
import { demoMeta } from './demo/meta';
import { travelMeta } from './travel/meta';

/**
 * 注册全部领域 UI 组件 + 内核通用兜底组件。**幂等**。
 *
 * 顺序：先内核通用兜底组件（`ErrorState` / `RawPayloadCard` / `SkeletonList` / …），
 * 再领域组件 —— 保证任何降级路径都有组件可渲染，**不白屏**。
 */
export function registerAllUI(): void {
  registerCoreUIComponents();
  registerDemoUIComponents();
  registerTravelUIComponents();
}

/** 默认领域 id：页面在未显式指定领域时使用。demo 是回归演示的基线，保持默认。 */
export const defaultDomainId: string = demoDomainId;

/** 页面上的领域下拉框选项。**服务端包体不参与**，只是元数据。 */
export const domainOptions: ReadonlyArray<{ id: string; label: string; sampleGoal: string }> = [
  {
    id: demoDomainId,
    label: `${demoMeta.displayName}（${demoDomainId}）`,
    sampleGoal:
      '帮我把这件事拆成计划并一步步执行：两路采集后汇总成一版结论，预算不超过 500 元，三天内完成',
  },
  {
    id: travelDomainId,
    label: `${travelMeta.displayName}（${travelDomainId}）`,
    sampleGoal: '帮我规划上海三日游，预算 3000 元，想逛景点也吃本地菜',
  },
];

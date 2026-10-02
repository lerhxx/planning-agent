'use client';

/**
 * 前端侧补齐 Demo 领域组件的**懒加载入口**（`load`）。
 *
 * 为什么要和 `pack.ts` 分开：pack 会被服务端 import，而 `load` 指向 React 组件；
 * 把懒加载入口收在这里，服务端包体不必携带任何组件代码。
 */
import { registerDomainComponents } from '@/src/components/generative-ui/registry';
import { zFactListProps } from './components/FactList/schema';
import { zBriefCardProps } from './components/BriefCard/schema';

let registered = false;

export function registerDemoUIComponents(): void {
  if (registered) return;
  registered = true;

  registerDomainComponents('demo', [
    {
      name: 'FactList',
      description: '条目列表：展示 Provider 取回的事实条目与来源',
      schema: zFactListProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
      load: () => import('./components/FactList'),
    },
    {
      name: 'BriefCard',
      description: '结论卡片：展示汇总结论',
      schema: zBriefCardProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
      load: () => import('./components/BriefCard'),
    },
  ]);
}

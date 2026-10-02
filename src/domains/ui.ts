'use client';

/**
 * 领域包的**客户端唯一入口**（桶文件）。
 *
 * ★ 与 `./index`（服务端桶）成对存在：本文件只被前端页面引用，
 * 服务端永远不 import 它，因此 React 组件代码不会进入服务端包体。
 */
import { registerCoreUIComponents } from '@/src/components/generative-ui/coreComponents';
import { registerDemoUIComponents } from './demo/register-ui';
import { demoDomainId } from './demo/register';

/**
 * 注册全部领域 UI 组件 + 内核通用兜底组件。**幂等**。
 *
 * 顺序：先内核通用兜底组件（`ErrorState` / `RawPayloadCard` / `SkeletonList` / …），
 * 再领域组件 —— 保证任何降级路径都有组件可渲染，**不白屏**。
 */
export function registerAllUI(): void {
  registerCoreUIComponents();
  registerDemoUIComponents();
}

/** 默认领域 id：页面在未显式指定领域时使用。 */
export const defaultDomainId = demoDomainId;

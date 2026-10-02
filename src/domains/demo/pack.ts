/**
 * Demo Domain Pack —— 8 段齐全（缺一段则注册失败）。
 *
 * ⚠️ 这是**验证装置**：用来证明内核闭环能跑，不是产品领域。
 */
import type { DomainPack } from '@/shared/domain/types';
import { demoMeta } from './meta';
import { demoTools } from './tools';
import { createDemoProviders } from './providers';
import { demoUI } from './ui';
import { demoPrompts } from './prompts';
import { demoPlanning } from './planning';
import { demoEvaluation } from './evaluation';

export const demoPack: DomainPack = {
  meta: demoMeta,
  tools: demoTools,
  providers: createDemoProviders(),
  ui: demoUI,
  prompts: demoPrompts,
  planning: demoPlanning,
  evaluation: demoEvaluation,

  lifecycle: {
    init() {
      // 演示用：真实领域可以在这里建连接池 / 预热缓存。
    },
    dispose() {
      // 演示用：真实领域可以在这里释放资源。
    },
  },
};

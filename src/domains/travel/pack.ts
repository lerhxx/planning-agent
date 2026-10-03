/**
 * travel Domain Pack —— 8 段齐全（缺一段则注册失败）。
 *
 * 第一个**真实领域**：2 个 stepType、2 个 tool、1 个纯本地 fixture Provider
 * （零网络、零密钥）+ 1 个校验型 Provider（预算 / 天数 / 密度 / 溯源）。
 */
import type { DomainPack } from '@/shared/domain/types';
import { travelMeta } from './meta';
import { travelTools } from './tools';
import { createTripProviders } from './providers';
import { travelUI } from './ui';
import { travelPrompts } from './prompts';
import { travelPlanning } from './planning';
import { travelEvaluation } from './evaluation';

export const travelPack: DomainPack = {
  meta: travelMeta,
  tools: travelTools,
  providers: createTripProviders(),
  ui: travelUI,
  prompts: travelPrompts,
  planning: travelPlanning,
  evaluation: travelEvaluation,

  lifecycle: {
    init() {
      // fixture 领域无需连接池；真实领域可以在这里预热缓存 / 校验密钥是否存在。
    },
    dispose() {
      // fixture 领域无资源可释放（也没有跨 step 的进程状态需要清理）。
    },
  },
};

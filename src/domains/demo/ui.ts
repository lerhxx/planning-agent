/**
 * 领域段 ④：ui —— 组件集 + 降级链 + `stepRenderers` 映射。
 *
 * ★ `toProps` 必须是**纯函数**（同样的入参 → 同样的 props），便于单测与重放。
 * 这里只声明元数据与 schema（服务端安全）；`load` 懒加载入口由 `register-ui.ts` 补齐。
 */
import { z } from 'zod';
import { CORE_DEGRADE_CHAIN, zSourceRef, type DomainUIContribution } from '@/shared/domain/types';
import { zFixtureRecord } from './providers';
import { zFactListProps } from './components/FactList/schema';
import { zBriefCardProps } from './components/BriefCard/schema';

/** 工具返回体的校验 schema（领域侧 safeParse，失败即降级，绝不把脏数据塞进组件）。 */
const zGatherPayload = z.object({
  records: z.array(zFixtureRecord).default([]),
  sourceRefs: z.array(zSourceRef).default([]),
  goalSummary: z.string().default(''),
  disclaimer: z.string().optional(),
});

const zComposePayload = z.object({
  summary: z.string().default(''),
  bullets: z.array(z.string()).default([]),
});

export const demoUI: DomainUIContribution = {
  components: [
    {
      name: 'FactList',
      description: '条目列表：展示 Provider 取回的事实条目与来源',
      schema: zFactListProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
    },
    {
      name: 'BriefCard',
      description: '结论卡片：展示汇总结论',
      schema: zBriefCardProps,
      requiredProps: ['title'],
      modelCallable: false,
      lazy: true,
    },
  ],

  degradeChain: CORE_DEGRADE_CHAIN,

  stepRenderers: {
    gather: {
      component: 'FactList',
      toProps(result: unknown, step) {
        const parsed = zGatherPayload.safeParse(result ?? {});
        if (!parsed.success) {
          return {
            title: step.title,
            items: [],
            sourceRefs: [],
            disclaimer: '结果格式异常，已降级为原始载荷',
          };
        }
        return {
          title: step.title,
          items: parsed.data.records.map((record) => ({
            id: record.id,
            label: record.label,
            value: record.value,
            source: record.source,
          })),
          sourceRefs: parsed.data.sourceRefs.map((ref) => ({
            label: ref.label,
            uri: ref.uri,
          })),
          disclaimer: parsed.data.disclaimer,
          isEstimate: true,
        };
      },
    },

    compose: {
      component: 'BriefCard',
      toProps(result: unknown, step) {
        const parsed = zComposePayload.safeParse(result ?? {});
        return {
          title: step.title,
          summary: parsed.success ? parsed.data.summary : '结果格式异常，已降级',
          bullets: parsed.success ? parsed.data.bullets : [],
        };
      },
    },
  },
};

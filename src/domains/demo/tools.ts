/**
 * 领域段 ②：tools。
 *
 * 铁律：`producesFacts: true` 的工具，其返回**必须带 `SourceRef`**，
 * 且事实数据只能来自 Provider（红线 16：模型不得编造）。
 */
import { z } from 'zod';
import { zSourceRef, type SourceRef } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import type { ProviderAdapter, ToolSet } from '@/shared/domain/types';
import { createDemoProviders, zFixtureRecord, type FixtureRecord } from './providers';

export const zGatherInput = z.object({
  goalSummary: z.string().default(''),
  limit: z.number().int().positive().max(10).default(3),
});
export type GatherInput = z.infer<typeof zGatherInput>;

export const zComposeInput = z.object({
  goalSummary: z.string().default(''),
});
export type ComposeInput = z.infer<typeof zComposeInput>;

/** 工具返回体（领域侧也用 zod 兜底，UI 侧再校验一次）。 */
export const zGatherResult = z.object({
  records: z.array(zFixtureRecord).default([]),
  sourceRefs: z.array(zSourceRef).default([]),
  goalSummary: z.string().default(''),
  disclaimer: z.string().optional(),
});
export type GatherResult = z.infer<typeof zGatherResult>;

export const zComposeResult = z.object({
  summary: z.string().default(''),
  bullets: z.array(z.string()).default([]),
});
export type ComposeResult = z.infer<typeof zComposeResult>;

export const demoTools: ToolSet = {
  'demo.gather': {
    name: 'demo.gather',
    description: '从本地 fixture 数据源取回若干条目（事实数据，必带来源）',
    inputSchema: zGatherInput,
    producesFacts: true,
    idempotent: true,
    timeoutMs: 5_000,
    retryable: true,
    stepType: 'gather',

    async execute(input: unknown, ctx: RunContext) {
      const startedAt = Date.now();
      const parsed = zGatherInput.safeParse(input ?? {});
      const limit = parsed.success ? parsed.data.limit : 3;
      const goalSummary = parsed.success ? parsed.data.goalSummary : '';

      const providers = createDemoProviders().create(ctx);
      const provider = providers['demo.items'] as ProviderAdapter<{ limit: number }, FixtureRecord>;
      const result = await provider.search({ limit }, ctx);

      const sourceRefs: SourceRef[] = [result.source];
      return {
        ok: result.ok,
        data: {
          records: result.data ?? [],
          sourceRefs,
          goalSummary,
          disclaimer: result.disclaimer,
        } satisfies GatherResult,
        sourceRefs,
        isEstimate: true,
        durationMs: Date.now() - startedAt,
        disclaimer: result.disclaimer,
      };
    },
  },

  'demo.compose': {
    name: 'demo.compose',
    description: '把上一步取回的条目整理成一段结论（观点，非事实）',
    inputSchema: zComposeInput,
    producesFacts: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryable: true,
    stepType: 'compose',

    async execute(input: unknown, _ctx: RunContext) {
      const startedAt = Date.now();
      const parsed = zComposeInput.safeParse(input ?? {});
      const goalSummary = parsed.success ? parsed.data.goalSummary : '';

      return {
        ok: true,
        data: {
          summary: goalSummary.length > 0 ? `针对「${goalSummary}」的结论已生成` : '结论已生成',
          bullets: ['已合并两路采集结果', '数值均来自标注来源', '如需更严口径请补充约束'],
        } satisfies ComposeResult,
        sourceRefs: [],
        isEstimate: false,
        durationMs: Date.now() - startedAt,
      };
    },
  },
};

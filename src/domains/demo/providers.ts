/**
 * 领域段 ③：providers —— **事实数据的唯一来源**（反幻觉强制点）。
 *
 * 这里的 fixture 全部来自本地常量表，**不发任何网络请求**。
 * 每条结果都带 `SourceRef`，且 `isEstimate: true` + 免责声明（UI 必须展示）。
 */
import { z } from 'zod';
import type { DomainProviders, ProviderAdapter, ValidatingProvider } from '@/shared/domain/types';
import type { Plan } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';

export const zFixtureRecord = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  source: z.string().min(1),
});
export type FixtureRecord = z.infer<typeof zFixtureRecord>;

export const zFixtureQuery = z.object({
  limit: z.number().int().positive().max(10).default(3),
  topic: z.string().default(''),
});

const FIXTURES: readonly FixtureRecord[] = [
  { id: 'f1', label: '条目一 · 基础口径', value: '42', source: 'fixture://demo/items/1' },
  { id: 'f2', label: '条目二 · 交叉口径', value: '37', source: 'fixture://demo/items/2' },
  { id: 'f3', label: '条目三 · 备选口径', value: '55', source: 'fixture://demo/items/3' },
  { id: 'f4', label: '条目四 · 补充口径', value: '28', source: 'fixture://demo/items/4' },
];

export function createDemoProviders(): DomainProviders {
  return {
    namespace: 'demo.fixture',

    create(_ctx: RunContext): Record<string, ProviderAdapter> {
      const items: ProviderAdapter = {
        id: 'demo.items',

        async search(query, _ctx) {
          const startedAt = Date.now();
          const parsed = zFixtureQuery.safeParse(query ?? {});
          const limit = parsed.success ? parsed.data.limit : 3;

          return {
            ok: true,
            data: FIXTURES.slice(0, limit),
            source: {
              providerId: 'demo.items',
              namespace: 'demo.fixture',
              uri: 'fixture://demo/items',
              label: '本地 fixture（演示数据）',
              retrievedAt: new Date().toISOString(),
              isEstimate: true,
            },
            isEstimate: true,
            disclaimer: '本演示数据来自本地 fixture，不代表真实结果',
            durationMs: Date.now() - startedAt,
          };
        },

        async detail(id, _ctx) {
          const startedAt = Date.now();
          const record = FIXTURES.find((item) => item.id === id) ?? null;
          return {
            ok: record !== null,
            data: record,
            source: {
              providerId: 'demo.items',
              namespace: 'demo.fixture',
              uri: `fixture://demo/items/${id}`,
              label: '本地 fixture（演示数据）',
              retrievedAt: new Date().toISOString(),
              isEstimate: true,
            },
            isEstimate: true,
            durationMs: Date.now() - startedAt,
          };
        },
      };

      return { 'demo.items': items };
    },

    /**
     * 校验型 Provider：内核只会读 `ok` 与 `violations[].severity`，
     * 因此这里可以放心写领域语义，内核看不到也读不懂。
     */
    createValidator(_ctx: RunContext): ValidatingProvider {
      return {
        id: 'demo.validator',
        validate(plan: Plan) {
          const violations: Array<{ severity: 'error' | 'warning'; message: string }> = [];

          for (const step of plan.steps) {
            if (step.type === 'gather' && step.intent === null) {
              violations.push({
                severity: 'error',
                message: '采集步骤必须绑定工具，否则无法保证数据来自 Provider',
              });
            }
          }

          if (plan.steps.length > 12) {
            violations.push({ severity: 'warning', message: '步骤过多，执行时间可能偏长' });
          }

          return { ok: !violations.some((item) => item.severity === 'error'), violations };
        },
      };
    },
  };
}

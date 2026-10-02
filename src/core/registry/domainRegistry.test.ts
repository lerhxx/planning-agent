import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CORE_DEGRADE_CHAIN,
  type DegradeChain,
  type DomainPack,
  type ToolSpec,
} from '@/shared/domain/types';
import {
  clearDomainPacks,
  createProviders,
  createValidator,
  getDegradeChain,
  getStepTypes,
  getTool,
  isAllowedStepType,
  listDomainIds,
  registerDomainPack,
} from './domainRegistry';

const chain: DegradeChain = CORE_DEGRADE_CHAIN;

function makePack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tool: ToolSpec = {
    name: 'unit.tool',
    description: '单元测试工具',
    inputSchema: z.object({ q: z.string().default('') }),
    producesFacts: false,
    idempotent: true,
    timeoutMs: 1_000,
    retryable: true,
    stepType: 'task',
    execute: async () => ({ ok: true, sourceRefs: [], isEstimate: false, durationMs: 0 }),
  };

  const pack = {
    meta: {
      id: 'unit',
      displayName: 'Unit',
      version: '1.0.0',
      schemaVersion: 1,
      description: '单元测试用领域包',
      matcher: { keywords: [], patterns: [], negativeKeywords: [], scoreBySignals: {} },
      requiredSignals: [],
      capabilities: { vision: false, geo: false, providers: true, timeSequence: false },
    },
    tools: { 'unit.tool': tool },
    providers: {
      namespace: 'unit',
      create: () => ({}),
      createValidator: () => ({
        id: 'unit.validator',
        validate: () => ({ ok: true, violations: [] }),
      }),
    },
    ui: { components: [], degradeChain: chain, stepRenderers: {} },
    prompts: { worldview: 'w', constraints: 'c', antiHallucination: '不得编造事实' },
    planning: {
      stepTypes: [{ type: 'task', label: '任务', maxAttempts: 2 }],
      templates: [],
      validateStep: () => ({ ok: true, violations: [] }),
    },
    evaluation: { cases: [], metricIds: [] },
  };

  return { ...pack, ...overrides };
}

describe('registerDomainPack（完整性守卫）', () => {
  beforeEach(() => {
    clearDomainPacks();
  });

  it('8 段齐全 → 注册成功', () => {
    const result = registerDomainPack(makePack());
    expect(result.ok).toBe(true);
    expect(listDomainIds()).toEqual(['unit']);
  });

  it('★ 缺一段 → 注册失败并列出缺失段', () => {
    const pack = makePack();
    delete pack['prompts'];
    const result = registerDomainPack(pack);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['prompts']);
    expect(listDomainIds()).toEqual([]);
  });

  it('★ 段值为 null 也算缺失', () => {
    const result = registerDomainPack(makePack({ tools: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['tools']);
  });

  it('meta 不合法（id 不匹配规范） → 注册失败', () => {
    const pack = makePack();
    const meta = pack['meta'] as Record<string, unknown>;
    const result = registerDomainPack(makePack({ meta: { ...meta, id: 'Bad_Id' } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('meta');
  });

  it('prompts 缺 antiHallucination → 注册失败', () => {
    const result = registerDomainPack(
      makePack({ prompts: { worldview: 'w', constraints: 'c', antiHallucination: '' } }),
    );
    expect(result.ok).toBe(false);
  });

  it('planning 缺 validateStep → 注册失败', () => {
    const planning = (makePack()['planning'] as Record<string, unknown>) ?? {};
    const result = registerDomainPack(makePack({ planning: { ...planning, validateStep: undefined } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('validateStep');
  });

  it('非对象入参 → 全部必填段缺失', () => {
    const result = registerDomainPack(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toHaveLength(7);
  });
});

describe('注册表查询', () => {
  beforeEach(() => {
    clearDomainPacks();
    registerDomainPack(makePack());
  });

  it('stepTypes 白名单', () => {
    expect(getStepTypes('unit').map((t) => t.type)).toEqual(['task']);
    expect(isAllowedStepType('unit', 'task')).toBe(true);
    expect(isAllowedStepType('unit', 'ghost')).toBe(false);
  });

  it('工具查询', () => {
    expect(getTool('unit', 'unit.tool')?.producesFacts).toBe(false);
    expect(getTool('unit', 'ghost')).toBeUndefined();
  });

  it('未注册领域 → 返回空/兜底，不抛错', () => {
    expect(getStepTypes('ghost')).toEqual([]);
    expect(getDegradeChain('ghost')).toEqual(CORE_DEGRADE_CHAIN);
    expect(createProviders('ghost', {
      runId: 'r',
      traceId: 't',
      goalId: 'g',
      domainId: 'ghost',
      revision: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2026-01-01T00:00:25.000Z',
      budgetRemainingCNY: 2,
      signals: [],
      meta: {},
    })).toEqual({});
    expect(
      createValidator(
        'ghost',
        {
          runId: 'r',
          traceId: 't',
          goalId: 'g',
          domainId: 'ghost',
          revision: 1,
          startedAt: '2026-01-01T00:00:00.000Z',
          deadlineAt: '2026-01-01T00:00:25.000Z',
          budgetRemainingCNY: 2,
          signals: [],
          meta: {},
        },
      ),
    ).toBeUndefined();
  });
});

/** 保持对 DomainPack 类型的引用，防止契约漂移后测试静默失效。 */
export type _AssertPack = DomainPack;

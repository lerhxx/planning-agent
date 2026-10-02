/**
 * 校验链路单测（PRD §7.1 / C0-06）。
 *
 * 证明三件事：
 * 1. `validatePlan` 会把「逐步骤校验」与「校验型 Provider」的结果**聚合**成一个结论；
 * 2. `highestSeverity` 是内核唯一的消费方式（error > warning > null）；
 * 3. `decideValidationAction` 只吃 `ok` / `severity`，不吃 `.code` / `.message`。
 *
 * 需要领域包注册，故放在 `src/test/`（内核目录保持零领域词）。
 */
import { describe, expect, it } from 'vitest';
import { zRunContext, type RunContext } from '@/shared/run/types';
import type { Step } from '@/shared/plan/types';
import { highestSeverity, validatePlan, validateStep } from '@/src/core/planning/validate';
import { decideValidationAction } from '@/src/core/replan/policy';
import { makePlan, makeStep } from '@/src/test/fixtures';
import { registerAllDomains } from '@/src/domains';

const [DOMAIN_ID] = registerAllDomains();

function ctx(): RunContext {
  return zRunContext.parse({
    runId: 'run-1',
    traceId: 'trace-1',
    goalId: 'goal-1',
    domainId: DOMAIN_ID,
    startedAt: '2026-01-01T00:00:00.000Z',
    deadlineAt: '2026-01-01T00:00:25.000Z',
  });
}

function demoStep(partial: Partial<Step> & { id: string }): Step {
  return makeStep({ domainId: DOMAIN_ID, type: 'compose', ...partial });
}

/** 带工具的采集步骤（合法）。 */
function gatherStep(id: string): Step {
  return demoStep({
    id,
    type: 'gather',
    intent: { toolName: 'demo.gather', input: { limit: 1 }, producesFacts: true },
  });
}

describe('validateStep', () => {
  it('合法步骤 → ok，无 violation', async () => {
    const result = await validateStep(gatherStep('s-1'), ctx());
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(highestSeverity(result)).toBeNull();
  });

  it('采集步骤没绑工具 → error（事实必须来自 Provider）', async () => {
    const result = await validateStep(demoStep({ id: 's-1', type: 'gather', intent: null }), ctx());
    expect(result.ok).toBe(false);
    expect(highestSeverity(result)).toBe('error');
  });

  it('未知领域 → ok=false（领域包未注册即不可用）', async () => {
    const result = await validateStep(
      makeStep({ id: 's-1', domainId: 'ghost', type: 'compose' }),
      ctx(),
    );
    expect(result.ok).toBe(false);
  });
});

describe('validatePlan（聚合：逐步骤 + 校验型 Provider）', () => {
  it('全部合法 → ok=true，severity=null', async () => {
    const plan = makePlan([gatherStep('s-1'), gatherStep('s-2'), demoStep({ id: 's-3' })], {
      domainId: DOMAIN_ID,
    });
    const result = await validatePlan(plan, ctx());
    expect(result.ok).toBe(true);
    expect(highestSeverity(result)).toBeNull();
  });

  it('有一步不合法 → 整份计划 ok=false（局部错误即阻断）', async () => {
    const plan = makePlan(
      [
        gatherStep('s-1'),
        demoStep({ id: 's-2', type: 'gather', intent: null }),
        demoStep({ id: 's-3' }),
      ],
      { domainId: DOMAIN_ID },
    );
    const result = await validatePlan(plan, ctx());
    expect(result.ok).toBe(false);
    expect(highestSeverity(result)).toBe('error');
  });

  it('★ 逐步骤都合法、但校验型 Provider 报 warning → ok=true 且 severity=warning', async () => {
    // 13 步：超过 demo Provider 的 "步骤过多" 阈值（>12），而 validateStep 全过。
    const steps = Array.from({ length: 13 }, (_, index) =>
      index === 0 ? gatherStep(`s-${index + 1}`) : demoStep({ id: `s-${index + 1}` }),
    );
    const plan = makePlan(steps, { domainId: DOMAIN_ID });

    const result = await validatePlan(plan, ctx());
    expect(result.ok).toBe(true);
    expect(highestSeverity(result)).toBe('warning');
    // warning 来自 Provider，而不是步骤校验：逐步骤校验全部通过。
    for (const step of plan.steps) {
      expect((await validateStep(step, ctx())).ok).toBe(true);
    }
  });

  it('★ error 与 warning 同时存在 → 取 error（severity 取最高）', async () => {
    const steps = Array.from({ length: 13 }, (_, index) =>
      index === 0
        ? demoStep({ id: 's-1', type: 'gather', intent: null })
        : demoStep({ id: `s-${index + 1}` }),
    );
    const result = await validatePlan(makePlan(steps, { domainId: DOMAIN_ID }), ctx());
    expect(result.ok).toBe(false);
    expect(highestSeverity(result)).toBe('error');
  });
});

describe('highestSeverity（内核唯一的消费方式）', () => {
  it('空 violations → null', () => {
    expect(highestSeverity({ ok: true, violations: [] })).toBeNull();
  });

  it('只有 warning → warning', () => {
    expect(highestSeverity({ ok: true, violations: [{ severity: 'warning' }] })).toBe('warning');
  });

  it('有 error → error（与顺序无关）', () => {
    expect(
      highestSeverity({
        ok: false,
        violations: [{ severity: 'warning' }, { severity: 'error' }, { severity: 'warning' }],
      }),
    ).toBe('error');
  });
});

describe('decideValidationAction（策略集中在 policy，不散落在 engine）', () => {
  it('ok → continue', () => {
    expect(
      decideValidationAction({ ok: true, severity: null, attempt: 0, maxAttempts: 2 }),
    ).toBe('continue');
  });

  it('warning 不阻断 → continue', () => {
    expect(
      decideValidationAction({ ok: true, severity: 'warning', attempt: 0, maxAttempts: 2 }),
    ).toBe('continue');
  });

  it('error 且未用尽尝试 → local-subtree', () => {
    expect(
      decideValidationAction({ ok: false, severity: 'error', attempt: 0, maxAttempts: 2 }),
    ).toBe('local-subtree');
  });

  it('error 且尝试已用尽 → ask-user（转人工，不无限重排）', () => {
    expect(
      decideValidationAction({ ok: false, severity: 'error', attempt: 2, maxAttempts: 2 }),
    ).toBe('ask-user');
  });

  it('★ 入参只有 ok/severity/attempt/maxAttempts：不接收任何领域字段', () => {
    // 编译期保证：多传字段会报错；这里只验证函数签名在运行时不依赖其它字段。
    const action = decideValidationAction({
      ok: false,
      severity: 'error',
      attempt: 0,
      maxAttempts: 2,
    });
    expect(['retry-step', 'local-subtree', 'full-replan', 'ask-user', 'cancel-subtree']).toContain(
      action,
    );
  });
});

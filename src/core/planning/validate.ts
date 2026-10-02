/**
 * 计划/步骤校验 —— 委托给领域的 `validateStep` 与校验型 Provider。
 *
 * ★ 红线 9：**内核只消费 `ok` 与 `violations[].severity`**，
 * 绝不读 `.code` / `.message` / `.suggestion` / `.evidence`，也不对它们做分支。
 */
import type { Plan, Step } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import type { ValidationResult } from '@/shared/domain/types';
import { createValidator, getDomainPack, isAllowedStepType } from '@/src/core/registry/domainRegistry';

/** 校验单个步骤：先过内核通用检查（类型白名单），再交给领域。 */
export async function validateStep(step: Step, ctx: RunContext): Promise<ValidationResult> {
  const violations: ValidationResult['violations'] = [];

  const pack = getDomainPack(step.domainId);
  if (!pack) {
    return { ok: false, violations: [{ severity: 'error' }] };
  }

  if (!isAllowedStepType(step.domainId, step.type)) {
    violations.push({ severity: 'error' });
  }

  const domainResult = await pack.planning.validateStep(step, ctx);
  return {
    ok: violations.length === 0 && domainResult.ok,
    violations: [...violations, ...domainResult.violations],
  };
}

/** 校验整个计划：逐步骤 + 校验型 Provider。 */
export async function validatePlan(plan: Plan, ctx: RunContext): Promise<ValidationResult> {
  const violations: ValidationResult['violations'] = [];

  for (const step of plan.steps) {
    const result = await validateStep(step, ctx);
    violations.push(...result.violations);
  }

  const validator = createValidator(plan.domainId, ctx);
  if (validator) {
    const result = await validator.validate(plan, ctx);
    violations.push(...result.violations);
  }

  // 内核只认 severity：有任一 error 即不通过。warning 不影响执行。
  return {
    ok: !violations.some((violation) => violation.severity === 'error'),
    violations,
  };
}

/** 内核唯一的消费方式：取最高 severity。 */
export function highestSeverity(result: ValidationResult): 'error' | 'warning' | null {
  if (result.violations.some((violation) => violation.severity === 'error')) return 'error';
  if (result.violations.length > 0) return 'warning';
  return null;
}

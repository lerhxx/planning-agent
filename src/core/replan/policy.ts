/**
 * 重规划策略表（PRD §9.1）—— 纯函数，领域无关。
 *
 * 输入只认**内核通用触发码**与 `severity`；不读任何领域语义。
 */
import { z } from 'zod';
import { zViolation } from '@/shared/domain/types';

/** 内核通用触发原因。禁止引入领域专有码（红线 10）。 */
export const zReplanTrigger = z.enum([
  'STEP_TIMEOUT',
  'RETRYABLE_ERROR',
  'FATAL_ERROR',
  'NEW_INFO',
  'LOW_CONFIDENCE',
  'USER_EDIT',
  'GOAL_CONSTRAINT_CHANGED',
  'ENV_ERROR',
  'PROVIDER_VALIDATION_FAILED',
]);
export type ReplanTrigger = z.infer<typeof zReplanTrigger>;

export const zReplanStrategy = z.enum([
  'retry-step',
  'local-subtree',
  'full-replan',
  'ask-user',
  'cancel-subtree',
]);
export type ReplanStrategy = z.infer<typeof zReplanStrategy>;

export const zStrategyInput = z.object({
  trigger: zReplanTrigger,
  /** 来自 validator 的 violation severity；非校验触发时给 'error'。 */
  severity: zViolation.shape.severity.default('error'),
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(2),
});
export type StrategyInput = z.infer<typeof zStrategyInput>;

/**
 * 触发原因 → 策略。
 *
 * | 触发                              | 策略                        |
 * |-----------------------------------|-----------------------------|
 * | 单步超时 / 可重试错误（未用尽）    | `retry-step`                |
 * | 环境问题                          | `retry-step`（不重排）      |
 * | 可重试错误（已用尽）/ 不可重试     | `local-subtree`             |
 * | 新信息推翻前提                    | `local-subtree`             |
 * | 校验型 Provider 返回 error         | `local-subtree`             |
 * | 置信度不足 / 多候选                | `ask-user`                  |
 * | 用户改了目标级约束                 | `full-replan`               |
 */
export function decideStrategy(input: StrategyInput): ReplanStrategy {
  const retryableTrigger =
    input.trigger === 'RETRYABLE_ERROR' ||
    input.trigger === 'STEP_TIMEOUT' ||
    input.trigger === 'ENV_ERROR';

  if (retryableTrigger && input.attempt < input.maxAttempts) {
    return 'retry-step';
  }

  switch (input.trigger) {
    case 'RETRYABLE_ERROR':
    case 'STEP_TIMEOUT':
    case 'ENV_ERROR':
      // 重试次数已用尽：不再重试，重排下游子树。
      return 'local-subtree';
    case 'FATAL_ERROR':
    case 'NEW_INFO':
    case 'USER_EDIT':
      return 'local-subtree';
    case 'PROVIDER_VALIDATION_FAILED':
      return input.severity === 'warning' ? 'ask-user' : 'local-subtree';
    case 'LOW_CONFIDENCE':
      return 'ask-user';
    case 'GOAL_CONSTRAINT_CHANGED':
      return 'full-replan';
    default:
      return 'local-subtree';
  }
}

/**
 * ★ 校验结果的处置策略（PRD §7.1 / C0-06）。
 *
 * 内核**只**拿到 `ok` 与 `violations[].severity` 两个信号（红线 8）：
 * 不读 `.code` / `.message` / `.suggestion` / `.evidence`，也不对它们做分支。
 * 所有"校验不通过该怎么办"的判断都集中在这里，不散落在 engine 里。
 */
export function decideValidationAction(input: {
  ok: boolean;
  /** 来自 `highestSeverity()`；null = 没有任何 violation。 */
  severity: 'error' | 'warning' | null;
  attempt: number;
  maxAttempts: number;
}): 'continue' | ReplanStrategy {
  if (input.ok) return 'continue';
  // warning 不阻断执行：只记录，不重排、不打断。
  if (input.severity !== 'error') return 'continue';
  // error：先让 Agent 重排；尝试次数用尽 → 转人工，绝不无限重排。
  if (input.attempt >= input.maxAttempts) return 'ask-user';
  return decideStrategy({
    trigger: 'PROVIDER_VALIDATION_FAILED',
    severity: input.severity ?? 'error',
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
  });
}

/** 触发原因 → 写入 Step.origin 的人类可读原因（内核通用表述）。 */
export function describeTrigger(trigger: ReplanTrigger): string {
  switch (trigger) {
    case 'STEP_TIMEOUT':
      return '步骤超时';
    case 'RETRYABLE_ERROR':
      return '可重试错误且重试次数已用尽';
    case 'FATAL_ERROR':
      return '不可重试失败';
    case 'NEW_INFO':
      return '新信息推翻前提';
    case 'LOW_CONFIDENCE':
      return '置信度不足';
    case 'USER_EDIT':
      return '用户编辑了计划';
    case 'GOAL_CONSTRAINT_CHANGED':
      return '目标级约束变更';
    case 'ENV_ERROR':
      return '环境问题';
    case 'PROVIDER_VALIDATION_FAILED':
      return '校验未通过';
    default:
      return '未知触发';
  }
}

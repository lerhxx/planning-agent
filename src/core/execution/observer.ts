/**
 * Observer —— 纯函数：判定一次工具调用的结果属于哪一类（C0-05）。
 *
 * ★ 反幻觉硬检查（红线 16）：`intent.producesFacts === true` 的步骤，
 * 结果必须带 `SourceRef`，否则一律判定为失败，触发码用**内核通用码** `SOURCE_MISSING`。
 */
import { z } from 'zod';
import { zAgentError, zClarifyQuestion, type Step, type StepResult } from '@/shared/plan/types';
import type { ToolOutcome } from '@/src/core/runtime/adapter';

export const zObservationKind = z.enum(['success', 'retry', 'clarify', 'fail']);
export type ObservationKind = z.infer<typeof zObservationKind>;

export const zObservation = z.object({
  kind: zObservationKind,
  stepId: z.string().min(1),
  /** 失败/重试时的内核通用触发码。 */
  trigger: z
    .enum([
      'PROVIDER_VALIDATION_FAILED',
      'SOURCE_MISSING',
      'TOOL_FAILED',
      'TOOL_TIMEOUT',
      'ENV_ERROR',
      'RETRYABLE_ERROR',
      'FATAL_ERROR',
    ])
    .optional(),
  error: zAgentError.optional(),
  needsClarification: z.boolean().optional(),
  questionId: z.string().optional(),
  question: zClarifyQuestion.optional(),
});
export type Observation = z.infer<typeof zObservation>;

/** 把一次工具调用结果判定为 Observation。**不读任何领域语义。 */
export function observe(step: Step, outcome: ToolOutcome): Observation {
  const base = { stepId: step.id };

  // 1) 事实缺来源 → 直接判失败（反幻觉硬闸门）
  if (outcome.ok && step.intent?.producesFacts === true && outcome.sourceRefs.length === 0) {
    return {
      ...base,
      kind: 'fail',
      trigger: 'SOURCE_MISSING',
      error: {
        code: 'SOURCE_MISSING',
        message: '产出事实的步骤未返回来源引用，结果不可信',
        retryable: true,
      },
    };
  }

  // 2) 需要用户决策
  if (outcome.needsClarification) {
    return {
      ...base,
      kind: 'clarify',
      needsClarification: true,
      questionId: outcome.question?.id,
      question: outcome.question,
    };
  }

  // 3) 成功
  if (outcome.ok) {
    return { ...base, kind: 'success' };
  }

  // 4) 失败：可重试且次数未用尽 → retry，否则 → fail
  const retryable = outcome.error?.retryable === true;
  const attemptsLeft = step.attempt < step.maxAttempts;
  if (retryable && attemptsLeft) {
    return {
      ...base,
      kind: 'retry',
      trigger: 'RETRYABLE_ERROR',
      error: outcome.error,
    };
  }
  return {
    ...base,
    kind: 'fail',
    trigger: retryable ? 'RETRYABLE_ERROR' : 'TOOL_FAILED',
    error: outcome.error ?? {
      code: 'TOOL_FAILED',
      message: '工具调用失败',
      retryable: false,
    },
  };
}

/** Observation → 写回 Step 的 StepResult。 */
export function toStepResult(outcome: ToolOutcome, durationMs: number): StepResult {
  return {
    ok: outcome.ok,
    data: outcome.data,
    sourceRefs: outcome.sourceRefs,
    isEstimate: outcome.isEstimate,
    durationMs,
  };
}

/** Observation → 内核通用触发原因（供 replan/policy 使用）。 */
export function toReplanTrigger(observation: Observation): 'RETRYABLE_ERROR' | 'FATAL_ERROR' | 'LOW_CONFIDENCE' | 'ENV_ERROR' | 'PROVIDER_VALIDATION_FAILED' {
  if (observation.kind === 'clarify') return 'LOW_CONFIDENCE';
  if (observation.trigger === 'SOURCE_MISSING') return 'PROVIDER_VALIDATION_FAILED';
  if (observation.trigger === 'ENV_ERROR') return 'ENV_ERROR';
  if (observation.trigger === 'RETRYABLE_ERROR') return 'RETRYABLE_ERROR';
  return 'FATAL_ERROR';
}

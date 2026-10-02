/**
 * 三级降级策略（PRD §5 / C0-12）—— 纯函数，领域无关。
 *
 * 链：`RawPayloadCard → ClarifyOptions → ErrorState`，外加等待期的 `SkeletonList`。
 * **任何情况下都不白屏**：每个失败分支都必须落到这四个兜底组件之一。
 */
import { z } from 'zod';
import { CORE_DEGRADE_CHAIN, zDegradeChain, type DegradeChain } from '@/shared/domain/types';

export const zDegradeLevel = z.enum(['none', 'skeleton', 'raw', 'clarify', 'error']);
export type DegradeLevel = z.infer<typeof zDegradeLevel>;

export const zDegradeInput = z.object({
  /** 组件是否在注册表中（未知组件直接降级为原始载荷）。 */
  componentKnown: z.boolean().default(true),
  /** props 是否通过 zod 校验。 */
  parseOk: z.boolean().default(true),
  /** 必填 props 是否补齐。 */
  propsComplete: z.boolean().default(true),
  hasError: z.boolean().default(false),
  needsClarify: z.boolean().default(false),
  chain: zDegradeChain.default(CORE_DEGRADE_CHAIN),
});
/**
 * ★ 用 `z.input` 而不是 `z.infer`：本 schema 的字段都带 `.default()`，
 * 入参类型（input）允许省略这些字段，而输出类型（output）是必填的。
 * 若用 `z.infer`，调用方会被强制要求补齐所有默认值字段（红线：默认值形同虚设）。
 */
export type DegradeInput = z.input<typeof zDegradeInput>;

export const zDegradeDecision = z.object({
  level: zDegradeLevel,
  /** 实际要渲染的组件名。 */
  component: z.string().min(1),
  reason: z.string().min(1),
});
export type DegradeDecision = z.infer<typeof zDegradeDecision>;

/**
 * 决定渲染哪个兜底组件。**顺序即优先级**，失败路径优先：
 *
 * 1. 组件未注册 → `raw`（原始载荷，至少让用户看到数据）
 * 2. 显式错误 → `error`（错误态 + traceId）
 * 3. 需要用户决策 → `clarify`（置信度不足）
 * 4. props 校验失败 → `raw`
 * 5. props 未补齐（还在流式）→ `skeleton`
 * 6. 否则正常渲染
 */
export function decideDegrade(input: DegradeInput): DegradeDecision {
  const chain: DegradeChain = input.chain ?? CORE_DEGRADE_CHAIN;

  if (!input.componentKnown) {
    return { level: 'raw', component: chain.rawPayload, reason: '组件未注册' };
  }
  if (input.hasError) {
    return { level: 'error', component: chain.error, reason: '组件进入错误态' };
  }
  if (input.needsClarify) {
    return { level: 'clarify', component: chain.clarify, reason: '置信度不足，需要用户确认' };
  }
  if (!input.parseOk) {
    return { level: 'raw', component: chain.rawPayload, reason: 'props 未通过 schema 校验' };
  }
  if (!input.propsComplete) {
    return { level: 'skeleton', component: chain.skeleton, reason: 'props 尚未补齐' };
  }
  return { level: 'none', component: '', reason: '正常渲染' };
}

/** 必填 props 是否全部到齐（未到齐只渲染骨架，不报错）。 */
export function isPropsComplete(
  props: Record<string, unknown>,
  requiredProps: readonly string[],
): boolean {
  return requiredProps.every((key) => props[key] !== undefined);
}

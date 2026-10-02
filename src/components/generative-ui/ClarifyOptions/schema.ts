import { z } from 'zod';
import { zClarifyOption } from '@/shared/plan/types';

/** 二级降级：置信度不足 / 多候选 → 让用户点选。 */
export const zClarifyOptionsProps = z.object({
  questionId: z.string().optional(),
  prompt: z.string().optional(),
  options: z.array(zClarifyOption).default([]),
  traceId: z.string().optional(),
});

export type ClarifyOptionsProps = z.infer<typeof zClarifyOptionsProps>;

/** 组件 → 对话的回灌动作（组件内不得发请求）。 */
export const zComponentAction = z.object({
  type: z.enum(['select_option', 'retry', 'cancel']),
  questionId: z.string().optional(),
  optionId: z.string().optional(),
});
export type ComponentAction = z.infer<typeof zComponentAction>;

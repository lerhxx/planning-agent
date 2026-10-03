import { z } from 'zod';
import { zClarifyField, zClarifyOption } from '@/shared/plan/types';

/**
 * 二级降级：置信度不足 / 多候选 → 让用户点选或填表。
 *
 * 两种模式互斥且都靠 `prompt` 启动：
 * - 选项模式：`options` 非空、`fields` 为空 → 扁平按钮；
 * - 表单模式：`fields` 非空 → 按 `kind` 渲染控件，**一次提交**。
 *
 * ★ `fields` 必须与 `shared/plan/types` 的 `zClarifyField` **同源**（不重复定义）：
 * `ComponentRenderer` 每次 render 都会 `safeParse`，zod 默认 strip 未知键 ——
 * 这里漏一个键就等于"传了但被静默丢弃"。
 */
export const zClarifyOptionsProps = z.object({
  questionId: z.string().optional(),
  prompt: z.string().optional(),
  options: z.array(zClarifyOption).default([]),
  fields: z.array(zClarifyField).default([]),
  traceId: z.string().optional(),
});

export type ClarifyOptionsProps = z.infer<typeof zClarifyOptionsProps>;

/**
 * 组件 → 对话的回灌动作（组件内不得发请求）。
 *
 * - `select_option`：选项模式，回灌 `{ [questionId]: optionId }`；
 * - `submit_form`：表单模式，回灌 `makeFormKey(questionId, fieldId) -> value`（多选用 JSON 数组编码）。
 */
export const zComponentAction = z.object({
  type: z.enum(['select_option', 'submit_form', 'retry', 'cancel']),
  questionId: z.string().optional(),
  optionId: z.string().optional(),
  values: z.record(z.string(), z.string()).optional(),
});
export type ComponentAction = z.infer<typeof zComponentAction>;

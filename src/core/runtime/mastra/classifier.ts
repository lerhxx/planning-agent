/**
 * 通用文本二分类器（模型兜底的基础设施）—— 供离题拦截等场景在"灰区"调用。
 *
 * ★ 这是 `src/core/runtime/mastra/**` 内部模块：唯一允许 import `@mastra/*` 的地方之一
 *   （红线 5）。本文件**不含任何领域词**（红线 8）—— 具体的判定标准由调用方以参数传入，
 *   因此内核 / shared 的"无领域词"守卫不会被破坏。
 *
 * ★ 缺模型配置（缺 `MASTRA_TEXT_*` 环境变量）时返回 `null`，调用方据此走默认分支。
 */
import { Agent } from '@mastra/core/agent';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import { textModel, MissingModelConfigError } from './models';

/**
 * 构造一个文本二分类器。
 *
 * @param instruction 分类指令（含"属于/不属于"的判定标准与输出格式要求）。
 *   调用方负责写入领域语义——本函数不认识任何业务领域。
 * @param affirmative 命中"属于"的正则；其余一律视为"不属于"。
 * @returns `(text) => Promise<boolean>`；返回 `null` 表示没配真模型（调用方走默认分支）。
 */
export function createTextClassifier(
  instruction: string,
  affirmative: RegExp,
): ((text: string) => Promise<boolean>) | null {
  let model: OpenAICompatibleConfig;
  try {
    model = textModel();
  } catch (error) {
    // 没配真模型：不抛错，返回 null，让调用方走默认分支（与 mock 模式一致）。
    if (error instanceof MissingModelConfigError) return null;
    throw error;
  }

  const agent = new Agent({
    id: 'text-classifier',
    name: 'text-classifier',
    instructions: instruction,
    model,
  });

  return async (text: string): Promise<boolean> => {
    const result = await agent.generate([{ role: 'user', content: text }], { model });
    const output =
      typeof (result as { text?: unknown }).text === 'string'
        ? (result as { text: string }).text
        : '';
    return affirmative.test(output.trim());
  };
}

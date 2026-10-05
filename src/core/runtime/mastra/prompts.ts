/**
 * 规划 / 重规划的 system prompt —— **纯字符串，无领域词**（红线 8）。
 *
 * ★ 设计原则：prompt 只描述"**如何**规划"，不描述"规划什么"。
 *   可用的步骤类型、工具、模板全部由调用方从领域包取出后**注入**，
 *   所以同一份 prompt 对任何领域都成立 —— 内核不认识任何领域语义。
 *
 * ★ 反幻觉（红线 16）：prompt 明确告诉模型"事实只能来自工具返回"，
 *   但**真正的闸门不在这里** —— `src/core/execution/observer.ts:41-52` 的
 *   `SOURCE_MISSING` 硬检查才是强制点。prompt 只是让模型少犯错，
 *   闸门负责"模型仍然编了"的情况。两者不可互相替代。
 */
import type { PlanRequest, ReplanRequest } from '@/src/core/runtime/adapter';

/** 通用约束段：两个 prompt 共用。 */
function commonRules(): string {
  return [
    '## 硬性约束',
    '1. 只能使用下方"可用步骤类型"里列出的 type，不得自造。',
    '2. 只能使用下方"可用工具"里列出的 toolName。',
    '3. dependsOn 只能引用同一个方案中出现过的步骤 id；不得引用不存在的 id。',
    '4. 不得输出任何未在上文出现的具体事实数值（价格、评分、耗时、距离等）。',
    '   事实只能由工具在执行阶段返回；你只负责编排顺序与依赖。',
    '5. 除非确有把握，纯推理步骤（intent 为 null）优于编造工具调用。',
    '6. 输出必须严格符合给定的 JSON 结构，不要包裹在解释性文字或代码块里。',
  ].join('\n');
}

/** 把领域声明的步骤类型渲染成 prompt 片段。 */
function renderStepTypes(request: PlanRequest | ReplanRequest): string {
  const lines = request.stepTypes.map(
    (descriptor) =>
      `- type="${descriptor.type}" | 含义="${descriptor.label}" | 说明="${descriptor.description}" | 最多尝试 ${descriptor.maxAttempts} 次`,
  );
  return ['## 可用步骤类型', ...(lines.length > 0 ? lines : ['- （无）'])].join('\n');
}

/** 规划 prompt。 */
export function planSystemPrompt(request: PlanRequest): string {
  const templates = request.templates.map(
    (template) =>
      `- 模板 id="${template.id}"：${template.description}（含 ${template.steps.length} 个步骤）`,
  );

  return [
    '你是一个规划器。用户给出一个目标，你把它拆解成有序、可执行的步骤。',
    '',
    `## 目标\n${request.goal.summary || '(用户未提供文字描述)'}`,
    '',
    `## 输入信号\n${request.signals.length > 0 ? request.signals.join('、') : '(无)'}`,
    '',
    renderStepTypes(request),
    '',
    ['## 可用模板', ...(templates.length > 0 ? templates : ['- （无）'])].join('\n'),
    '',
    commonRules(),
    '',
    '## 输出结构',
    '{ "summary": string, "steps": StepDraft[] }',
    'StepDraft = { type: string, title: string, description?: string, dependsOn: string[],',
    '              parallelGroup?: string, intent: { toolName, input, producesFacts } | null,',
    '              estimate?: { durationMs, costCNY, confidence } }',
    '',
    '注意：`dependsOn` 引用的是步骤的**数组下标顺序**无关的**类型+标题**无法被引用，',
    '所以请给每个步骤安排一个稳定顺序，并让 dependsOn 指向**同方案内已存在的步骤**。',
  ].join('\n');
}

/** 重规划 prompt。 */
export function replanSystemPrompt(request: ReplanRequest): string {
  const impacted = request.impactedSteps.map(
    (step) => `- id="${step.id}" type="${step.type}" title="${step.title}"`,
  );
  const retained = request.retainedSteps.map((step) => `- id="${step.id}" title="${step.title}"`);

  return [
    '你是一个重规划器。已有方案的一部分步骤失败或需要替换，你要为**受影响的那部分**产出新步骤。',
    '',
    `## 目标\n${request.goal.summary || '(用户未提供文字描述)'}`,
    `## 触发原因\n${request.trigger}`,
    '',
    ['## 需要被替换的步骤', ...(impacted.length > 0 ? impacted : ['- （无）'])].join('\n'),
    '',
    ['## 必须保留的步骤（不得删除、不得改 id）', ...(retained.length > 0 ? retained : ['- （无）'])].join('\n'),
    '',
    renderStepTypes(request),
    '',
    commonRules(),
    '',
    '## 本次特有的硬性约束',
    '1. **只输出需要替换的新步骤**，不要重复输出"必须保留的步骤"。',
    '2. 新步骤不得复用"必须保留的步骤"的 id。',
    '3. 不得引用"必须保留的步骤"以外的、已不存在的旧步骤 id。',
    '4. 新方案必须与原方案**实质不同**：仅改标题、仅调顺序都算原地打转，',
    '   会被内核的收敛判定拦下并转人工。这里请真正改变步骤的类型或意图。',
    '',
    '## 输出结构',
    '{ "summary": string, "steps": StepDraft[] }',
  ].join('\n');
}

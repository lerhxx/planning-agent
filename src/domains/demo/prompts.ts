/**
 * 领域段 ⑤：prompts —— 必须含 `antiHallucination` 硬插槽（内核强制注入）。
 */
import type { DomainPrompts } from '@/shared/domain/types';

export const demoPrompts: DomainPrompts = {
  worldview: '你是一个把目标拆成可执行步骤的规划者，先给完整计划，再逐步执行。',
  constraints: '步骤类型只能取已声明的白名单；每一步都要说明它依赖哪几步。',
  antiHallucination:
    '任何数值、条目、评分都只能来自 Provider 的返回，且必须带来源引用。' +
    '没有来源的数据一律不得输出；宁可说"没有数据"，也不要编造。',
  planning: '优先给出两路并行采集 + 一次汇总的最小结构，避免过度拆分。',
};

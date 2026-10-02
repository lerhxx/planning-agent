/**
 * 领域段 ⑦：evaluation —— 评测钩子（供 benchmark 与回归）。
 */
import type { DomainEvaluationContribution } from '@/shared/domain/types';

export const demoEvaluation: DomainEvaluationContribution = {
  cases: [
    {
      id: 'demo.smoke',
      input: '帮我做一个最小化验证：两路采集后汇总',
      expect: ['gather', 'gather', 'compose'],
    },
    {
      id: 'demo.replan',
      input: '验证失败后能否只重排受影响的部分',
      expect: ['保留已完成步骤', '重排下游子树'],
    },
  ],
  metricIds: ['first_component_ms', 'component_degraded', 'cost_per_turn'],
  score(caseId: string, actual: unknown): number {
    if (caseId !== 'demo.smoke') return 0;
    const steps = Array.isArray(actual) ? actual : [];
    return steps.length >= 3 ? 1 : 0;
  },
};

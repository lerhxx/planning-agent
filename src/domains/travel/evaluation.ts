/**
 * 领域段 ⑦：evaluation —— 评测钩子（供 benchmark 与回归）。
 *
 * 三个 case 分别对应本领域的三条硬规则：
 * 闭环跑完（happy path）、预算超标被拦截、事实缺来源被判失败。
 */
import type { DomainEvaluationContribution } from '@/shared/domain/types';

export const travelEvaluation: DomainEvaluationContribution = {
  cases: [
    {
      id: 'travel.happy-path',
      input: '帮我规划上海三日游，预算 3000 元，想看景点也吃本地菜',
      expect: ['poi_search', 'poi_search', 'poi_search', 'itinerary_compose', 'completed'],
    },
    {
      id: 'travel.budget-overrun',
      input: '上海三日游，预算 300',
      expect: ['ok:false', 'severity:error', 'VALIDATION_ASK_USER'],
    },
    {
      id: 'travel.missing-source',
      input: '（注入：让检索工具不返回来源）上海二日游',
      expect: ['SOURCE_MISSING', 'failed'],
    },
    // —— v2 三条新 case ——
    {
      id: 'travel.image-coverage',
      input: '（上传 10 张图）帮我按这些图规划上海三日游，预算 3000 元',
      expect: ['image_understand', 'itinerary_compose', 'completed'],
    },
    {
      id: 'travel.image-unresolved-clarify',
      input: '（上传 2 张识别不出的图）帮我规划上海三日游',
      // ★ Q-1 顺序：第一动作是**澄清**（用户看得到"跳过"），不是 error。
      expect: ['awaiting_user', 'ClarifyOptions', 'STEP_AWAITING_USER'],
    },
    {
      id: 'travel.image-mention-unresolved',
      input: '（上传 3 张图）@不存在的图 想拍夜景，帮我规划上海二日游',
      expect: ['unresolved', 'awaiting_user'],
    },
  ],
  metricIds: [
    'first_component_ms',
    'component_degraded',
    'cost_per_turn',
    'fact_source_coverage',
    'image_coverage',
  ],

  score(caseId: string, actual: unknown): number {
    if (caseId !== 'travel.happy-path') return 0;
    const steps = Array.isArray(actual) ? actual : [];
    const searches = steps.filter(
      (step) => typeof step === 'object' && step !== null && (step as { type?: string }).type === 'poi_search',
    );
    const compose = steps.filter(
      (step) => typeof step === 'object' && step !== null && (step as { type?: string }).type === 'itinerary_compose',
    );
    return searches.length >= 3 && compose.length === 1 ? 1 : 0;
  },
};

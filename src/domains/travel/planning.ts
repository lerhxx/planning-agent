/**
 * 领域段 ⑥：planning —— stepType 白名单 + 计划模板 + validateStep。
 *
 * 内核只做三件事：把 `stepTypes` 交给 Runtime、拿 `templates` 当规划素材、
 * 调 `validateStep` 后**只读 `ok` 与 `severity`**。
 */
import type { Step } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import type { DomainPlanningContribution, StepTypeDescriptor, ValidationResult } from '@/shared/domain/types';

export const POI_SEARCH_STEP_TYPE = 'poi_search';
export const ITINERARY_COMPOSE_STEP_TYPE = 'itinerary_compose';

export const travelStepTypes: StepTypeDescriptor[] = [
  {
    type: POI_SEARCH_STEP_TYPE,
    label: '检索目的地候选',
    description: '按城市 + 类别从 Provider 取回候选（事实，必带来源）',
    maxAttempts: 2,
  },
  {
    type: ITINERARY_COMPOSE_STEP_TYPE,
    label: '编排每日行程',
    description: '把检索到的候选按天编排成可执行的行程',
    maxAttempts: 2,
  },
];

export const travelTemplates: DomainPlanningContribution['templates'] = [
  {
    id: 'travel.basic',
    description: '三类候选并行检索 → 按天编排（严格 DAG）',
    steps: [
      {
        id: 's-1',
        type: POI_SEARCH_STEP_TYPE,
        title: '检索目的地景点',
        description: '按城市取回景点候选，带来源',
        dependsOn: [],
        parallelGroup: 'recon',
        intent: { toolName: 'travel.poiSearch', input: { category: 'attraction', limit: 4 }, producesFacts: true },
      },
      {
        id: 's-2',
        type: POI_SEARCH_STEP_TYPE,
        title: '检索目的地餐厅',
        description: '按城市取回餐厅候选，带来源',
        dependsOn: [],
        parallelGroup: 'recon',
        intent: { toolName: 'travel.poiSearch', input: { category: 'restaurant', limit: 4 }, producesFacts: true },
      },
      {
        id: 's-3',
        type: POI_SEARCH_STEP_TYPE,
        title: '检索目的地住宿',
        description: '按城市取回酒店候选，带来源',
        dependsOn: [],
        parallelGroup: 'recon',
        intent: { toolName: 'travel.poiSearch', input: { category: 'hotel', limit: 3 }, producesFacts: true },
      },
      {
        id: 's-4',
        type: ITINERARY_COMPOSE_STEP_TYPE,
        title: '编排每日行程',
        description: '把三类候选按天编排并给出总成本',
        dependsOn: ['s-1', 's-2', 's-3'],
        intent: { toolName: 'travel.itineraryCompose', input: {}, producesFacts: false },
      },
    ],
  },
];

export const travelPlanning: DomainPlanningContribution = {
  stepTypes: travelStepTypes,
  templates: travelTemplates,

  validateStep(step: Step, _ctx: RunContext): ValidationResult {
    const violations: Array<{ severity: 'error' | 'warning'; message: string }> = [];

    if (!travelStepTypes.some((descriptor) => descriptor.type === step.type)) {
      violations.push({ severity: 'error', message: `未知步骤类型：${step.type}` });
    }

    if (step.type === POI_SEARCH_STEP_TYPE) {
      // 检索步骤必须绑定事实型工具，否则无法保证数据来自 Provider。
      if (step.intent === null || step.intent.producesFacts !== true) {
        violations.push({ severity: 'error', message: '检索步骤必须绑定带来源的事实型工具' });
      }
    }

    if (step.type === ITINERARY_COMPOSE_STEP_TYPE && step.dependsOn.length === 0) {
      violations.push({ severity: 'error', message: '编排步骤必须依赖至少一个检索步骤' });
    }

    if (step.title.trim().length === 0) {
      violations.push({ severity: 'warning', message: '步骤标题为空' });
    }

    return { ok: !violations.some((item) => item.severity === 'error'), violations };
  },
};

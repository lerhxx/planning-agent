/**
 * 领域段 ⑥：planning —— stepType 白名单 + 计划模板 + validateStep。
 *
 * 内核只做三件事：把 `stepTypes` 交给 Runtime、拿 `templates` 当规划素材、
 * 调 `validateStep` 后**只读 `ok` 与 `severity`**。
 *
 * ★ 模板顺序的坑（本轮实测，务必保留这条注释）：
 * `MockRuntime` 的 `plan()` **只回放 `templates[0]`**（`script.ts` 的 `planDraft`）。
 * 而既有回归锁（`travelClosedLoop`）断言首轮计划恰好 4 步（3×`poi_search` + 1×`itinerary_compose`），
 * 因此 **`travel.basic` 必须留在 `templates[0]`**，图片优先的模板只能放 `templates[1]`。
 * 要让端到端跑图片链路，`src/core` 又不能改 —— 解决办法是在**领域自己的测试**里
 * 注入一个"选 `templates[1]`"的 MockScript（见 `src/test/travelV2.test.ts`）。
 */
import type { Step } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import type { DomainPlanningContribution, StepTypeDescriptor, ValidationResult } from '@/shared/domain/types';

export const POI_SEARCH_STEP_TYPE = 'poi_search';
export const ITINERARY_COMPOSE_STEP_TYPE = 'itinerary_compose';
export const IMAGE_UNDERSTAND_STEP_TYPE = 'image_understand';
export const TRIP_BRIEF_STEP_TYPE = 'trip_brief';

export const IMAGE_FIRST_TEMPLATE_ID = 'travel.image-first';

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
  {
    type: IMAGE_UNDERSTAND_STEP_TYPE,
    label: '理解上传的图片',
    description: '把本轮图片识别成可规划的地点；未识别的图会发澄清（补信息 / 跳过）',
    maxAttempts: 2,
  },
  {
    type: TRIP_BRIEF_STEP_TYPE,
    label: '确认行程口径',
    description: '确认城市 / 天数 / 预算；目标里没写天数时用表单问一次',
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
  {
    id: IMAGE_FIRST_TEMPLATE_ID,
    description: '先理解图片 → 再检索候选 → 按天编排（图片优先，覆盖度硬约束）',
    steps: [
      {
        id: 's-1',
        type: TRIP_BRIEF_STEP_TYPE,
        title: '确认行程口径',
        description: '确认城市 / 天数 / 预算',
        dependsOn: [],
        intent: { toolName: 'travel.tripBrief', input: {}, producesFacts: false },
      },
      {
        id: 's-2',
        type: IMAGE_UNDERSTAND_STEP_TYPE,
        title: '理解上传的图片',
        description: '把本轮图片识别成地点；未识别的发澄清',
        dependsOn: ['s-1'],
        intent: { toolName: 'travel.imageUnderstand', input: {}, producesFacts: true },
      },
      {
        id: 's-3',
        type: POI_SEARCH_STEP_TYPE,
        title: '检索目的地景点',
        description: '按城市取回景点候选，带来源',
        dependsOn: ['s-2'],
        parallelGroup: 'recon',
        intent: { toolName: 'travel.poiSearch', input: { category: 'attraction', limit: 4 }, producesFacts: true },
      },
      {
        id: 's-4',
        type: POI_SEARCH_STEP_TYPE,
        title: '检索目的地餐厅',
        description: '按城市取回餐厅候选，带来源',
        dependsOn: ['s-2'],
        parallelGroup: 'recon',
        intent: { toolName: 'travel.poiSearch', input: { category: 'restaurant', limit: 4 }, producesFacts: true },
      },
      {
        id: 's-5',
        type: POI_SEARCH_STEP_TYPE,
        title: '检索目的地住宿',
        description: '按城市取回酒店候选，带来源',
        dependsOn: ['s-2'],
        parallelGroup: 'recon',
        intent: { toolName: 'travel.poiSearch', input: { category: 'hotel', limit: 3 }, producesFacts: true },
      },
      {
        id: 's-6',
        type: ITINERARY_COMPOSE_STEP_TYPE,
        title: '编排每日行程',
        description: '图片项优先排入，再按填充上限补齐',
        dependsOn: ['s-2', 's-3', 's-4', 's-5'],
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

    // ★ 图片理解同样必须绑定事实型工具：识别结果是会被拿去编排的**事实**，
    // 没有来源就等于"模型说这是外滩"，正是红线 16 要挡的东西。
    if (step.type === IMAGE_UNDERSTAND_STEP_TYPE) {
      if (step.intent === null || step.intent.producesFacts !== true) {
        violations.push({ severity: 'error', message: '图片理解步骤必须绑定带来源的事实型工具' });
      }
    }

    // 口径确认步骤本身不产出事实，但必须绑定工具（否则这个 step 什么都不做）。
    if (step.type === TRIP_BRIEF_STEP_TYPE && step.intent === null) {
      violations.push({ severity: 'error', message: '口径确认步骤必须绑定工具' });
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

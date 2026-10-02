/**
 * 领域段 ⑥：planning —— stepType 白名单 + 计划模板 + validateStep。
 *
 * 内核只做三件事：把 `stepTypes` 交给 Runtime、拿 `templates` 当规划素材、
 * 调 `validateStep` 后**只读 `ok` 与 `severity`**。
 */
import type { Step } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import type { DomainPlanningContribution, StepTypeDescriptor } from '@/shared/domain/types';

export const demoStepTypes: StepTypeDescriptor[] = [
  {
    type: 'gather',
    label: '采集条目',
    description: '从 Provider 取回条目，必须带来源',
    maxAttempts: 2,
  },
  {
    type: 'compose',
    label: '汇总成文',
    description: '把上游结果整理成一段结论',
    maxAttempts: 2,
  },
];

export const demoPlanning: DomainPlanningContribution = {
  stepTypes: demoStepTypes,

  templates: [
    {
      id: 'demo.basic',
      description: '两路采集并行 → 汇总成文',
      steps: [
        {
          id: 's-1',
          type: 'gather',
          title: '采集条目 · 主口径',
          description: '从主数据源取回条目',
          dependsOn: [],
          parallelGroup: 'collect',
          intent: { toolName: 'demo.gather', input: { limit: 2 }, producesFacts: true },
        },
        {
          id: 's-2',
          type: 'gather',
          title: '采集条目 · 交叉口径',
          description: '从交叉数据源取回条目，用于比对',
          dependsOn: [],
          parallelGroup: 'collect',
          intent: { toolName: 'demo.gather', input: { limit: 2 }, producesFacts: true },
        },
        {
          id: 's-3',
          type: 'compose',
          title: '汇总成文',
          description: '合并两路结果并给出结论',
          dependsOn: ['s-1', 's-2'],
          intent: { toolName: 'demo.compose', input: {}, producesFacts: false },
        },
      ],
    },
  ],

  validateStep(step: Step, _ctx: RunContext) {
    const violations: Array<{ severity: 'error' | 'warning'; message: string }> = [];

    if (!demoStepTypes.some((descriptor) => descriptor.type === step.type)) {
      violations.push({ severity: 'error', message: `未知步骤类型：${step.type}` });
    }
    if (step.type === 'gather' && step.intent === null) {
      violations.push({ severity: 'error', message: '采集步骤必须绑定工具' });
    }
    if (step.title.trim().length === 0) {
      violations.push({ severity: 'warning', message: '步骤标题为空' });
    }

    return { ok: !violations.some((item) => item.severity === 'error'), violations };
  },
};

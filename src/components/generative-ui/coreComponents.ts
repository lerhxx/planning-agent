/**
 * 内核通用组件的注册入口（前端启动时执行一次）。
 *
 * 八个通用组件 + 三级降级链，全部**领域无关** —— 删除任何 `src/domains/*` 后它们仍在。
 */
import { registerCoreComponents } from './registry';
import { zPlanViewProps } from './PlanView/schema';
import { zStepItemProps } from './StepItem/schema';
import { zRawPayloadCardProps } from './RawPayloadCard/schema';
import { zClarifyOptionsProps } from './ClarifyOptions/schema';
import { zErrorStateProps } from './ErrorState/schema';
import { zSkeletonListProps } from './SkeletonList/schema';
import { zCalendarFieldProps } from './fields/CalendarField/schema';
import { zChoiceGroupFieldProps } from './fields/ChoiceGroupField/schema';

let registered = false;

export function registerCoreUIComponents(): void {
  if (registered) return;
  registered = true;

  registerCoreComponents([
    {
      name: 'PlanView',
      description: '计划总览：步骤列表 + 整体进度',
      schema: zPlanViewProps,
      requiredProps: ['steps'],
      modelCallable: false,
      lazy: true,
      load: () => import('./PlanView'),
    },
    {
      name: 'StepItem',
      description: '单个步骤卡片：标题、状态徽标、耗时、依赖',
      schema: zStepItemProps,
      requiredProps: ['id'],
      modelCallable: false,
      lazy: true,
      load: () => import('./StepItem'),
    },
    {
      name: 'RawPayloadCard',
      description: '一级降级：展示原始载荷',
      schema: zRawPayloadCardProps,
      requiredProps: [],
      modelCallable: false,
      lazy: false,
      load: () => import('./RawPayloadCard'),
    },
    {
      name: 'ClarifyOptions',
      description: '二级降级：让用户点选或填表',
      schema: zClarifyOptionsProps,
      // ★ `prompt` 是选项模式与表单模式**共有**的唯一必填键。
      // 若沿用 `options`，表单模式（有 fields 无 options）会被判成 props 未补齐 → 永久骨架。
      requiredProps: ['prompt'],
      modelCallable: true,
      lazy: false,
      load: () => import('./ClarifyOptions'),
    },
    {
      name: 'ErrorState',
      description: '三级降级：错误态 + traceId',
      schema: zErrorStateProps,
      requiredProps: [],
      modelCallable: false,
      lazy: false,
      load: () => import('./ErrorState'),
    },
    {
      name: 'SkeletonList',
      description: '等待首个组件时的骨架',
      schema: zSkeletonListProps,
      requiredProps: [],
      modelCallable: false,
      lazy: false,
      load: () => import('./SkeletonList'),
    },
    {
      name: 'CalendarField',
      description: '日期选择卡：精确日期 / 日期区间 / 灵活的天数',
      schema: zCalendarFieldProps,
      // 整张 schema 的每个键都有 `.default()` 或 `.optional()`，
      // 因此**没有必填键** —— 空 props 也能立即渲染（不会卡在骨架）。
      requiredProps: [],
      modelCallable: true,
      lazy: true,
      load: () => import('./fields/CalendarField'),
    },
    {
      name: 'ChoiceGroupField',
      description: '分组选择卡：单选 / 多选，一次提交',
      schema: zChoiceGroupFieldProps,
      // 同上：`groups` 带 `.default([])`，空 props 也是合法输入。
      requiredProps: [],
      modelCallable: true,
      lazy: true,
      load: () => import('./fields/ChoiceGroupField'),
    },
  ]);
}

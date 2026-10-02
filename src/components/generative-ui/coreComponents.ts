/**
 * 内核通用组件的注册入口（前端启动时执行一次）。
 *
 * 五个通用组件 + 三级降级链，全部**领域无关** —— 删除任何 `src/domains/*` 后它们仍在。
 */
import { registerCoreComponents } from './registry';
import { zPlanViewProps } from './PlanView/schema';
import { zStepItemProps } from './StepItem/schema';
import { zRawPayloadCardProps } from './RawPayloadCard/schema';
import { zClarifyOptionsProps } from './ClarifyOptions/schema';
import { zErrorStateProps } from './ErrorState/schema';
import { zSkeletonListProps } from './SkeletonList/schema';

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
      description: '二级降级：让用户点选',
      schema: zClarifyOptionsProps,
      requiredProps: ['options'],
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
  ]);
}

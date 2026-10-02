import { z } from 'zod';
import { zPlanStatus } from '@/shared/plan/types';
import { zStepItemProps } from '../StepItem/schema';

/** 计划总览。props 全程可缺失：没补齐就渲染骨架，不报错。 */
export const zPlanViewProps = z.object({
  planId: z.string().optional(),
  goal: z.string().optional(),
  status: zPlanStatus.default('draft'),
  revision: z.number().int().nonnegative().default(1),
  summary: z.string().optional(),
  steps: z.array(zStepItemProps).default([]),
  totalDurationMs: z.number().nonnegative().default(0),
  estimatedCostCNY: z.number().nonnegative().default(0),
  activeStepId: z.string().optional(),
});

export type PlanViewProps = z.infer<typeof zPlanViewProps>;

import { z } from 'zod';
import { zStepStatus } from '@/shared/plan/types';

export const zStepItemProps = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  status: zStepStatus.default('pending'),
  order: z.number().int().nonnegative().default(0),
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(2),
  durationMs: z.number().nonnegative().default(0),
  dependsOn: z.array(z.string()).default([]),
  parallelGroup: z.string().optional(),
  errorMessage: z.string().optional(),
});

export type StepItemProps = z.infer<typeof zStepItemProps>;

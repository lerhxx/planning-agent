import { z } from 'zod';

/** 三级降级：彻底失败 → 错误态 + traceId。 */
export const zErrorStateProps = z.object({
  title: z.string().optional(),
  message: z.string().optional(),
  traceId: z.string().optional(),
  recoverable: z.boolean().default(true),
});

export type ErrorStateProps = z.infer<typeof zErrorStateProps>;

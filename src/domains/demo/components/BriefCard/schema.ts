import { z } from 'zod';

/** 汇总结论卡片。 */
export const zBriefCardProps = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  bullets: z.array(z.string()).default([]),
  disclaimer: z.string().optional(),
});

export type BriefCardProps = z.infer<typeof zBriefCardProps>;

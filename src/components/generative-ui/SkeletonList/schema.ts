import { z } from 'zod';

/** 等待首个组件 / props 未补齐时的骨架。 */
export const zSkeletonListProps = z.object({
  rows: z.number().int().positive().max(12).default(3),
  label: z.string().default('加载中'),
});

export type SkeletonListProps = z.infer<typeof zSkeletonListProps>;

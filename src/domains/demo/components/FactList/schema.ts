import { z } from 'zod';

/** 采集结果的条目列表。props 全程可缺失：没补齐渲染骨架，不报错。 */
export const zFactListProps = z.object({
  title: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        value: z.string(),
        source: z.string().optional(),
      }),
    )
    .default([]),
  sourceRefs: z
    .array(
      z.object({
        label: z.string(),
        uri: z.string().optional(),
      }),
    )
    .default([]),
  disclaimer: z.string().optional(),
  isEstimate: z.boolean().default(false),
});

export type FactListProps = z.infer<typeof zFactListProps>;

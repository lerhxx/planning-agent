import { z } from 'zod';

/** 一条候选的所有字段都可能缺失：props 没补齐时渲染骨架，绝不报错。 */
export const zPoiCardItem = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  categoryLabel: z.string().default(''),
  rating: z.number().min(0).max(5).default(0),
  priceLevel: z.number().int().min(1).max(4).default(1),
  priceCNY: z.number().nonnegative().default(0),
  address: z.string().default(''),
  tags: z.array(z.string()).default([]),
  source: z.string().optional(),
});

export const zPoiCardSourceRef = z.object({
  label: z.string().default(''),
  uri: z.string().optional(),
});

export const zPoiCardProps = z.object({
  title: z.string().optional(),
  city: z.string().optional(),
  categoryLabel: z.string().optional(),
  items: z.array(zPoiCardItem).default([]),
  sourceRefs: z.array(zPoiCardSourceRef).default([]),
  disclaimer: z.string().optional(),
  isEstimate: z.boolean().default(false),
  note: z.string().optional(),
});

export type PoiCardProps = z.infer<typeof zPoiCardProps>;

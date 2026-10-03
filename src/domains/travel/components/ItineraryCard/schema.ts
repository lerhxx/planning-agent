import { z } from 'zod';
import { zMdBlock } from '@/src/domains/travel/markdown';

export const zItinerarySlot = z.object({
  name: z.string().default(''),
  categoryLabel: z.string().default(''),
  slot: z.string().default(''),
  priceCNY: z.number().nonnegative().default(0),
  source: z.string().optional(),
  /**
   * ★ 意图溯源（K6）：`image` = 来自用户上传的图片；`fill` = Provider 给的填充推荐。
   * 与内核的 `Step.origin`（planner/replan/user，编辑溯源）**同名不同义**，禁止互相复用。
   */
  origin: z.enum(['image', 'fill']).default('fill'),
  /** `origin:'image'` 时非空；同名多命中会带上**全部** assetId。 */
  assetIds: z.array(z.string()).default([]),
});

export const zItineraryNote = z.object({
  assetId: z.string().optional(),
  text: z.string().default(''),
});

export const zItineraryCardDay = z.object({
  day: z.number().int().positive().default(1),
  theme: z.string().default(''),
  items: z.array(zItinerarySlot).default([]),
  notes: z.array(zItineraryNote).default([]),
  stayName: z.string().optional(),
  stayPriceCNY: z.number().nonnegative().default(0),
  costCNY: z.number().nonnegative().default(0),
});

/** 覆盖度徽标（§3.2 口径 4：进 props，不进 violations）。 */
export const zItineraryCoverage = z.object({
  total: z.number().int().nonnegative().default(0),
  covered: z.number().int().nonnegative().default(0),
  skippedAssetIds: z.array(z.string()).default([]),
  missingAssetIds: z.array(z.string()).default([]),
  ratio: z.number().min(0).max(1).default(1),
  fillCount: z.number().int().nonnegative().default(0),
  fillRatio: z.number().min(0).max(1).default(0),
});

export const zItineraryCardProps = z.object({
  title: z.string().optional(),
  city: z.string().optional(),
  days: z.array(zItineraryCardDay).default([]),
  totalCostCNY: z.number().nonnegative().default(0),
  /** null = 用户没在目标里给预算，此时不展示预算行。 */
  budgetCNY: z.number().nonnegative().nullable().default(null),
  overBudget: z.boolean().default(false),
  coverage: zItineraryCoverage.optional(),
  /** markdown → blocks：只承载叙述，价格/评分/地址一律在结构化字段里。 */
  summaryBlocks: z.array(zMdBlock).default([]),
  sourceRefs: z.array(z.object({ label: z.string().default(''), uri: z.string().optional() })).default([]),
  disclaimer: z.string().optional(),
  isEstimate: z.boolean().default(false),
  note: z.string().optional(),
});

export type ItineraryCardProps = z.infer<typeof zItineraryCardProps>;

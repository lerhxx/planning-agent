import { z } from 'zod';

/** 一条识别结果。**每条都必须能点开看 source**（反幻觉：可溯源才可信）。 */
export const zVisionResultItem = z.object({
  assetId: z.string().default(''),
  name: z.string().default(''),
  identifiedName: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0),
  source: z.string().default(''),
});

export const zVisionResultCardProps = z.object({
  title: z.string().optional(),
  items: z.array(zVisionResultItem).default([]),
  /** 0 命中的图片 id（保持顺序）。**不静默丢弃**：列出来才看得见。 */
  unresolvedAssetIds: z.array(z.string()).default([]),
  skippedAssetIds: z.array(z.string()).default([]),
  disclaimer: z.string().optional(),
  isEstimate: z.boolean().default(false),
  note: z.string().optional(),
});

export type VisionResultCardProps = z.infer<typeof zVisionResultCardProps>;

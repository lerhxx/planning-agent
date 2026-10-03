import { z } from 'zod';

/** 缩略图区的一项。识别态与跳过态都是**可见**的（不允许静默）。 */
export const zImageWallItem = z.object({
  assetId: z.string().default(''),
  name: z.string().default(''),
  /** 识别结果：未识别留空（不猜一个名字）。 */
  identifiedName: z.string().optional(),
  /** 用户显式跳过（§3.2 四态之一）。 */
  skipped: z.boolean().default(false),
});

export const zImageWallProps = z.object({
  title: z.string().optional(),
  items: z.array(zImageWallItem).default([]),
  /** 被打回未决的数量：>0 时卡片必须提示，不让用户以为全都排进去了。 */
  unresolvedCount: z.number().int().nonnegative().default(0),
  note: z.string().optional(),
});

export type ImageWallProps = z.infer<typeof zImageWallProps>;

/**
 * 领域段 ③ · 子模块 ②：`vision.ts` —— **图片理解数据源的占位**（v2 第二批填内容）。
 *
 * 边界（设计 §5.2）：
 * - **做**：`assetId → { identifiedName?, confidence, source }` 的**数据源**；
 * - **不做**：覆盖度判定（→ `compose.ts` / `planCheck.ts`）、澄清问题构造、行程编排。
 *
 * 依赖方向：`vision.ts` 与 `poi.ts` **互不依赖**（两个独立数据源，设计 §5.3），
 * 因此这里不 import 任何同目录模块，只用 zod。
 *
 * ★ 本轮（第一批）**只建占位**：
 * - 契约 `zAttachment` 已 landed，但 `travel.imageUnderstand` 工具、stepType `image_understand`、
 *   `ProviderAdapter` 的注册都在第二批（等 `tools.ts` / `planning.ts` 那一批的编排）；
 * - 因此这里**只**落地"数据源的形状 + 查表纯函数"，fixture 表当前为空 ——
 *   空表不是 TODO：查表函数对任何 assetId 都会返回 `unresolved`，行为是完整、可单测的。
 */
import { z } from 'zod';

export const VISION_PROVIDER_ID = 'travel.vision';
export const VISION_SOURCE_NAMESPACE = 'travel.vision';

export const VISION_DISCLAIMER =
  '图片识别结果来自领域内置 fixture Provider（离线样例数据），不代表真实识别能力，出行前请自行复核';

/** 单张图片的识别结果。**未识别出来就不写 `identifiedName`**（绝不猜一个名字）。 */
export const zVisionRecord = z.object({
  assetId: z.string().min(1),
  /** 识别出的名称；缺失即"这张没认出来"。 */
  identifiedName: z.string().min(1).optional(),
  /** 置信度 0~1。★ 它是**数值事实**，只能来自 Provider，模型不得编造（红线 16）。 */
  confidence: z.number().min(0).max(1),
  /** ★ 反幻觉：每条事实都要能溯源。 */
  source: z.string().min(1),
});
export type VisionRecord = z.infer<typeof zVisionRecord>;

/**
 * 图片识别 fixture 表（离线常量，零网络零密钥）。
 *
 * ★ 当前**为空是刻意的**：占位阶段不伪造任何识别结果。
 * 空表下 `listVisionRecords` 对任何入参都返回 `unresolved` —— 这是"没识别出来"，
 * 按 §3.2.1 走澄清而不是静默放行。
 */
export const VISION_FIXTURES: Readonly<Record<string, VisionRecord>> = {};

export interface VisionLookupResult {
  /** 已识别出的记录（每条带 source）。 */
  identified: VisionRecord[];
  /** 没能识别出来的 assetId（保持入参顺序，去重）。 */
  unresolvedAssetIds: string[];
}

/**
 * 按 assetId 查识别结果。**纯函数**（不查进程状态，可单测）。
 *
 * 未命中的 assetId 一律进 `unresolvedAssetIds` —— 不编造、不丢弃。
 */
export function listVisionRecords(assetIds: readonly string[]): VisionLookupResult {
  const identified: VisionRecord[] = [];
  const unresolvedAssetIds: string[] = [];

  for (const assetId of [...new Set(assetIds ?? [])]) {
    const hit = VISION_FIXTURES[assetId];
    if (hit && typeof hit.identifiedName === 'string') {
      identified.push(zVisionRecord.parse(hit));
    } else {
      unresolvedAssetIds.push(assetId);
    }
  }

  return { identified, unresolvedAssetIds };
}

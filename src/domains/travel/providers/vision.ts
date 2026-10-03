/**
 * 领域段 ③ · 子模块 ②：`vision.ts` —— **图片理解数据源**（fixture，零网络零密钥）。
 *
 * 边界（设计 §5.2）：
 * - **做**：`asset{id,name} → { identifiedName?, category?, confidence, source }` 的**数据源**；
 * - **不做**：覆盖度判定（→ `compose.ts` / `planCheck.ts`）、澄清问题构造（→ `mentions.ts`）、行程编排。
 *
 * 依赖方向：`vision.ts` 与 `poi.ts` **互不依赖**（两个独立数据源，设计 §5.3），
 * 因此这里不 import 任何同目录模块，只用 zod + `shared`。
 *
 * ★ 与 §5.2 字面描述的一处**必要偏离**（已核过，不是偷懒）：
 * 设计写的是「`assetId` → 识别结果」，但 `assetId` 由服务端 `crypto.randomUUID()` 生成（K1），
 * **无法预先写进离线 fixture 表**。因此本实现按**名字**（完整名 → 去扩展名）查表，
 * 再把真实 `assetId` 填回产出记录；`assetId` 仍作为第一优先键保留（显式种子可覆盖）。
 *
 * ★ 没收录在表里的名字一律落 `unresolved` —— **绝不猜一个名字挂上去**。
 * 这是红线 16 的直接后果：识别不出就说识别不出，走澄清（§3.2.1），不冒充。
 */
import { z } from 'zod';
import type { Attachment } from '@/shared/plan/types';

export const VISION_PROVIDER_ID = 'travel.vision';
export const VISION_SOURCE_NAMESPACE = 'travel.vision';

export const VISION_DISCLAIMER =
  '图片识别结果来自领域内置 fixture Provider（离线样例数据），不代表真实识别能力，出行前请自行复核';

/** 查表入参只需要这两个字段（从契约类型 `Attachment` 派生，不手写第二份）。 */
export type VisionLookupAsset = Pick<Attachment, 'id' | 'name'>;

/** 单张图片的识别结果。**识别不出来就不写 `identifiedName`**（绝不猜）。 */
export const zVisionRecord = z.object({
  assetId: z.string().min(1),
  identifiedName: z.string().min(1),
  /** 识别出的类别（自由字符串，由 `compose.ts` 校验是否落在三类白名单内）。 */
  category: z.string().optional(),
  /** 置信度 0~1。★ 它是**数值事实**，只能来自 Provider，模型不得编造（红线 16）。 */
  confidence: z.number().min(0).max(1),
  /** ★ 反幻觉：每条事实都要能溯源。 */
  source: z.string().min(1),
});
export type VisionRecord = z.infer<typeof zVisionRecord>;

/** fixture 表里存的是"认出什么"，`assetId` 在查表时才填（同一张图可被多个 run 引用）。 */
export const zVisionFixture = z.object({
  identifiedName: z.string().min(1),
  category: z.string().optional(),
  confidence: z.number().min(0).max(1),
});
export type VisionFixture = z.infer<typeof zVisionFixture>;

/**
 * 图片识别 fixture 表（离线常量，零网络零密钥）。
 *
 * 键 = **归一化的图片名**（trim + 小写），查表顺序：完整名 → 去扩展名 → assetId。
 * ★ 刻意**只收录一部分**名字：没收录的就是"这张没认出来"，按 §3.2.1 走澄清，
 * 而不是伪造一条识别结果 —— 表越全越像真识图，反而掩盖了"未识别必须可见"这条 P0。
 */
export const VISION_FIXTURES: Readonly<Record<string, VisionFixture>> = {
  '外滩.jpg': { identifiedName: '外滩', category: 'attraction', confidence: 0.93 },
  '外滩': { identifiedName: '外滩', category: 'attraction', confidence: 0.93 },
  '豫园.jpg': { identifiedName: '豫园', category: 'attraction', confidence: 0.88 },
  '豫园': { identifiedName: '豫园', category: 'attraction', confidence: 0.88 },
  '上海博物馆.jpg': { identifiedName: '上海博物馆', category: 'attraction', confidence: 0.9 },
  '田子坊.jpg': { identifiedName: '田子坊', category: 'attraction', confidence: 0.81 },
  '故宫博物院.jpg': { identifiedName: '故宫博物院', category: 'attraction', confidence: 0.95 },
  '颐和园.jpg': { identifiedName: '颐和园', category: 'attraction', confidence: 0.87 },
  '宽窄巷子.jpg': { identifiedName: '宽窄巷子', category: 'attraction', confidence: 0.84 },
  '锦里古街.jpg': { identifiedName: '锦里古街', category: 'attraction', confidence: 0.8 },
  '南翔馒头店.jpg': { identifiedName: '南翔馒头店', category: 'restaurant', confidence: 0.76 },
  '老吉士酒家.jpg': { identifiedName: '老吉士酒家', category: 'restaurant', confidence: 0.72 },
  '全聚德前门店.jpg': { identifiedName: '全聚德前门店', category: 'restaurant', confidence: 0.79 },
  '小龙坎火锅春熙路店.jpg': {
    identifiedName: '小龙坎火锅春熙路店',
    category: 'restaurant',
    confidence: 0.74,
  },
  '费尔蒙和平饭店.jpg': { identifiedName: '费尔蒙和平饭店', category: 'hotel', confidence: 0.7 },
  '成都太古里博舍酒店.jpg': {
    identifiedName: '成都太古里博舍酒店',
    category: 'hotel',
    confidence: 0.68,
  },
};

export interface VisionLookupResult {
  /** 已识别出的记录（每条带 source，assetId 是**真实**的入参 id）。 */
  identified: VisionRecord[];
  /** 没能识别出来的 assetId（保持入参顺序，去重）。 */
  unresolvedAssetIds: string[];
}

/** 名字归一：trim + 小写，避免大小写/空格差异导致同一张图时而命中时而不命中。 */
export function normalizeAssetName(name: string): string {
  return (name ?? '').trim().toLowerCase();
}

/** 去掉最后一段扩展名：`外滩.JPG → 外滩`；没有点号则原样返回。 */
export function stripNameExtension(name: string): string {
  return name.replace(/\.[^.]*$/, '');
}

/** 查一条 fixture：assetId 优先，其次完整名，最后去扩展名。**纯函数**。 */
function lookupFixture(asset: VisionLookupAsset): VisionFixture | undefined {
  const byId = VISION_FIXTURES[normalizeAssetName(asset.id)];
  if (byId) return byId;
  const name = normalizeAssetName(asset.name);
  const byName = VISION_FIXTURES[name];
  if (byName) return byName;
  return VISION_FIXTURES[stripNameExtension(name)];
}

/**
 * 按附件查识别结果。**纯函数**（不查进程状态，可单测）。
 *
 * 未命中的 assetId 一律进 `unresolvedAssetIds` —— 不编造、不丢弃。
 */
export function listVisionRecords(assets: readonly VisionLookupAsset[]): VisionLookupResult {
  const identified: VisionRecord[] = [];
  const unresolvedAssetIds: string[] = [];
  const seen = new Set<string>();

  for (const asset of assets ?? []) {
    const id = asset?.id;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);

    const fixture = lookupFixture(asset);
    if (!fixture) {
      unresolvedAssetIds.push(id);
      continue;
    }
    identified.push(
      zVisionRecord.parse({
        assetId: id,
        identifiedName: fixture.identifiedName,
        ...(fixture.category ? { category: fixture.category } : {}),
        confidence: fixture.confidence,
        source: `fixture://travel/vision/${encodeURIComponent(fixture.identifiedName)}`,
      }),
    );
  }

  return { identified, unresolvedAssetIds };
}

/** 单条识别结果的 source（供工具拼 `sourceRefs`，保证与记录同源）。 */
export function makeVisionSourceRef(identifiedName: string): {
  providerId: string;
  namespace: string;
  uri: string;
  label: string;
  retrievedAt: string;
  isEstimate: boolean;
} {
  return {
    providerId: VISION_PROVIDER_ID,
    namespace: VISION_SOURCE_NAMESPACE,
    uri: `fixture://travel/vision/${encodeURIComponent(identifiedName)}`,
    label: `图片识别 fixture · ${identifiedName}`,
    retrievedAt: new Date().toISOString(),
    isEstimate: true,
  };
}

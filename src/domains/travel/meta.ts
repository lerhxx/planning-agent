/**
 * 领域段 ①：meta —— 领域元数据与路由匹配。
 *
 * ★★ K16：`requiredSignals: ['image','text']` 是**声明**，不是"内核准入" —— 两句话必须分开写：
 * ① travel 的 meta **声明**它需要 image + text，并声明 `capabilities.vision: true`；
 * ② **内核当前不读 `requiredSignals`、不做准入检查**（准入检查在 T2-14 / P1）。
 * 因此"声明了 image"绝不等于"已支持图片准入"。
 *
 * ⚠️ v2 变化：`signals` 已由引擎按附件种类派生（`engine.ts`：
 * `signals: ['text', ...attachments.map(a => a.kind)]`），所以带图时 `ctx.signals` 确实会含 `image`。
 * 但**是否据此拦下不带图的 run，是内核的事**，本文件只负责声明。
 */
import type { DomainMeta } from '@/shared/domain/types';

export const TRAVEL_DOMAIN_ID = 'travel';

export const travelMeta: DomainMeta = {
  id: TRAVEL_DOMAIN_ID,
  displayName: '出行行程规划',
  version: '0.2.0',
  schemaVersion: 1,
  description:
    '把一次出行目标拆成「理解图片 → 检索目的地候选 → 按天编排行程」，' +
    '行程须涵盖所有图片内容并可适当填充推荐，带预算 / 天数 / 密度 / 图片覆盖度的硬校验。',
  matcher: {
    keywords: [
      '行程', '旅游', '出游', '旅行', '攻略', '目的地', 'travel', 'trip',
      '图片', '照片', '打卡', '这几张', '帮我看看',
    ],
    patterns: ['\\d+\\s*日游', '\\d+\\s*天游'],
    negativeKeywords: [],
    scoreBySignals: { text: 1, image: 1, geo: 0.5 },
  },
  requiredSignals: ['image', 'text'],
  capabilities: {
    vision: true,
    geo: true,
    providers: true,
    timeSequence: true,
  },
};

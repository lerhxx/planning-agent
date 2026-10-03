/**
 * 领域段 ①：meta —— 领域元数据与路由匹配。
 *
 * ★ 关于多模态（图片）：`InputSignalKind` 里 image 是一等信号，但**本阶段不实现**图片上传与
 * 视觉识图链路（`requiredSignals` 目前只是 meta 上的声明，内核尚无强制点；一旦将来按
 * `requiredSignals ⊆ ctx.signals` 做准入检查，声明 image 会直接让 run 失败 ——
 * 引擎当前写死 `signals: ['text']`）。因此这里声明 `['text']`，
 * 并在 description 里注明视觉识图为后续能力，待真实模型 Runtime 接入后再放开。
 */
import type { DomainMeta } from '@/shared/domain/types';

export const TRAVEL_DOMAIN_ID = 'travel';

export const travelMeta: DomainMeta = {
  id: TRAVEL_DOMAIN_ID,
  displayName: '出行行程规划',
  version: '0.1.0',
  schemaVersion: 1,
  description:
    '把一次出行目标拆成「检索目的地候选 → 按天编排行程」，并带预算 / 天数 / 行程密度的硬校验。' +
    '（视觉识图为后续能力，待真实模型 Runtime 接入）',
  matcher: {
    keywords: ['行程', '旅游', '出游', '旅行', '攻略', '目的地', 'travel', 'trip'],
    patterns: ['\\d+\\s*日游', '\\d+\\s*天游'],
    negativeKeywords: [],
    scoreBySignals: { text: 1, geo: 0.5 },
  },
  requiredSignals: ['text'],
  capabilities: {
    vision: false,
    geo: true,
    providers: true,
    timeSequence: true,
  },
};

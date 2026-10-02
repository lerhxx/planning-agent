/**
 * ⚠️ 本目录是**验证装置，不是产品领域**。
 *
 * 它存在的唯一目的：证明「内核 + DomainPack 契约」能跑通
 * 「目标 → 计划 → 执行 → 重规划」闭环。它刻意做到最小：
 * 2 个 stepType、2 个 tool、1 个无网络 fixture provider。
 * 真正的产品领域请另建 `src/domains/<id>/`，内核不需要任何改动。
 */
import type { DomainMeta } from '@/shared/domain/types';

export const demoMeta: DomainMeta = {
  id: 'demo',
  displayName: 'Demo（验证装置）',
  version: '0.1.0',
  schemaVersion: 1,
  description: '用于验证内核闭环的最小领域包：两路采集并行后汇总，数据源为本地 fixture',
  matcher: {
    keywords: ['演示', 'demo', '验证'],
    patterns: [],
    negativeKeywords: [],
    scoreBySignals: { text: 1 },
  },
  requiredSignals: ['text'],
  capabilities: {
    vision: false,
    geo: false,
    providers: true,
    timeSequence: false,
  },
};

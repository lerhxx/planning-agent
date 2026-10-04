'use client';

import type { VisionResultCardProps } from './schema';

/**
 * 领域组件：图片识别结果清单。
 *
 * ★ 未识别与已跳过**都列出来**（不静默丢弃），且每条已识别项都能看到 source ——
 * 认不出就说认不出，认出来了就要能溯源（红线 16）。
 */
export default function VisionResultCard(props: Partial<VisionResultCardProps>) {
  const items = props.items ?? [];
  const unresolved = props.unresolvedAssetIds ?? [];
  const skipped = props.skippedAssetIds ?? [];

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent-strong)]">
          识别结果 {items.length} 条
        </span>
        <span className="text-xs text-[var(--color-text-strong)]">
          {props.title ?? '图片识别'}
        </span>
        {props.isEstimate ? (
          <span className="rounded bg-[var(--color-fill-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
            样例数据
          </span>
        ) : null}
      </div>

      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={item.assetId || item.name}
            className="rounded-[var(--radius-control)] bg-[var(--color-surface)] px-2 py-1"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs text-[var(--color-text-strong)]">
                {item.name || '未命名'} → {item.identifiedName ?? '未识别'}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-[var(--color-accent-strong)]">
                {Math.round(item.confidence * 100)}%
              </span>
            </div>
            {item.source ? (
              <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-weak)]">
                来源 {item.source}
              </div>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-[11px] text-[var(--color-text-weak)]">还没有识别结果</li>
        ) : null}
      </ul>

      {unresolved.length > 0 ? (
        <p className="mt-1 text-[11px] text-amber-700">未识别 {unresolved.length} 张</p>
      ) : null}
      {skipped.length > 0 ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
          已跳过 {skipped.length} 张
        </p>
      ) : null}
      {props.note ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{props.note}</p>
      ) : null}
      {props.disclaimer ? (
        <p className="mt-1 text-[11px] text-amber-700">{props.disclaimer}</p>
      ) : null}
    </div>
  );
}

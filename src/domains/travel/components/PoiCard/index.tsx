'use client';

import type { PoiCardProps } from './schema';

/**
 * 领域组件：单条候选卡片。
 *
 * ★ **只展示 Provider 给的数据**：没有字段就留空或显示占位，绝不自己补一个看起来合理的数。
 */
export default function PoiCard(props: Partial<PoiCardProps>) {
  const items = props.items ?? [];
  const sourceRefs = props.sourceRefs ?? [];

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700">
          {props.categoryLabel ?? '候选'} {items.length}
        </span>
        <span className="text-xs text-[var(--color-text-strong)]">
          {props.title ?? '候选清单'}
        </span>
        {props.city ? (
          <span className="text-[11px] text-[var(--color-text-secondary)]">· {props.city}</span>
        ) : null}
        {props.isEstimate ? (
          <span className="rounded bg-[var(--color-fill-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
            样例数据
          </span>
        ) : null}
      </div>

      <ul className="space-y-1.5">
        {items.map((item) => (
          <li
            key={item.id || item.name}
            className="rounded-[var(--radius-control)] bg-[var(--color-surface)] px-2 py-1.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs text-[var(--color-text-strong)]">
                {item.name || '未命名'}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-amber-700">
                ¥{item.priceCNY}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--color-text-secondary)]">
              <span>{item.categoryLabel || '候选'}</span>
              <span>评分 {item.rating.toFixed(1)}</span>
              <span>{'¥'.repeat(Math.max(1, Math.min(4, item.priceLevel)))}</span>
              {item.address ? <span className="truncate">{item.address}</span> : null}
            </div>
            {item.tags.length > 0 ? (
              <div className="mt-0.5 text-[11px] text-[var(--color-text-weak)]">
                {item.tags.join(' · ')}
              </div>
            ) : null}
            {item.source ? (
              <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-weak)]">
                来源 {item.source}
              </div>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-[11px] text-[var(--color-text-weak)]">还没有候选</li>
        ) : null}
      </ul>

      {sourceRefs.length > 0 ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-weak)]">
          数据来源：{sourceRefs.map((ref) => ref.label).join('、')}
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

'use client';

import type { FactListProps } from './schema';

/** 领域组件：条目列表。**只展示 Provider 给的数据，不自己造数据。** */
export default function FactList(props: Partial<FactListProps>) {
  const items = props.items ?? [];

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent-strong)]">
          条目 {items.length}
        </span>
        <span className="text-xs text-[var(--color-text-strong)]">
          {props.title ?? '采集结果'}
        </span>
        {props.isEstimate ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700">
            估算数据
          </span>
        ) : null}
      </div>

      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between rounded-[var(--radius-control)] bg-[var(--color-surface)] px-2 py-1 text-xs"
          >
            <span className="truncate text-[var(--color-text-strong)]">{item.label}</span>
            <span className="shrink-0 font-mono text-[var(--color-text-strong)]">{item.value}</span>
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-[11px] text-[var(--color-text-weak)]">还没有条目</li>
        ) : null}
      </ul>

      {(props.sourceRefs ?? []).length > 0 ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-weak)]">
          来源：
          {(props.sourceRefs ?? []).map((ref) => ref.label).join('、')}
        </p>
      ) : null}

      {props.disclaimer ? (
        <p className="mt-1 text-[11px] text-amber-700">{props.disclaimer}</p>
      ) : null}
    </div>
  );
}

'use client';

import type { SkeletonListProps } from './schema';

/** props 未补齐时的骨架：只占位，不报错、不闪烁。 */
export default function SkeletonList(props: Partial<SkeletonListProps>) {
  const rows = props.rows ?? 3;
  return (
    <div className="space-y-1.5" aria-busy>
      <p className="text-[11px] text-[var(--color-text-weak)]">{props.label ?? '加载中'}</p>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-4 animate-pulse rounded-[var(--radius-control)] bg-[var(--color-fill-strong)]"
          style={{ width: `${100 - index * 12}%` }}
        />
      ))}
    </div>
  );
}

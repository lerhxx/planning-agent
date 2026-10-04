'use client';

import type { ImageWallProps } from './schema';

/**
 * 领域组件：本轮上传图片的缩略图区（输入侧）。
 *
 * ★ 三件事必须**可见**：识别出什么 / 没识别出来 / 已显式跳过。
 * 少显示任何一种都等于"静默"，是本项目反复踩的那一类失败。
 */
export default function ImageWall(props: Partial<ImageWallProps>) {
  const items = props.items ?? [];
  const unresolvedCount = props.unresolvedCount ?? 0;
  const identifiedCount = items.filter((item) => (item.identifiedName ?? '').length > 0).length;
  const skippedCount = items.filter((item) => item.skipped).length;

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent-strong)]">
          图片 {items.length} 张
        </span>
        <span className="text-xs text-[var(--color-text-strong)]">{props.title ?? '本轮图片'}</span>
        {identifiedCount > 0 ? (
          <span className="text-[11px] text-emerald-700">已识别 {identifiedCount}</span>
        ) : null}
        {unresolvedCount > 0 ? (
          <span className="text-[11px] text-amber-700">未识别 {unresolvedCount}</span>
        ) : null}
        {skippedCount > 0 ? (
          <span className="text-[11px] text-[var(--color-text-secondary)]">
            已跳过 {skippedCount}
          </span>
        ) : null}
      </div>

      <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
        {items.map((item) => (
          <li
            key={item.assetId || item.name}
            className="relative rounded-[var(--radius-control)] bg-[var(--color-surface)] px-1.5 py-1 text-[10px]"
          >
            <div className="truncate text-[var(--color-text-strong)]">
              {item.name || '未命名'}
            </div>
            <div className="truncate text-[var(--color-text-weak)]">
              {item.identifiedName ?? '未识别'}
            </div>
            {item.skipped ? (
              <span className="absolute right-1 top-1 rounded bg-[var(--color-fill-strong)] px-1 text-[9px] text-[var(--color-text-secondary)]">
                已跳过
              </span>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-[11px] text-[var(--color-text-weak)]">还没有图片</li>
        ) : null}
      </ul>

      {props.note ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{props.note}</p>
      ) : null}
    </div>
  );
}

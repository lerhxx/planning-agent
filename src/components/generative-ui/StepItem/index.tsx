'use client';

import type { StepItemProps } from './schema';

/**
 * 状态徽章配色：明亮主题下统一用浅底 + 深字，保证白底上可读。
 * 语义色（执行中 / 已完成 / 失败）保留原色相，但把字色压深到 600-700 档。
 */
const STATUS_META: Record<
  StepItemProps['status'],
  { label: string; className: string }
> = {
  pending: {
    label: '待执行',
    className: 'bg-[var(--color-fill-strong)] text-[var(--color-text-secondary)]',
  },
  ready: {
    label: '就绪',
    className: 'bg-[var(--color-accent-mist)] text-[var(--color-accent-strong)]',
  },
  running: { label: '执行中', className: 'bg-amber-500/15 text-amber-700 animate-pulse' },
  done: { label: '已完成', className: 'bg-emerald-500/15 text-emerald-700' },
  failed: { label: '失败', className: 'bg-rose-500/15 text-rose-700' },
  skipped: {
    label: '已跳过',
    className: 'bg-[var(--color-fill-soft)] text-[var(--color-text-weak)]',
  },
  cancelled: {
    label: '已取消',
    className: 'bg-[var(--color-fill-soft)] text-[var(--color-text-weak)]',
  },
  awaiting_user: {
    label: '等你决定',
    className: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]',
  },
};

/**
 * 单个步骤卡片（内核通用组件）。
 * props 全程可缺失：标题缺失时渲染骨架行，绝不抛错。
 */
export default function StepItem(props: Partial<StepItemProps>) {
  const status = props.status ?? 'pending';
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  const attemptText =
    (props.attempt ?? 0) > 1 ? ` · 第 ${props.attempt} 次尝试` : '';

  return (
    <div className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="w-6 shrink-0 text-xs text-[var(--color-text-weak)]">
          #{props.order !== undefined ? props.order + 1 : '-'}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] leading-4 ${meta.className}`}>
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-strong)]">
          {props.title ?? <span className="text-[var(--color-text-weak)]">步骤生成中…</span>}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--color-text-weak)]">{props.id ?? ''}</span>
      </div>
      {(props.description ?? '').length > 0 && (
        <p className="mt-1 pl-8 text-xs text-[var(--color-text-secondary)]">
          {props.description}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2 pl-8 text-[11px] text-[var(--color-text-weak)]">
        {props.type ? <span>类型 {props.type}</span> : null}
        {props.parallelGroup ? <span>并行组 {props.parallelGroup}</span> : null}
        {(props.dependsOn ?? []).length > 0 ? (
          <span>依赖 {props.dependsOn?.join(' / ')}</span>
        ) : null}
        {(props.durationMs ?? 0) > 0 ? <span>{props.durationMs}ms</span> : null}
        {attemptText ? <span>{attemptText}</span> : null}
        {props.errorMessage ? (
          <span className="text-[var(--color-danger)]">{props.errorMessage}</span>
        ) : null}
      </div>
    </div>
  );
}

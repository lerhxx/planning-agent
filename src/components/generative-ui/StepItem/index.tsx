'use client';

import type { StepItemProps } from './schema';

const STATUS_META: Record<
  StepItemProps['status'],
  { label: string; className: string }
> = {
  pending: { label: '待执行', className: 'bg-slate-700/60 text-slate-300' },
  ready: { label: '就绪', className: 'bg-sky-500/20 text-sky-300' },
  running: { label: '执行中', className: 'bg-amber-500/20 text-amber-300 animate-pulse' },
  done: { label: '已完成', className: 'bg-emerald-500/20 text-emerald-300' },
  failed: { label: '失败', className: 'bg-rose-500/20 text-rose-300' },
  skipped: { label: '已跳过', className: 'bg-slate-700/60 text-slate-400' },
  cancelled: { label: '已取消', className: 'bg-slate-700/60 text-slate-400' },
  awaiting_user: { label: '等你决定', className: 'bg-violet-500/20 text-violet-300' },
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
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="w-6 shrink-0 text-xs text-slate-500">
          #{props.order !== undefined ? props.order + 1 : '-'}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] leading-4 ${meta.className}`}>
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-100">
          {props.title ?? <span className="text-slate-500">步骤生成中…</span>}
        </span>
        <span className="shrink-0 text-[11px] text-slate-500">{props.id ?? ''}</span>
      </div>
      {(props.description ?? '').length > 0 && (
        <p className="mt-1 pl-8 text-xs text-slate-400">{props.description}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2 pl-8 text-[11px] text-slate-500">
        {props.type ? <span>类型 {props.type}</span> : null}
        {props.parallelGroup ? <span>并行组 {props.parallelGroup}</span> : null}
        {(props.dependsOn ?? []).length > 0 ? (
          <span>依赖 {props.dependsOn?.join(' / ')}</span>
        ) : null}
        {(props.durationMs ?? 0) > 0 ? <span>{props.durationMs}ms</span> : null}
        {attemptText ? <span>{attemptText}</span> : null}
        {props.errorMessage ? (
          <span className="text-rose-400">{props.errorMessage}</span>
        ) : null}
      </div>
    </div>
  );
}

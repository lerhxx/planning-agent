'use client';

import type { BriefCardProps } from './schema';

/** 领域组件：汇总结论。**不展示任何未经 Provider 背书的数值。** */
export default function BriefCard(props: Partial<BriefCardProps>) {
  const bullets = props.bullets ?? [];

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)]">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700">
          结论
        </span>
        <span className="text-xs text-[var(--color-text-strong)]">{props.title ?? '汇总'}</span>
      </div>

      <p className="text-sm text-[var(--color-text-strong)]">
        {props.summary ?? '正在生成结论…'}
      </p>

      {bullets.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-[var(--color-text-secondary)]">
          {bullets.map((bullet, index) => (
            <li key={index}>· {bullet}</li>
          ))}
        </ul>
      ) : null}

      {props.disclaimer ? (
        <p className="mt-1 text-[11px] text-amber-700">{props.disclaimer}</p>
      ) : null}
    </div>
  );
}

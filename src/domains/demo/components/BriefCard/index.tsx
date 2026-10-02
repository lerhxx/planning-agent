'use client';

import type { BriefCardProps } from './schema';

/** 领域组件：汇总结论。**不展示任何未经 Provider 背书的数值。** */
export default function BriefCard(props: Partial<BriefCardProps>) {
  const bullets = props.bullets ?? [];

  return (
    <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[11px] text-emerald-300">
          结论
        </span>
        <span className="text-xs text-slate-200">{props.title ?? '汇总'}</span>
      </div>

      <p className="text-sm text-slate-100">{props.summary ?? '正在生成结论…'}</p>

      {bullets.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-slate-400">
          {bullets.map((bullet, index) => (
            <li key={index}>· {bullet}</li>
          ))}
        </ul>
      ) : null}

      {props.disclaimer ? (
        <p className="mt-1 text-[11px] text-amber-300/80">{props.disclaimer}</p>
      ) : null}
    </div>
  );
}

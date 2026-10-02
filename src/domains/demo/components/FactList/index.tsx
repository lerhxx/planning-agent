'use client';

import type { FactListProps } from './schema';

/** 领域组件：条目列表。**只展示 Provider 给的数据，不自己造数据。** */
export default function FactList(props: Partial<FactListProps>) {
  const items = props.items ?? [];

  return (
    <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[11px] text-sky-300">
          条目 {items.length}
        </span>
        <span className="text-xs text-slate-200">{props.title ?? '采集结果'}</span>
        {props.isEstimate ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300">
            估算数据
          </span>
        ) : null}
      </div>

      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between rounded bg-black/20 px-2 py-1 text-xs"
          >
            <span className="truncate text-slate-300">{item.label}</span>
            <span className="shrink-0 font-mono text-slate-100">{item.value}</span>
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-[11px] text-slate-500">还没有条目</li>
        ) : null}
      </ul>

      {(props.sourceRefs ?? []).length > 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">
          来源：
          {(props.sourceRefs ?? []).map((ref) => ref.label).join('、')}
        </p>
      ) : null}

      {props.disclaimer ? (
        <p className="mt-1 text-[11px] text-amber-300/80">{props.disclaimer}</p>
      ) : null}
    </div>
  );
}

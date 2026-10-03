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
    <div className="rounded-lg border border-amber-400/25 bg-amber-500/5 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-300">
          {props.categoryLabel ?? '候选'} {items.length}
        </span>
        <span className="text-xs text-slate-200">{props.title ?? '候选清单'}</span>
        {props.city ? <span className="text-[11px] text-slate-400">· {props.city}</span> : null}
        {props.isEstimate ? (
          <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300">
            样例数据
          </span>
        ) : null}
      </div>

      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id || item.name} className="rounded bg-black/20 px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs text-slate-100">{item.name || '未命名'}</span>
              <span className="shrink-0 font-mono text-[11px] text-amber-200">
                ¥{item.priceCNY}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
              <span>{item.categoryLabel || '候选'}</span>
              <span>评分 {item.rating.toFixed(1)}</span>
              <span>{'¥'.repeat(Math.max(1, Math.min(4, item.priceLevel)))}</span>
              {item.address ? <span className="truncate">{item.address}</span> : null}
            </div>
            {item.tags.length > 0 ? (
              <div className="mt-0.5 text-[11px] text-slate-500">{item.tags.join(' · ')}</div>
            ) : null}
            {item.source ? (
              <div className="mt-0.5 truncate text-[10px] text-slate-600">来源 {item.source}</div>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-[11px] text-slate-500">还没有候选</li>
        ) : null}
      </ul>

      {sourceRefs.length > 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">
          数据来源：{sourceRefs.map((ref) => ref.label).join('、')}
        </p>
      ) : null}
      {props.note ? <p className="mt-1 text-[11px] text-slate-400">{props.note}</p> : null}
      {props.disclaimer ? (
        <p className="mt-1 text-[11px] text-amber-300/80">{props.disclaimer}</p>
      ) : null}
    </div>
  );
}

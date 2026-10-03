'use client';

import type { VisionResultCardProps } from './schema';

/**
 * 领域组件：图片识别结果清单。
 *
 * ★ 未识别与已跳过**都列出来**（不静默丢弃），且每条已识别项都能看到 source ——
 * 认不出就说认不出，认出来了就要能溯源（红线 16）。
 */
export default function VisionResultCard(props: Partial<VisionResultCardProps>) {
  const items = props.items ?? [];
  const unresolved = props.unresolvedAssetIds ?? [];
  const skipped = props.skippedAssetIds ?? [];

  return (
    <div className="rounded-lg border border-sky-400/25 bg-sky-500/5 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[11px] text-sky-300">
          识别结果 {items.length} 条
        </span>
        <span className="text-xs text-slate-200">{props.title ?? '图片识别'}</span>
        {props.isEstimate ? (
          <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300">
            样例数据
          </span>
        ) : null}
      </div>

      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.assetId || item.name} className="rounded bg-black/20 px-2 py-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs text-slate-100">
                {item.name || '未命名'} → {item.identifiedName ?? '未识别'}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-sky-200">
                {Math.round(item.confidence * 100)}%
              </span>
            </div>
            {item.source ? (
              <div className="mt-0.5 truncate text-[10px] text-slate-600">来源 {item.source}</div>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-[11px] text-slate-500">还没有识别结果</li>
        ) : null}
      </ul>

      {unresolved.length > 0 ? (
        <p className="mt-1 text-[11px] text-amber-300">未识别 {unresolved.length} 张</p>
      ) : null}
      {skipped.length > 0 ? (
        <p className="mt-1 text-[11px] text-slate-400">已跳过 {skipped.length} 张</p>
      ) : null}
      {props.note ? <p className="mt-1 text-[11px] text-slate-400">{props.note}</p> : null}
      {props.disclaimer ? (
        <p className="mt-1 text-[11px] text-amber-300/80">{props.disclaimer}</p>
      ) : null}
    </div>
  );
}

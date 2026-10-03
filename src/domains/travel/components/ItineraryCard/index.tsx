'use client';

import type { ItineraryCardProps } from './schema';

/**
 * 领域组件：按天的行程。
 *
 * ★ 总价与每日明细都来自编排步骤的返回，组件不做任何"看起来合理"的补算。
 */
export default function ItineraryCard(props: Partial<ItineraryCardProps>) {
  const days = props.days ?? [];
  const sourceRefs = props.sourceRefs ?? [];
  const budgetCNY = props.budgetCNY ?? null;
  const overBudget = props.overBudget === true;

  return (
    <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[11px] text-emerald-300">
          行程 {days.length} 天
        </span>
        <span className="text-xs text-slate-200">{props.title ?? '每日行程'}</span>
        {props.city ? <span className="text-[11px] text-slate-400">· {props.city}</span> : null}
        {props.isEstimate ? (
          <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300">
            样例数据
          </span>
        ) : null}
      </div>

      <ol className="space-y-2">
        {days.map((day) => (
          <li key={day.day} className="rounded bg-black/20 px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-slate-100">{day.theme || `第 ${day.day} 天`}</span>
              <span className="shrink-0 font-mono text-[11px] text-emerald-200">
                ¥{day.costCNY}
              </span>
            </div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
              {day.items.map((item, index) => (
                <li key={`${item.name}-${index}`}>
                  · {item.slot} ｜ {item.name}（{item.categoryLabel}）¥{item.priceCNY}
                </li>
              ))}
              {day.items.length === 0 ? <li>· 暂无安排</li> : null}
              {day.stayName ? <li>· 住宿：{day.stayName}（¥{day.stayPriceCNY}）</li> : null}
            </ul>
          </li>
        ))}
        {days.length === 0 ? (
          <li className="text-[11px] text-slate-500">行程还没生成</li>
        ) : null}
      </ol>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 pt-2 text-[11px]">
        <span className="text-slate-300">总计 ¥{props.totalCostCNY ?? 0}</span>
        {budgetCNY !== null ? (
          <span className={overBudget ? 'text-rose-300' : 'text-emerald-300'}>
            预算 ¥{budgetCNY}
            {overBudget ? ' · 已超预算' : ' · 在预算内'}
          </span>
        ) : (
          <span className="text-slate-500">未设定预算</span>
        )}
      </div>

      {sourceRefs.length > 0 ? (
        <p className="mt-1 text-[11px] text-slate-500">
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

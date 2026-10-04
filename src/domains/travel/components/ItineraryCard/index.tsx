'use client';

import type { ItineraryCardProps } from './schema';
import type { MdBlock, MdSpan } from '@/src/domains/travel/markdown';

/**
 * 领域组件：按天的行程（v2）。
 *
 * ★ 三条纪律：
 * 1. 总价与每日明细都来自编排步骤的返回，组件不做任何"看起来合理"的补算；
 * 2. `origin` 角标必须可见 —— "来自图片"与"推荐填充"不区分，用户就无法判断哪条是自己给的；
 * 3. `summaryBlocks` 是**已解析**的 markdown blocks：组件**只渲染块，不解析 markdown**，
 *    也**绝不**用 `dangerouslySetInnerHTML`。
 */

function renderSpans(spans: readonly MdSpan[], keyPrefix: string) {
  return spans.map((span, index) => {
    const key = `${keyPrefix}-${index}`;
    if (span.code) {
      return (
        <code
          key={key}
          className="rounded bg-[var(--color-fill-soft)] px-1 font-mono text-[10px] text-[var(--color-text-strong)]"
        >
          {span.text}
        </code>
      );
    }
    if (span.href) {
      return (
        <a key={key} href={span.href} className="underline" rel="noreferrer noopener">
          {span.text}
        </a>
      );
    }
    if (span.bold) {
      return (
        <strong key={key} className="font-semibold text-[var(--color-text-strong)]">
          {span.text}
        </strong>
      );
    }
    return <span key={key}>{span.text}</span>;
  });
}

function renderBlock(block: MdBlock, keyPrefix: string) {
  const key = `${keyPrefix}-${block.kind}`;
  switch (block.kind) {
    case 'heading':
      return (
        <p key={key} className="text-[11px] font-semibold text-[var(--color-text-strong)]">
          {renderSpans(block.spans, key)}
        </p>
      );
    case 'list':
      return (
        <ul key={key} className="list-inside text-[11px] text-[var(--color-text-secondary)]">
          {block.items.map((item, index) => (
            <li key={`${key}-${index}`}>
              {block.ordered ? `${index + 1}. ` : '· '}
              {renderSpans(item, `${key}-${index}`)}
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <p
          key={key}
          className="border-l-2 border-[var(--color-border-strong)] pl-2 text-[10px] text-[var(--color-text-weak)]"
        >
          {renderSpans(block.spans, key)}
        </p>
      );
    case 'paragraph':
    default:
      return (
        <p key={key} className="text-[11px] text-[var(--color-text-secondary)]">
          {renderSpans(block.spans, key)}
        </p>
      );
  }
}

export default function ItineraryCard(props: Partial<ItineraryCardProps>) {
  const days = props.days ?? [];
  const sourceRefs = props.sourceRefs ?? [];
  const budgetCNY = props.budgetCNY ?? null;
  const overBudget = props.overBudget === true;
  const coverage = props.coverage;

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700">
          行程 {days.length} 天
        </span>
        <span className="text-xs text-[var(--color-text-strong)]">
          {props.title ?? '每日行程'}
        </span>
        {props.city ? (
          <span className="text-[11px] text-[var(--color-text-secondary)]">· {props.city}</span>
        ) : null}
        {props.isEstimate ? (
          <span className="rounded bg-[var(--color-fill-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
            样例数据
          </span>
        ) : null}
        {/* ★ 覆盖度徽标：漏排必须在卡片上看得见（violations 通道用户看不到） */}
        {coverage && coverage.total > 0 ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              coverage.missingAssetIds.length > 0
                ? 'bg-rose-500/15 text-rose-700'
                : 'bg-emerald-500/15 text-emerald-700'
            }`}
          >
            图片覆盖 {coverage.covered}/{coverage.total}
            {coverage.skippedAssetIds.length > 0 ? ` · 跳过 ${coverage.skippedAssetIds.length}` : ''}
          </span>
        ) : null}
      </div>

      <ol className="space-y-2">
        {days.map((day) => (
          <li
            key={day.day}
            className="rounded-[var(--radius-control)] bg-[var(--color-surface)] px-2 py-1.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-[var(--color-text-strong)]">
                {day.theme || `第 ${day.day} 天`}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-emerald-700">
                ¥{day.costCNY}
              </span>
            </div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-[var(--color-text-secondary)]">
              {day.items.map((item, index) => (
                <li key={`${item.name}-${index}`}>
                  · {item.slot} ｜ {item.name}（{item.categoryLabel}）¥{item.priceCNY}
                  {/* ★ origin 角标：意图溯源必须可见 */}
                  <span
                    className={`ml-1 rounded px-1 text-[10px] ${
                      item.origin === 'image'
                        ? 'bg-emerald-500/15 text-emerald-700'
                        : 'bg-[var(--color-fill-soft)] text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {item.origin === 'image' ? '来自图片' : '推荐填充'}
                  </span>
                </li>
              ))}
              {day.items.length === 0 ? <li>· 暂无安排</li> : null}
              {day.stayName ? <li>· 住宿：{day.stayName}（¥{day.stayPriceCNY}）</li> : null}
            </ul>
            {day.notes.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-[10px] text-[var(--color-text-weak)]">
                {day.notes.map((note, index) => (
                  <li key={`${day.day}-note-${index}`}>· {note.text}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
        {days.length === 0 ? (
          <li className="text-[11px] text-[var(--color-text-weak)]">行程还没生成</li>
        ) : null}
      </ol>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-divider)] pt-2 text-[11px]">
        <span className="text-[var(--color-text-strong)]">总计 ¥{props.totalCostCNY ?? 0}</span>
        {budgetCNY !== null ? (
          <span className={overBudget ? 'text-[var(--color-danger)]' : 'text-emerald-700'}>
            预算 ¥{budgetCNY}
            {overBudget ? ' · 已超预算' : ' · 在预算内'}
          </span>
        ) : (
          <span className="text-[var(--color-text-weak)]">未设定预算</span>
        )}
        {coverage && coverage.fillCount > 0 ? (
          <span className="text-[var(--color-text-weak)]">
            填充占比 {Math.round(coverage.fillRatio * 100)}%
          </span>
        ) : null}
      </div>

      {/* markdown 渲染：组件只渲染 blocks，不解析 markdown，也不用 dangerouslySetInnerHTML */}
      {props.summaryBlocks && props.summaryBlocks.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-[var(--color-divider)] pt-2">
          {props.summaryBlocks.map((block, index) => renderBlock(block, `md-${index}`))}
        </div>
      ) : null}

      {sourceRefs.length > 0 ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-weak)]">
          数据来源：{sourceRefs.map((ref) => ref.label).join('、')}
        </p>
      ) : null}
      {props.note ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{props.note}</p>
      ) : null}
      {props.disclaimer ? (
        <p className="mt-1 text-[11px] text-amber-700">{props.disclaimer}</p>
      ) : null}
    </div>
  );
}

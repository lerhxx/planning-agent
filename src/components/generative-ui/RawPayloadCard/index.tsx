'use client';

import type { RawPayloadCardProps } from './schema';

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** 兜底组件 1/3：原始载荷。任何无法渲染的内容最终都会落到这里。 */
export default function RawPayloadCard(props: Partial<RawPayloadCardProps>) {
  return (
    <div className="rounded-[var(--radius-card)] border border-amber-200 bg-amber-50 p-3 shadow-[var(--shadow-card)]">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700">
          原始载荷
        </span>
        <span className="text-xs text-[var(--color-text-strong)]">
          {props.title ?? '渲染降级'}
        </span>
      </div>
      {props.reason ? <p className="mb-2 text-[11px] text-amber-700">{props.reason}</p> : null}
      <pre className="max-h-64 overflow-auto rounded-[var(--radius-control)] bg-[var(--color-fill-soft)] p-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
        {safeStringify(props.payload)}
      </pre>
      {props.traceId ? (
        <p className="mt-1 text-[11px] text-[var(--color-text-weak)]">traceId {props.traceId}</p>
      ) : null}
    </div>
  );
}

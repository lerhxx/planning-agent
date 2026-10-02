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
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-300">
          原始载荷
        </span>
        <span className="text-xs text-slate-300">{props.title ?? '渲染降级'}</span>
      </div>
      {props.reason ? <p className="mb-2 text-[11px] text-amber-300/80">{props.reason}</p> : null}
      <pre className="max-h-64 overflow-auto rounded bg-black/30 p-2 text-[11px] leading-5 text-slate-300">
        {safeStringify(props.payload)}
      </pre>
      {props.traceId ? (
        <p className="mt-1 text-[11px] text-slate-500">traceId {props.traceId}</p>
      ) : null}
    </div>
  );
}

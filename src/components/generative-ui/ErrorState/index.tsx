'use client';

import type { ErrorStateProps } from './schema';

/** 兜底组件 3/3：错误态。**兜底链的最后一环，必须永远能渲染。** */
export default function ErrorState(props: Partial<ErrorStateProps>) {
  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[11px] text-rose-300">
          出错
        </span>
        <span className="text-sm text-slate-200">{props.title ?? '这一步没能完成'}</span>
      </div>
      {props.message ? <p className="text-xs text-slate-400">{props.message}</p> : null}
      <p className="mt-2 text-[11px] text-slate-500">
        {props.recoverable ?? true ? '可以调整目标后重试' : '不可恢复'}
        {props.traceId ? ` · traceId ${props.traceId}` : ''}
      </p>
    </div>
  );
}

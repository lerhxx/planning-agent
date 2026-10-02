'use client';

import type { ComponentAction, ClarifyOptionsProps } from './schema';

/** 兜底组件 2/3：澄清点选。交互通过 `onAction` 回灌，组件内不发请求。 */
export default function ClarifyOptions(
  props: Partial<ClarifyOptionsProps> & {
    onAction?: (action: ComponentAction) => void;
  },
) {
  const options = props.options ?? [];

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[11px] text-violet-300">
          需要你决定
        </span>
      </div>
      <p className="mb-3 text-sm text-slate-200">{props.prompt ?? '请选择一种继续方式'}</p>
      <div className="flex flex-wrap gap-2">
        {options.length === 0 ? (
          <span className="text-[11px] text-slate-500">暂无候选项</span>
        ) : (
          options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() =>
                props.onAction?.({
                  type: 'select_option',
                  questionId: props.questionId,
                  optionId: option.id,
                })
              }
              className="rounded-md border border-violet-400/40 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-200 transition hover:bg-violet-500/20"
            >
              {option.label}
            </button>
          ))
        )}
      </div>
      {props.traceId ? (
        <p className="mt-2 text-[11px] text-slate-500">traceId {props.traceId}</p>
      ) : null}
    </div>
  );
}

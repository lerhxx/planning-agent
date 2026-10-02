'use client';

import type { ReactNode } from 'react';
import StepItem from '../StepItem';
import type { StepItemProps } from '../StepItem/schema';
import type { PlanViewProps } from './schema';

const PLAN_STATUS_LABEL: Record<PlanViewProps['status'], string> = {
  draft: '草稿',
  approved: '已确认',
  running: '执行中',
  paused: '已暂停',
  replanning: '重规划中',
  completed: '已完成',
  failed: '失败',
  aborted: '已放弃',
};

/**
 * 计划总览（内核通用组件）。
 *
 * `renderStepExtra` 用于在每一步下方挂载该步产出的生成式 UI 节点 ——
 * 内核只持 `emittedNodeIds`，**不解析节点 props**（PRD §6.1）。
 */
export default function PlanView(
  props: Partial<PlanViewProps> & {
    renderStepExtra?: (stepId: string) => ReactNode;
  },
) {
  const steps: StepItemProps[] = props.steps ?? [];
  const done = steps.filter((step) => step.status === 'done').length;
  const progress = steps.length === 0 ? 0 : Math.round((done / steps.length) * 100);

  return (
    <section className="rounded-xl border border-white/10 bg-slate-900/40 p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-slate-200">计划</h2>
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-slate-300">
          {PLAN_STATUS_LABEL[props.status ?? 'draft']}
        </span>
        <span className="text-[11px] text-slate-500">rev {props.revision ?? 1}</span>
        <span className="ml-auto text-[11px] text-slate-400">
          {done}/{steps.length} 步 · {progress}%
        </span>
      </header>

      <div className="mb-3 h-1 w-full overflow-hidden rounded bg-white/10">
        <div
          className="h-full rounded bg-gradient-to-r from-sky-400 to-violet-400 transition-[width] duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {props.summary ? (
        <p className="mb-3 text-xs text-slate-400">{props.summary}</p>
      ) : null}

      <ol className="space-y-2">
        {steps.map((step) => (
          <li key={step.id}>
            <StepItem {...step} />
            {props.renderStepExtra ? (
              <div className="mt-1 pl-8">{props.renderStepExtra(step.id)}</div>
            ) : null}
          </li>
        ))}
      </ol>

      {steps.length === 0 ? (
        <p className="text-xs text-slate-500">还没有步骤，输入目标后开始。</p>
      ) : null}
    </section>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useRun, type StartInput } from '@/src/features/run/useRun';
import ComponentRenderer from '@/src/components/generative-ui/ComponentRenderer';
import PlanView from '@/src/components/generative-ui/PlanView';
import type { PlanViewProps } from '@/src/components/generative-ui/PlanView/schema';
import type { StepItemProps } from '@/src/components/generative-ui/StepItem/schema';
import type { ComponentAction } from '@/src/components/generative-ui/ClarifyOptions/schema';
// 领域包的**客户端唯一引用点**：桶文件，新增领域只改 src/domains/ui.ts。
// 注意：这里只注册**组件**（registerAllUI），刻意不注册领域 pack ——
// 否则领域 providers/tools 会被拖进客户端 bundle。代价是前端只能用
// CORE_DEGRADE_CHAIN（领域自定义降级链是服务端概念）。
import { defaultDomainId, registerAllUI } from '@/src/domains/ui';

// 前端启动即注册：内核通用兜底组件 + Demo 领域组件的懒加载入口。
registerAllUI();

const DEFAULT_GOAL =
  '帮我把这件事拆成计划并一步步执行：两路采集后汇总成一版结论，预算不超过 500 元，三天内完成';

const SIMULATE_OPTIONS: Array<{ value: NonNullable<StartInput['simulate']>; label: string }> = [
  { value: 'none', label: '正常执行（一次成功）' },
  { value: 'retryable', label: '注入可重试失败（演示 retry-step）' },
  { value: 'fatal', label: '注入不可恢复失败（演示重规划）' },
  { value: 'clarify', label: '注入信息不足（演示澄清）' },
];

/** 重排模拟：用来现场对比「换方案 → 跑完」与「原地打转 → NO_CONVERGENCE 闸门」。 */
const REPLAN_OPTIONS: Array<{ value: NonNullable<StartInput['replanMode']>; label: string }> = [
  { value: 'diverge', label: '重排时换方案（默认）' },
  { value: 'stagnant', label: '重排时原地打转（演示 NO_CONVERGENCE）' },
];

/** 可以编辑/续跑的终态（PRD §6.3：编辑只在终态生效）。 */
const EDITABLE_PHASES = new Set(['paused', 'failed', 'awaiting_user', 'aborted']);

export default function Page() {
  const { state, start, abort, reset } = useRun();
  const [goal, setGoal] = useState<string>(DEFAULT_GOAL);
  const [simulate, setSimulate] = useState<NonNullable<StartInput['simulate']>>('none');
  const [replanMode, setReplanMode] = useState<NonNullable<StartInput['replanMode']>>('diverge');
  const [requireConstraints, setRequireConstraints] = useState<boolean>(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [editStepId, setEditStepId] = useState<string>('');
  const [editTitle, setEditTitle] = useState<string>('');

  const running = state.phase === 'streaming';
  const editable = EDITABLE_PHASES.has(state.phase) && state.plan !== null;

  /**
   * 编辑后继续：**先编辑、再原路重发**（与澄清同一模式）。
   * `plan` 快照 + `edit` 命令一起回传，服务端会重新校验 plan 并归一状态。
   */
  const resume = (edit: StartInput['edit']): void => {
    if (!state.plan) return;
    void start({
      goal,
      simulate: 'none',
      replanMode,
      requireConstraints,
      answers,
      plan: state.plan,
      edit: edit ?? null,
    });
  };

  const planProps: Partial<PlanViewProps> = useMemo(() => {
    if (!state.plan) return { steps: [], status: 'draft', revision: 1 };
    const steps: StepItemProps[] = state.plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      type: step.type,
      status: step.status,
      order: step.order,
      attempt: step.attempt,
      maxAttempts: step.maxAttempts,
      durationMs: step.result?.durationMs ?? 0,
      dependsOn: step.dependsOn,
      parallelGroup: step.parallelGroup,
      errorMessage: step.error?.message,
    }));
    return {
      planId: state.plan.id,
      status: state.plan.status,
      revision: state.plan.revision,
      summary: state.plan.summary,
      steps,
      totalDurationMs: steps.reduce((sum, step) => sum + step.durationMs, 0),
    };
  }, [state.plan]);

  const nodesFor = (stepId: string) =>
    state.nodes.filter((node) => node.stepId === stepId);

  const floatingNodes = state.nodes.filter((node) => !node.stepId);

  const onAction = (action: ComponentAction): void => {
    if (action.type !== 'select_option' || !action.questionId || !action.optionId) return;
    const next = { ...answers, [action.questionId]: action.optionId };
    setAnswers(next);
    void start({ goal, simulate, replanMode, requireConstraints, answers: next });
  };

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-slate-100">planning-agent</h1>
        <p className="mt-1 text-sm text-slate-400">
          目标驱动的规划型 Agent 基座 · M1：目标 → 计划 → 执行 → 重规划
        </p>
        <p className="mt-1 text-xs text-slate-500">
          内核领域无关 · MockRuntime 零网络零 API Key · 领域通过 Domain Pack 接入
        </p>
      </header>

      <section className="mb-5 rounded-xl border border-white/10 bg-slate-900/40 p-4">
        <label className="mb-2 block text-xs text-slate-400" htmlFor="goal">
          目标
        </label>
        <textarea
          id="goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          className="w-full rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-slate-100 outline-none focus:border-sky-400/50"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            value={simulate}
            onChange={(event) =>
              setSimulate(event.target.value as NonNullable<StartInput['simulate']>)
            }
            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-slate-200"
          >
            {SIMULATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select
            value={replanMode}
            onChange={(event) =>
              setReplanMode(event.target.value as NonNullable<StartInput['replanMode']>)
            }
            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-slate-200"
          >
            {REPLAN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={requireConstraints}
              onChange={(event) => setRequireConstraints(event.target.checked)}
            />
            信息不足（演示澄清）
          </label>

          <button
            type="button"
            disabled={running || goal.trim().length === 0}
            onClick={() => void start({ goal, simulate, replanMode, requireConstraints, answers })}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-slate-950 transition hover:bg-sky-400 disabled:opacity-40"
          >
            {running ? '执行中…' : '开始'}
          </button>

          <button
            type="button"
            disabled={!running}
            onClick={abort}
            className="rounded-lg border border-rose-400/40 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-40"
          >
            中断
          </button>

          <button
            type="button"
            onClick={() => {
              reset();
              setAnswers({});
            }}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/5"
          >
            清空
          </button>
        </div>
      </section>

      {editable ? (
        <section className="mb-5 rounded-xl border border-amber-400/25 bg-amber-500/5 p-4">
          <h2 className="mb-1 text-sm font-medium text-amber-200">编辑计划后继续</h2>
          <p className="mb-3 text-xs text-slate-400">
            已完成步骤默认冻结：要改它得先「重试」解冻。编辑只在终态生效，回传后服务端会重新校验。
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={editStepId}
              onChange={(event) => setEditStepId(event.target.value)}
              className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-slate-200"
            >
              <option value="">选择步骤…</option>
              {state.plan?.steps.map((step) => (
                <option key={step.id} value={step.id}>
                  {step.order + 1}. {step.title}（{step.status}）
                </option>
              ))}
            </select>

            <input
              value={editTitle}
              onChange={(event) => setEditTitle(event.target.value)}
              placeholder="新标题"
              className="w-48 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-slate-100"
            />

            <button
              type="button"
              disabled={!editStepId || editTitle.trim().length === 0}
              onClick={() =>
                resume({
                  kind: 'editStep',
                  stepId: editStepId,
                  patch: { title: editTitle.trim() },
                })
              }
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/5 disabled:opacity-40"
            >
              改标题
            </button>

            <button
              type="button"
              disabled={!editStepId}
              onClick={() => resume({ kind: 'retryStep', stepId: editStepId })}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/5 disabled:opacity-40"
            >
              重试这一步
            </button>

            <button
              type="button"
              disabled={!editStepId}
              onClick={() => resume({ kind: 'skipStep', stepId: editStepId })}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/5 disabled:opacity-40"
            >
              跳过这一步
            </button>

            <button
              type="button"
              onClick={() => resume(null)}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-slate-950 transition hover:bg-emerald-400"
            >
              原样继续
            </button>
          </div>
        </section>
      ) : null}

      <div className="space-y-4">
        <PlanView
          {...planProps}
          renderStepExtra={(stepId) => (
            <div className="space-y-2">
              {nodesFor(stepId).map((node) => (
                <ComponentRenderer
                  key={node.nodeId}
                  node={node}
                  domainId={defaultDomainId}
                  onAction={onAction}
                />
              ))}
            </div>
          )}
        />

        {floatingNodes.length > 0 ? (
          <section className="space-y-2">
            {floatingNodes.map((node) => (
              <ComponentRenderer
                key={node.nodeId}
                node={node}
                domainId={defaultDomainId}
                onAction={onAction}
              />
            ))}
          </section>
        ) : null}
      </div>

      <footer className="mt-6 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <span>
          阶段 <span className="text-slate-300">{state.phase}</span>
        </span>
        <span>事件 {state.eventCount}</span>
        {state.traceId ? <span>traceId {state.traceId}</span> : null}
        {state.message ? <span className="text-amber-300/90">{state.message}</span> : null}
      </footer>
    </main>
  );
}

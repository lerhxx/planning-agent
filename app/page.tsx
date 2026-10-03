'use client';

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { makeFormKey } from '@/shared/plan/types';
import { useRun, type StartInput } from '@/src/features/run/useRun';
import { useAttachments } from '@/src/features/attachment/useAttachments';
import ComponentRenderer from '@/src/components/generative-ui/ComponentRenderer';
import PlanView from '@/src/components/generative-ui/PlanView';
import type { PlanViewProps } from '@/src/components/generative-ui/PlanView/schema';
import type { StepItemProps } from '@/src/components/generative-ui/StepItem/schema';
import type { ComponentAction } from '@/src/components/generative-ui/ClarifyOptions/schema';
// 领域包的**客户端唯一引用点**：桶文件，新增领域只改 src/domains/ui.ts。
// 注意：这里只注册**组件**（registerAllUI），刻意不注册领域 pack ——
// 否则领域 providers/tools 会被拖进客户端 bundle。代价是前端只能用
// CORE_DEGRADE_CHAIN（领域自定义降级链是服务端概念）。
import { defaultDomainId, domainOptions, registerAllUI } from '@/src/domains/ui';

// 前端启动即注册：内核通用兜底组件 + Demo 领域组件的懒加载入口。
registerAllUI();

/**
 * 示例目标随领域给出，定义在 `src/domains/ui.ts`（领域/客户端桶文件）——
 * 生产代码对领域的引用点仍然只有 `index.ts`（服务端）与 `ui.ts`（客户端）两个。
 */
const { sampleGoal: DEFAULT_GOAL } = domainOptions[0]!;

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
  const attachments = useAttachments();
  const [goal, setGoal] = useState<string>(DEFAULT_GOAL);
  const [domainId, setDomainId] = useState<string>(defaultDomainId);
  const [simulate, setSimulate] = useState<NonNullable<StartInput['simulate']>>('none');
  const [replanMode, setReplanMode] = useState<NonNullable<StartInput['replanMode']>>('diverge');
  const [requireConstraints, setRequireConstraints] = useState<boolean>(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [editStepId, setEditStepId] = useState<string>('');
  const [editTitle, setEditTitle] = useState<string>('');
  const [dragOver, setDragOver] = useState<boolean>(false);
  /** `@` 联想：`null` = 当前不在提及上下文。 */
  const [mention, setMention] = useState<string | null>(null);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const running = state.phase === 'streaming';
  const editable = EDITABLE_PHASES.has(state.phase) && state.plan !== null;

  /** 发起一轮：附件**只透传**描述符，不做任何解析。 */
  const launch = (overrides: Partial<StartInput> = {}): void => {
    void start({
      goal,
      domainId,
      simulate,
      replanMode,
      requireConstraints,
      answers,
      attachments: attachments.attachments,
      ...overrides,
    });
  };

  /**
   * 编辑后继续：**先编辑、再原路重发**（与澄清同一模式）。
   * `plan` 快照 + `edit` 命令一起回传，服务端会重新校验 plan 并归一状态。
   */
  const resume = (edit: StartInput['edit']): void => {
    if (!state.plan) return;
    launch({
      simulate: 'none',
      plan: state.plan,
      edit: edit ?? null,
    });
  };

  /**
   * 组件动作回灌。
   *
   * ★ 表单模式**一次提交**：`values` 用 `makeFormKey(qid, fid)` 摊平进 `answers`；
   * 并**必须**带 `plan` 快照 + `retryStep` —— `awaiting_user` 是终态，
   * 不解冻就永远不会被重新调度（看起来像"填完了但没反应"）。
   */
  const onAction = (action: ComponentAction, stepId?: string): void => {
    if (action.type === 'submit_form') {
      if (!action.questionId || !action.values) return;
      const next: Record<string, string> = { ...answers };
      for (const [fieldId, value] of Object.entries(action.values)) {
        next[makeFormKey(action.questionId, fieldId)] = value;
      }
      setAnswers(next);
      launch({
        simulate: 'none',
        answers: next,
        plan: state.plan,
        edit: stepId ? { kind: 'retryStep', stepId } : null,
      });
      return;
    }
    if (action.type !== 'select_option' || !action.questionId || !action.optionId) return;
    const next = { ...answers, [action.questionId]: action.optionId };
    setAnswers(next);
    launch({
      simulate: 'none',
      answers: next,
      plan: state.plan,
      edit: stepId ? { kind: 'retryStep', stepId } : null,
    });
  };

  // 渲染时用的领域：跟随服务端下发的 plan.domainId，未开跑时用下拉框选的领域。
  const renderDomainId = state.plan?.domainId ?? domainId;

  // 切换领域时顺带换成该领域的示例目标（示例文案由领域桶文件给出）。
  const switchDomain = (next: string): void => {
    setDomainId(next);
    setGoal(domainOptions.find((option) => option.id === next)?.sampleGoal ?? DEFAULT_GOAL);
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

  const stepNodes = (stepId: string) => state.nodes.filter((node) => node.stepId === stepId);
  const floatingNodes = state.nodes.filter((node) => !node.stepId);

  /* ---------------- 附件：拖拽 + 内联上传入口 ---------------- */

  const pickFiles = (list: FileList | null): File[] =>
    list === null ? [] : Array.from(list).filter((file) => file.type.startsWith('image/'));

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    setDragOver(false);
    void attachments.add(pickFiles(event.dataTransfer?.files ?? null));
  };

  /* ---------------- `@` 提及联想 ---------------- */

  const syncMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) {
      setMention(null);
      return;
    }
    const token = before.slice(at + 1);
    if (token.includes('@') || /\s/.test(token)) {
      setMention(null);
      return;
    }
    setMention(token);
  };

  const mentionCandidates =
    mention === null
      ? []
      : attachments.items
          .filter((item) => item.name.toLowerCase().includes(mention.toLowerCase()))
          .slice(0, 6);

  const insertMention = (name: string): void => {
    const element = composerRef.current;
    const caret = element?.selectionStart ?? goal.length;
    const at = goal.slice(0, caret).lastIndexOf('@');
    if (!element || at < 0) return;
    setGoal(`${goal.slice(0, at)}@${name} ${goal.slice(caret)}`);
    setMention(null);
    const nextCaret = at + name.length + 2;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
    });
  };

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col px-5 py-6">
      <header className="mb-3 shrink-0">
        <h1 className="text-base font-semibold text-slate-100">planning-agent</h1>
        <p className="mt-0.5 text-[11px] text-slate-500">
          目标驱动的规划型 Agent 基座 · 对话优先 · 领域通过 Domain Pack 接入
        </p>
      </header>

      {/* 消息区：同时是拖拽落点（不存在独立上传页 / 独立上传态）。 */}
      <section
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border p-3 transition ${
          dragOver ? 'border-sky-400/60 bg-sky-500/5' : 'border-white/10 bg-slate-900/30'
        }`}
      >
        {dragOver ? (
          <p className="text-center text-xs text-sky-300">松手即上传图片（最多 20 张，单张 ≤8MB）</p>
        ) : null}

        <PlanView
          {...planProps}
          renderStepExtra={(stepId) => (
            <div className="space-y-2">
              {stepNodes(stepId).map((node) => (
                <ComponentRenderer
                  key={node.nodeId}
                  node={node}
                  domainId={renderDomainId}
                  onAction={(action) => onAction(action, node.stepId)}
                />
              ))}
            </div>
          )}
        />

        {floatingNodes.length > 0 ? (
          <div className="space-y-2">
            {floatingNodes.map((node) => (
              <ComponentRenderer
                key={node.nodeId}
                node={node}
                domainId={renderDomainId}
                onAction={(action) => onAction(action, node.stepId)}
              />
            ))}
          </div>
        ) : null}

        {state.plan === null && state.nodes.length === 0 ? (
          <p className="pt-6 text-center text-sm text-slate-500">
            先说目标，再把图片拖进来（或直接点输入框旁的「加图」）。
            <br />
            用 <span className="text-slate-300">@图片名</span> 可以把说明关联到具体某张图。
          </p>
        ) : null}
      </section>

      {/* 输入区：上传入口内联在输入框，**没有独立上传页**。 */}
      <footer className="mt-3 shrink-0 space-y-2">
        {attachments.items.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {attachments.items.map((item) => (
              <span
                key={item.id}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                  item.status === 'error'
                    ? 'border-rose-400/50 text-rose-300'
                    : item.status === 'uploading'
                      ? 'border-white/10 text-slate-400'
                      : 'border-emerald-400/40 text-emerald-300'
                }`}
              >
                {item.name}
                {item.status === 'uploading' ? <span>上传中…</span> : null}
                <button
                  type="button"
                  onClick={() => attachments.remove(item.id)}
                  className="text-slate-500 transition hover:text-rose-300"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {attachments.error ? (
          <p className="text-[11px] text-rose-300">{attachments.error}</p>
        ) : null}

        <div className="relative">
          <textarea
            ref={composerRef}
            value={goal}
            rows={3}
            onChange={(event) => {
              setGoal(event.target.value);
              syncMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyUp={(event) =>
              syncMention(
                event.currentTarget.value,
                event.currentTarget.selectionStart ?? event.currentTarget.value.length,
              )
            }
            className="w-full rounded-lg border border-white/10 bg-black/30 p-3 pr-20 text-sm text-slate-100 outline-none focus:border-sky-400/50"
          />

          {mention !== null && mentionCandidates.length > 0 ? (
            <div className="absolute bottom-2 left-3 z-10 rounded-lg border border-white/15 bg-slate-900 p-1 shadow-lg">
              {mentionCandidates.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => insertMention(item.name)}
                  className="block w-full rounded px-2 py-1 text-left text-xs text-slate-200 transition hover:bg-white/10"
                >
                  @{item.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => {
              void attachments.add(pickFiles(event.target.files));
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-white/5"
          >
            加图
          </button>

          <button
            type="button"
            disabled={running || goal.trim().length === 0 || attachments.uploading}
            onClick={() => launch()}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-slate-950 transition hover:bg-sky-400 disabled:opacity-40"
          >
            {running ? '执行中…' : '发送'}
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
              attachments.clear();
            }}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/5"
          >
            清空
          </button>

          <span className="ml-auto text-[11px] text-slate-500">
            阶段 <span className="text-slate-300">{state.phase}</span> · 事件 {state.eventCount} · 附件{' '}
            {attachments.items.length}
            {state.traceId ? ` · ${state.traceId}` : ''}
          </span>
        </div>

        {state.message ? (
          <p className="text-[11px] text-amber-300/90">{state.message}</p>
        ) : null}
      </footer>

      {/* 调试面板：对话优先，这些旋钮收起来。 */}
      <details className="mt-3 shrink-0 rounded-xl border border-white/10 bg-slate-900/40 p-3">
        <summary className="cursor-pointer text-xs text-slate-400">调试旋钮 / 计划编辑</summary>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            value={domainId}
            onChange={(event) => switchDomain(event.target.value)}
            disabled={running}
            className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-slate-200 disabled:opacity-40"
          >
            {domainOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>

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
              disabled={attachments.items.length > 0}
              onChange={(event) => setRequireConstraints(event.target.checked)}
            />
            仅演示目标澄清（会跳过图片流程）
          </label>
        </div>

        {editable ? (
          <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
            <p className="text-xs text-slate-400">
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
          </div>
        ) : null}
      </details>
    </main>
  );
}

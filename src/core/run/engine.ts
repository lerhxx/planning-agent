/**
 * 编排引擎 —— 把「Goal → 计划 → 执行 → 重规划」串成一轮闭环（M1 验收项）。
 *
 * 领域无关：只调 `src/core/**` 的纯函数与 `RuntimeAdapter`，不认识任何领域语义。
 * 所有对 UI 的输出都通过 `emit(StreamEvent)` 下发，因此同一份内核可以接任意传输层。
 *
 * 失败路径优先：每一步都有兜底 —— 计划生成失败 / 编译失败 / 闸门拦截 / 不收敛
 * 都会落到 `ErrorState` 组件，并下发 `done(failed)`，**绝不白屏**。
 */
import {
  isTerminalStepStatus,
  makeReplanStepId,
  zPlan,
  type Attachment,
  type ClarifyQuestion,
  type EditCommand,
  type Goal,
  type Plan,
  type Step,
} from '@/shared/plan/types';
import {
  zRunContext,
  type RunContext,
  type RunTerminalStatus,
} from '@/shared/run/types';
import type { StreamEvent } from '@/shared/stream/events';
import { compilePlan } from '@/src/core/compiler/planCompiler';
import { executeStep, propsToPatches } from '@/src/core/execution/executor';
import { partitionBatch, isLiveStepStatus } from '@/src/core/execution/scheduler';
import type { Observation } from '@/src/core/execution/observer';
import { parseGoal } from '@/src/core/goal/parse';
import { applyAnswers, buildClarifyQuestions, needsClarification } from '@/src/core/goal/clarify';
import { applyEdit } from '@/src/core/planning/edit';
import { applyReplanDraft, createPlan } from '@/src/core/planning/planner';
import { highestSeverity, validatePlan, validateStep } from '@/src/core/planning/validate';
import {
  checkGates,
  DEFAULT_GATE_CONFIG,
  describeGateReason,
  evaluateReplan,
  subtreeDelta,
  type ReplanBudget,
} from '@/src/core/replan/gates';
import { collectImpact } from '@/src/core/replan/impact';
import {
  decideStrategy,
  decideValidationAction,
  describeTrigger,
  type ReplanTrigger,
} from '@/src/core/replan/policy';
import { getDomainPack, getStepTypes, getTemplates, listDomainIds } from '@/src/core/registry/domainRegistry';
import type { RuntimeAdapter } from '@/src/core/runtime/adapter';

export interface EngineInput {
  goal: string;
  domainId?: string;
  /** 故障注入：none | retryable | fatal | clarify。 */
  simulate?: string;
  requireConstraints?: boolean;
  answers?: Record<string, string>;
  /** 本轮输入附件（引用优先：只带描述符，字节由上传接口先落地）。 */
  attachments?: Attachment[];
  /** 续跑：上一次的 plan 快照（来自客户端，**不可信**）。 */
  resumePlan?: Plan | null;
  /** 续跑前要应用的编辑命令（只在 run 终态生效）。 */
  edit?: EditCommand | null;
}

export interface EngineDeps {
  runtime: RuntimeAdapter;
  emit: (event: StreamEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  /** 中断信号（来自 HTTP 请求的 AbortSignal）。 */
  signal?: { readonly aborted: boolean };
  now?: () => Date;
  streamDelayMs?: number;
}

export interface EngineResult {
  status: RunTerminalStatus;
  plan: Plan | null;
  traceId: string;
  reason?: string;
}

const NOOP_SLEEP = async (): Promise<void> => undefined;
const DEFAULT_STEP_DELAY_MS = 90;
const DEFAULT_COMPONENT_DELAY_MS = 60;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function replaceStep(plan: Plan, next: Step): Plan {
  return { ...plan, steps: plan.steps.map((step) => (step.id === next.id ? next : step)) };
}

/**
 * 续跑：把客户端回传的计划快照变回可执行的计划。
 *
 * ★ plan 来自网络 → **不可信**：先 `zPlan.safeParse`，失败即拒绝（不静默吃脏数据）。
 * ★ 编辑命令只在终态生效：已完成步骤仍然受"默认冻结"约束（红线 14 / PRD §6.3）。
 */
export function resumePlan(
  raw: Plan,
  edit: EditCommand | null | undefined,
  goal: Goal,
  runId: string,
): { ok: true; plan: Plan; cancelledIds: string[] } | { ok: false; message: string; reason: string } {
  const parsed = zPlan.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: '续跑的计划快照未通过 schema 校验', reason: 'RESUME_PLAN_INVALID' };
  }

  // 被中断的步骤（running/ready）在新一轮里重新排队。
  const normalized: Plan = {
    ...parsed.data,
    status: 'running',
    steps: parsed.data.steps.map((step) =>
      step.status === 'running' || step.status === 'ready'
        ? { ...step, status: 'pending' as const }
        : step,
    ),
  };

  if (!edit) return { ok: true, plan: normalized, cancelledIds: [] };

  const edited = applyEdit(normalized, goal, edit, { runId });
  if (!edited.ok) {
    return {
      ok: false,
      message:
        edited.reason === 'FROZEN_STEP'
          ? '已完成步骤默认冻结：请先 rollback_to_step 再改'
          : '要编辑的步骤不存在',
      reason: edited.reason,
    };
  }

  // L2 已在 applyEdit 里 +1；L1 的局部重排也算一次版本演进；L0 纯本地微调不改版本。
  const bumped: Plan =
    edited.level === 'L1' ? { ...edited.plan, revision: edited.plan.revision + 1 } : edited.plan;

  const beforeIds = new Set(normalized.steps.map((step) => step.id));
  return {
    ok: true,
    plan: bumped,
    cancelledIds: [...beforeIds].filter((id) => !bumped.steps.some((step) => step.id === id)),
  };
}

/**
 * 跑完一轮：Goal → Plan → 执行 →（必要时）重规划 → 终态。
 */
export async function runGoal(input: EngineInput, deps: EngineDeps): Promise<EngineResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? NOOP_SLEEP;
  const startedMs = now().getTime();

  const runId = makeId('run');
  const traceId = makeId('trace');
  const domainId = input.domainId ?? listDomainIds()[0] ?? '';

  /** 统一下发组件节点：start → 逐条 props 增量 → end。 */
  const emitComponent = async (options: {
    nodeId: string;
    component: string;
    props: Record<string, unknown>;
    endStatus?: 'ready' | 'degraded' | 'error';
  }): Promise<void> => {
    deps.emit({
      type: 'component_start',
      nodeId: options.nodeId,
      component: options.component,
      traceId,
    });
    for (const operation of propsToPatches(options.props)) {
      await sleep(DEFAULT_COMPONENT_DELAY_MS);
      deps.emit({ type: 'component_props_delta', nodeId: options.nodeId, patch: [operation] });
    }
    deps.emit({
      type: 'component_end',
      nodeId: options.nodeId,
      status: options.endStatus ?? 'ready',
    });
  };

  const finish = (
    status: RunTerminalStatus,
    plan: Plan | null,
    reason?: string,
  ): EngineResult => {
    deps.emit({
      type: 'done',
      traceId,
      status,
      planId: plan?.id,
      revision: plan?.revision,
      reason,
    });
    return { status, plan, traceId, reason };
  };

  const failRun = async (
    plan: Plan | null,
    message: string,
    reason: string,
  ): Promise<EngineResult> => {
    deps.emit({ type: 'error', traceId, message, recoverable: false });
    await emitComponent({
      nodeId: `node-error-${traceId}`,
      component: 'ErrorState',
      props: { title: '这一轮没能跑完', message, traceId, recoverable: true },
      endStatus: 'error',
    });
    if (plan) {
      deps.emit({
        type: 'plan_status',
        planId: plan.id,
        status: 'failed',
        revision: plan.revision,
      });
    }
    return finish('failed', plan, reason);
  };

  /* ---------------- 1. 目标解析与澄清 ---------------- */

  if (!domainId || !getDomainPack(domainId)) {
    return failRun(null, '领域包未注册', 'DOMAIN_PACK_NOT_FOUND');
  }

  const parsed = parseGoal(
    { runId, raw: input.goal, now: now() },
    { requireConstraints: input.requireConstraints ?? false },
  );
  const goal = applyAnswers(parsed.goal, input.answers ?? {});

  if (needsClarification(goal)) {
    const question = buildClarifyQuestions(goal)[0];
    if (question) {
      await emitComponent({
        nodeId: 'node-clarify',
        component: 'ClarifyOptions',
        props: {
          questionId: question.id,
          prompt: question.prompt,
          options: question.options,
          fields: question.fields,
          traceId,
        },
      });
    }
    return finish('awaiting_user', null, 'GOAL_NEEDS_CLARIFICATION');
  }

  let ctx: RunContext = zRunContext.parse({
    runId,
    traceId,
    goalId: goal.id,
    domainId,
    revision: 1,
    startedAt: now().toISOString(),
    deadlineAt: new Date(startedMs + DEFAULT_GATE_CONFIG.maxDurationMs).toISOString(),
    budgetRemainingCNY: DEFAULT_GATE_CONFIG.maxCostCNY,
    // signals 由附件种类派生（不再是写死的常量）。
    // ★ 集合语义：`'text'` 本身也是合法 kind，必须与派生结果**一起**去重，
    // 否则带一张 kind='text' 的附件会产出 ['text','text']。
    signals: [...new Set(['text', ...(input.attachments ?? []).map((a) => a.kind)])],
    attachments: input.attachments ?? [],
    meta: { simulate: input.simulate ?? 'none', answers: input.answers ?? {} },
  });

  /* ---------------- 2. 取得计划：新规划 或 续跑 ---------------- */

  let plan: Plan;

  if (input.resumePlan) {
    const resumed = resumePlan(input.resumePlan, input.edit, goal, runId);
    if (!resumed.ok) return failRun(null, resumed.message, resumed.reason);
    plan = resumed.plan;
    for (const id of resumed.cancelledIds) {
      deps.emit({
        type: 'step_status',
        planId: plan.id,
        stepId: id,
        status: 'cancelled',
        reason: 'EDIT',
      });
    }
  } else {
    const created = await createPlan({ goal, ctx, domainId }, { runtime: deps.runtime, now });
    if (!created.ok) {
      return failRun(null, created.error.message || '计划生成失败', created.error.code);
    }
    plan = created.plan;
  }

  deps.emit({
    type: 'plan_start',
    planId: plan.id,
    runId,
    goalId: goal.id,
    domainId,
    revision: plan.revision,
    status: 'draft',
    summary: plan.summary,
  });
  // 逐条长出（C0-14）：一条一条下发，不整包重发。
  for (const step of plan.steps) {
    await sleep(DEFAULT_STEP_DELAY_MS);
    deps.emit({ type: 'step_add', planId: plan.id, step });
  }
  deps.emit({ type: 'plan_status', planId: plan.id, status: 'draft', revision: plan.revision });

  const budget: ReplanBudget = {
    replanCount: 0,
    costCNY: 0,
    startedAtMs: startedMs,
  };

  const execDeps = () => ({
    runtime: deps.runtime,
    emit: deps.emit,
    domainId,
    planId: plan.id,
    sleep,
    now,
    streamDelayMs: deps.streamDelayMs,
  });

  /**
   * 校验当前计划（PRD §7.1）。
   *
   * ★ 内核只取 `ok` 与最高 `severity` 两个信号：
   * 不读 `.code` / `.message` / `.suggestion` / `.evidence`，也不对它们做分支（红线 8）。
   */
  const validateCurrent = async (
    target: Plan,
  ): Promise<{ ok: boolean; severity: 'error' | 'warning' | null }> => {
    const result = await validatePlan(target, ctx);
    return { ok: result.ok, severity: highestSeverity(result) };
  };

  /** 执行一步（含重试循环）；直接更新外层的 `plan`。 */
  const runStep = async (stepId: string): Promise<Observation> => {
    let current = plan.steps.find((step) => step.id === stepId);
    if (!current) return { kind: 'fail', stepId };
    for (;;) {
      const result = await executeStep(current, ctx, execDeps());
      plan = replaceStep(plan, result.step);
      budget.costCNY += result.step.estimate?.costCNY ?? 0.01;
      current = result.step;
      if (result.observation.kind === 'retry' && current.attempt < current.maxAttempts) {
        await sleep(150);
        continue;
      }
      return result.observation;
    }
  };

  /** 触发一轮重规划（含三重闸门 + 收敛判定 + 重排结果复校验）。 */
  const doReplan = async (params: {
    seedIds: string[];
    trigger: ReplanTrigger;
    severity?: 'error' | 'warning';
    attempt: number;
    maxAttempts: number;
  }): Promise<
    | { ok: true; plan: Plan; removedIds: string[]; addedSteps: Step[]; delta: number }
    | { ok: false; reason: string }
  > => {
    const before = plan;
    const strategy = decideStrategy({
      trigger: params.trigger,
      severity: params.severity ?? 'error',
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
    });

    if (strategy === 'retry-step') return { ok: false, reason: 'RETRY_EXHAUSTED' };
    if (strategy === 'ask-user') return { ok: false, reason: 'ASK_USER' };

    const impact =
      strategy === 'full-replan'
        ? {
            impactedIds: before.steps.filter((step) => step.status !== 'done').map((s) => s.id),
            frozenIds: before.steps.filter((step) => step.status === 'done').map((s) => s.id),
            resumeFrom: null,
          }
        : collectImpact(before, params.seedIds);

    if (impact.impactedIds.length === 0) return { ok: false, reason: 'NOTHING_TO_REPLAN' };

    const gated = checkGates(budget, now().getTime(), DEFAULT_GATE_CONFIG);
    if (!gated.allowed) return { ok: false, reason: gated.reason };

    const revision = before.revision + 1;
    const beforeIds = new Set(before.steps.map((step) => step.id));
    const draft = await deps.runtime.replan(
      {
        goal,
        revision,
        trigger: params.trigger,
        failedStepIds: params.seedIds,
        impactedStepIds: impact.impactedIds,
        retainedSteps: before.steps.filter((step) => !impact.impactedIds.includes(step.id)),
        impactedSteps: before.steps.filter((step) => impact.impactedIds.includes(step.id)),
        stepTypes: getStepTypes(domainId),
        templates: getTemplates(domainId),
      },
      ctx,
    );

    const candidate = applyReplanDraft({
      plan: before,
      draft,
      impactedIds: impact.impactedIds,
      revision,
      reason: describeTrigger(params.trigger),
      runId,
      now,
      makeId: (index) => makeReplanStepId(revision, index),
    });

    // ★ 收敛判定只比**受影响子树**：被替换掉的那几步 vs 本次新生成的那几步。
    // 若比整个计划，25 步计划只重排 1 步的 delta 会 < 0.15，被误判成"原地打转"。
    const replaced = before.steps.filter((step) => impact.impactedIds.includes(step.id));
    const generated = candidate.steps.filter((step) => !beforeIds.has(step.id));
    const delta = subtreeDelta(replaced, generated);

    const verdict = evaluateReplan({ budget, nowMs: now().getTime(), delta });
    if (!verdict.allowed) return { ok: false, reason: verdict.reason };

    // 重排结果同样要过校验：新计划依旧不合法 → 这一轮重排无效。
    // 注意 attempt + 1：重排本身已经消耗掉一次尝试，再用尽就转人工，不无限重排。
    const postValidation = await validateCurrent(candidate);
    const postAction = decideValidationAction({
      ok: postValidation.ok,
      severity: postValidation.severity,
      attempt: params.attempt + 1,
      maxAttempts: params.maxAttempts,
    });
    if (postAction === 'ask-user') return { ok: false, reason: 'VALIDATION_ASK_USER' };
    if (postAction !== 'continue') return { ok: false, reason: 'VALIDATION_FAILED' };

    budget.replanCount += 1;
    budget.costCNY += 0.05;

    return {
      ok: true,
      plan: candidate,
      removedIds: [...beforeIds].filter((id) => !candidate.steps.some((step) => step.id === id)),
      addedSteps: generated,
      delta,
    };
  };

  function applyReplanOutcome(outcome: {
    ok: true;
    plan: Plan;
    removedIds: string[];
    addedSteps: Step[];
  }): void {
    for (const id of outcome.removedIds) {
      deps.emit({
        type: 'step_status',
        planId: outcome.plan.id,
        stepId: id,
        status: 'cancelled',
        reason: 'REPLAN',
      });
    }
    plan = outcome.plan;
    // 上下文跟随计划版本：Runtime 可据此区分"重排前后的同名步骤"。
    ctx = { ...ctx, revision: plan.revision };
    for (const step of outcome.addedSteps) {
      deps.emit({ type: 'step_add', planId: plan.id, step });
    }
    deps.emit({
      type: 'plan_status',
      planId: plan.id,
      status: 'running',
      revision: plan.revision,
    });
  }

  /**
   * 校验不通过且无法自动修复 → **转人工**（下发 ClarifyOptions，绝不白屏）。
   * 只给通用选项：内核不知道"该怎么改"是领域的事。
   */
  const askUserForValidation = async (prompt: string): Promise<EngineResult> => {
    plan = { ...plan, status: 'paused' };
    deps.emit({ type: 'plan_status', planId: plan.id, status: 'paused', revision: plan.revision });
    await emitComponent({
      nodeId: 'node-clarify-validation',
      component: 'ClarifyOptions',
      props: {
        questionId: 'clarify:validation',
        prompt,
        options: [
          { id: 'replan', label: '让 Agent 重排受影响的部分' },
          { id: 'abort', label: '放弃这一轮' },
        ],
        traceId,
      },
    });
    return finish('awaiting_user', plan, 'VALIDATION_ASK_USER');
  };

  /* ---------------- 3. 计划校验（PRD §7.1 主路径） ---------------- */

  const validation = await validateCurrent(plan);
  if (!validation.ok) {
    const action = decideValidationAction({
      ok: validation.ok,
      severity: validation.severity,
      attempt: 0,
      maxAttempts: 1,
    });

    if (action === 'ask-user') {
      return askUserForValidation('计划校验没有通过，希望怎么继续？');
    }

    if (action !== 'continue') {
      // 定位不合法的步骤作为重排种子；校验是计划级的，退化时用全部步骤。
      const seeds: string[] = [];
      for (const step of plan.steps) {
        const result = await validateStep(step, ctx);
        if (!result.ok) seeds.push(step.id);
      }
      const seedIds = seeds.length > 0 ? seeds : plan.steps.map((step) => step.id);

      plan = { ...plan, status: 'replanning' };
      deps.emit({
        type: 'plan_status',
        planId: plan.id,
        status: 'replanning',
        revision: plan.revision,
      });
      const outcome = await doReplan({
        seedIds,
        trigger: 'PROVIDER_VALIDATION_FAILED',
        severity: validation.severity ?? 'error',
        attempt: 0,
        maxAttempts: 1,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'VALIDATION_ASK_USER') {
          return askUserForValidation('重排后的计划仍未通过校验，希望怎么继续？');
        }
        return failRun(plan, `校验未通过且无法重排：${outcome.reason}`, outcome.reason);
      }
      applyReplanOutcome(outcome);
    }
  }

  /* ---------------- 5. 审批 → 执行 ---------------- */

  plan = { ...plan, status: 'approved' };
  deps.emit({ type: 'plan_status', planId: plan.id, status: 'approved', revision: plan.revision });
  plan = { ...plan, status: 'running' };
  deps.emit({ type: 'plan_status', planId: plan.id, status: 'running', revision: plan.revision });

  const compiled = compilePlan(plan);
  if (!compiled.ok) {
    return failRun(plan, compiled.error.message, compiled.error.code);
  }
  let graph = compiled.graph;

  let index = 0;
  let guard = 0;

  while (index < graph.batches.length) {
    if (deps.signal?.aborted) {
      plan = { ...plan, status: 'paused' };
      deps.emit({ type: 'plan_status', planId: plan.id, status: 'paused', revision: plan.revision });
      return finish('paused', plan, 'USER_ABORTED');
    }
    if (now().getTime() - startedMs > DEFAULT_GATE_CONFIG.maxDurationMs) {
      return failRun(plan, describeGateReason('MAX_DURATION'), 'MAX_DURATION');
    }
    if ((guard += 1) > 500) break;

    const statuses = new Map(plan.steps.map((step) => [step.id, step.status] as const));
    const batchIds = graph.batches[index].filter((id) => {
      const status = statuses.get(id);
      return status === undefined || isLiveStepStatus(status);
    });
    if (batchIds.length === 0) {
      index += 1;
      continue;
    }

    const batchSteps = batchIds
      .map((id) => plan.steps.find((step) => step.id === id))
      .filter((step): step is Step => step !== undefined);

    let awaitingQuestion: ClarifyQuestion | undefined;
    /** 本批次内所有失败步骤：汇聚成**一次**重规划，而不是每个失败各触发一轮。 */
    const failedSteps: Step[] = [];

    for (const chunk of partitionBatch(batchSteps)) {
      if (chunk.parallelGroup) {
        const observations = await Promise.all(chunk.stepIds.map((id) => runStep(id)));
        for (let i = 0; i < observations.length; i += 1) {
          const stepId = chunk.stepIds[i];
          const found = plan.steps.find((step) => step.id === stepId);
          if (!found) continue;
          if (found.status === 'awaiting_user') {
            awaitingQuestion = observations[i].question ?? awaitingQuestion;
          } else if (found.status === 'failed') {
            failedSteps.push(found);
          }
        }
      } else {
        for (const stepId of chunk.stepIds) {
          const observation = await runStep(stepId);
          const found = plan.steps.find((step) => step.id === stepId);
          if (!found) continue;
          if (found.status === 'awaiting_user') {
            awaitingQuestion = observation.question ?? awaitingQuestion;
          } else if (found.status === 'failed') {
            failedSteps.push(found);
          }
        }
      }
      if (awaitingQuestion) break;
    }

    if (awaitingQuestion) {
      plan = { ...plan, status: 'paused' };
      deps.emit({ type: 'plan_status', planId: plan.id, status: 'paused', revision: plan.revision });
      await emitComponent({
        nodeId: `node-clarify-${awaitingQuestion.id}`,
        component: 'ClarifyOptions',
        props: {
          questionId: awaitingQuestion.id,
          prompt: awaitingQuestion.prompt,
          options: awaitingQuestion.options,
          fields: awaitingQuestion.fields,
          traceId,
        },
      });
      return finish('awaiting_user', plan, 'STEP_AWAITING_USER');
    }

    if (failedSteps.length > 0) {
      plan = { ...plan, status: 'replanning' };
      deps.emit({
        type: 'plan_status',
        planId: plan.id,
        status: 'replanning',
        revision: plan.revision,
      });
      const outcome = await doReplan({
        seedIds: failedSteps.map((step) => step.id),
        trigger: 'FATAL_ERROR',
        attempt: failedSteps[0].attempt,
        maxAttempts: failedSteps[0].maxAttempts,
      });

      if (!outcome.ok) {
        if (outcome.reason === 'VALIDATION_ASK_USER') {
          return askUserForValidation('重排后的计划仍未通过校验，希望怎么继续？');
        }
        const message =
          outcome.reason === 'NO_CONVERGENCE'
            ? '重规划结果与原计划几乎一致，判定为原地打转，已停止自动修复'
            : `重规划被闸门拦截：${outcome.reason}`;
        return failRun(plan, message, outcome.reason);
      }

      applyReplanOutcome(outcome);
      const recompiled = compilePlan(plan);
      if (!recompiled.ok) {
        return failRun(plan, recompiled.error.message, recompiled.error.code);
      }
      graph = recompiled.graph;
      index = 0;
      continue;
    }

    index += 1;
  }

  /* ---------------- 6. 收尾 ---------------- */

  const unfinished = plan.steps.filter((step) => !isTerminalStepStatus(step.status));
  if (unfinished.length > 0 || plan.steps.some((step) => step.status === 'failed')) {
    return failRun(plan, '仍有步骤未进入终态', 'UNFINISHED_STEPS');
  }

  plan = { ...plan, status: 'completed' };
  deps.emit({ type: 'plan_status', planId: plan.id, status: 'completed', revision: plan.revision });
  return finish('completed', plan);
}

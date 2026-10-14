/**
 * 执行循环 —— 把"审批 → 开始 → 编译 → 批次执行 → 重规划 → 收尾"这段最易出错的逻辑
 * 从 `engine.ts` 抽出。
 *
 * ★ 风险最高的一段：并行批次、步骤状态更新、重排后的重新编译都发生在这里。
 * 本模块保持与原 `engine.ts` **逐字一致**的事件发射顺序与返回值语义，不做任何行为改写，
 * 只把依赖显式传进来：
 *   - `session`（RunSession）：读写当前 `plan` / `ctx` / 重规划预算；
 *   - `events`（RunEvents）：统一的组件事件 / 终态事件 / 失败收尾出口；
 *   - `runStep` / `askUserForValidation`：由 `engine.ts` 提供的执行与转人工闭包；
 *   - `doReplan` / `applyReplanOutcome`：来自 `replanCoordinator`（仍走 `RuntimeAdapter` + 通用 `emit`）。
 *
 * 本模块不直接 import Mastra，也不自行决定"整个 run 的最终协议收尾"以外的事件：
 * 终态事件（`done` / `error`）经由共享的 `events.finish` / `events.failRun` 发出，
 * 调用方只需透传返回的 `EngineResult`。
 */
import { compilePlan, type ExecutionGraph } from '@/src/core/compiler/planCompiler';
import { isLiveStepStatus, partitionBatch } from '@/src/core/execution/scheduler';
import type { Observation } from '@/src/core/execution/observer';
import { DEFAULT_GATE_CONFIG, describeGateReason } from '@/src/core/replan/gates';
import { applyReplanOutcome, doReplan, type ReplanEnv, type RunSession } from '@/src/core/run/replanCoordinator';
import type { RunEvents } from '@/src/core/run/runEvents';
import type { EngineResult } from '@/src/core/run/engine';
import type { ClarifyQuestion, Step } from '@/shared/plan/types';
import { isTerminalStepStatus } from '@/shared/plan/types';
import type { StreamEvent } from '@/shared/stream/events';

/** 执行循环所需的外部依赖（状态在 `session` 上，不在此重复持有）。 */
export interface ExecutionLoopDeps {
  /** 编译后的执行图（含并行批次）。重排后会就地重编译并覆盖。 */
  graph: ExecutionGraph;
  /** 中断信号（来自 HTTP 请求的 AbortSignal）。 */
  signal?: { readonly aborted: boolean };
  /** 统一的事件出口（组件事件 / 终态事件 / 失败收尾）。 */
  events: RunEvents;
  /** 原始 `emit`，用于下发计划级状态变更（`plan_status`）。 */
  emit: (event: StreamEvent) => void;
  /** 当前时间（可注入，便于测试）。 */
  now: () => Date;
  /** 时长闸门起算点（计划就绪时刻，非整轮开始）。 */
  planReadyMs: number;
  /** 执行单步的闭包（含重试循环，直接更新 `session.plan`）。 */
  runStep: (stepId: string) => Promise<Observation>;
  /** 校验不通过转人工的闭包。 */
  askUserForValidation: (prompt: string) => Promise<EngineResult>;
  /** 重规划协调器依赖。 */
  replanEnv: ReplanEnv;
  /** 本轮 traceId（用于 ClarifyOptions 等组件 props）。 */
  traceId: string;
}

/**
 * 跑执行循环，直到终态。返回 `EngineResult`（内层已通过 `events` 发射完所有流式事件）。
 *
 * 终端结果分四类，与原 `engine.ts` 一致：
 * - `completed`：全部步骤进入终态；
 * - `awaiting_user`：步骤需要澄清 / 校验需转人工（已下发 ClarifyOptions）；
 * - `failed`：重排失败 / 不收敛 / 仍有未终态步骤（已下发 ErrorState + error）；
 * - `paused`：用户中断（aborted）。
 */
export async function runExecutionLoop(
  session: RunSession,
  deps: ExecutionLoopDeps,
): Promise<EngineResult> {
  const { graph, signal, events, emit, now, planReadyMs, runStep, askUserForValidation, replanEnv, traceId } = deps;

  session.plan = { ...session.plan, status: 'approved' };
  emit({ type: 'plan_status', planId: session.plan.id, status: 'approved', revision: session.plan.revision });
  session.plan = { ...session.plan, status: 'running' };
  emit({ type: 'plan_status', planId: session.plan.id, status: 'running', revision: session.plan.revision });

  // 编译图由调用方在入口处算好并传入（见 `ExecutionLoopDeps.graph`）。
  let currentGraph: ExecutionGraph = graph;

  let index = 0;
  let guard = 0;

  while (index < currentGraph.batches.length) {
    if (signal?.aborted) {
      session.plan = { ...session.plan, status: 'paused' };
      emit({ type: 'plan_status', planId: session.plan.id, status: 'paused', revision: session.plan.revision });
      return events.finish('paused', session.plan, 'USER_ABORTED');
    }
    // 闸门从**计划就绪**起算（不是整轮开始）：给执行与自动修复留出完整窗口。
    if (now().getTime() - planReadyMs > DEFAULT_GATE_CONFIG.maxDurationMs) {
      return events.failRun(session.plan, describeGateReason('MAX_DURATION'), 'MAX_DURATION');
    }
    if ((guard += 1) > 500) break;

    const statuses = new Map(session.plan.steps.map((step) => [step.id, step.status] as const));
    const batchIds = currentGraph.batches[index].filter((id) => {
      const status = statuses.get(id);
      return status === undefined || isLiveStepStatus(status);
    });
    if (batchIds.length === 0) {
      index += 1;
      continue;
    }

    const batchSteps = batchIds
      .map((id) => session.plan.steps.find((step) => step.id === id))
      .filter((step): step is Step => step !== undefined);

    let awaitingQuestion: ClarifyQuestion | undefined;
    /** 本批次内所有失败步骤：汇聚成**一次**重规划，而不是每个失败各触发一轮。 */
    const failedSteps: Step[] = [];

    for (const chunk of partitionBatch(batchSteps)) {
      if (chunk.parallelGroup) {
        const observations = await Promise.all(chunk.stepIds.map((id) => runStep(id)));
        for (let i = 0; i < observations.length; i += 1) {
          const stepId = chunk.stepIds[i];
          const found = session.plan.steps.find((step) => step.id === stepId);
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
          const found = session.plan.steps.find((step) => step.id === stepId);
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
      session.plan = { ...session.plan, status: 'paused' };
      emit({ type: 'plan_status', planId: session.plan.id, status: 'paused', revision: session.plan.revision });
      await events.emitComponent({
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
      return events.finish('awaiting_user', session.plan, 'STEP_AWAITING_USER');
    }

    if (failedSteps.length > 0) {
      session.plan = { ...session.plan, status: 'replanning' };
      emit({
        type: 'plan_status',
        planId: session.plan.id,
        status: 'replanning',
        revision: session.plan.revision,
      });
      const outcome = await doReplan(session, replanEnv, {
        seedIds: failedSteps.map((step) => step.id),
        trigger: 'FATAL_ERROR',
        attempt: failedSteps[0].attempt,
        maxAttempts: failedSteps[0].maxAttempts,
      });

      if (!outcome.ok) {
        if (outcome.reason === 'VALIDATION_ASK_USER') {
          return askUserForValidation('重排后的计划仍未通过校验，希望怎么继续？');
        }
        // 收敛判定是**事后**判断：走到这里的 `NO_CONVERGENCE` 意味着"算出来的计划
        // 和原来几乎一样"，钱和时间都已经花掉了，此时唯一有意义的事是如实告知并停下。
        const message =
          outcome.reason === 'NO_CONVERGENCE'
            ? '重规划结果与原计划几乎一致，判定为原地打转，已停止自动修复'
            : `重规划未能继续：${outcome.reason}`;
        return events.failRun(session.plan, `${message}${outcome.context}`, outcome.reason);
      }

      applyReplanOutcome(session, replanEnv, outcome);
      const recompiled = compilePlan(session.plan);
      if (!recompiled.ok) {
        return events.failRun(session.plan, recompiled.error.message, recompiled.error.code);
      }
      currentGraph = recompiled.graph;
      index = 0;
      continue;
    }

    index += 1;
  }

  /* ---------------- 收尾 ---------------- */

  const unfinished = session.plan.steps.filter((step) => !isTerminalStepStatus(step.status));
  if (unfinished.length > 0 || session.plan.steps.some((step) => step.status === 'failed')) {
    return events.failRun(session.plan, '仍有步骤未进入终态', 'UNFINISHED_STEPS');
  }

  session.plan = { ...session.plan, status: 'completed' };
  emit({ type: 'plan_status', planId: session.plan.id, status: 'completed', revision: session.plan.revision });
  return events.finish('completed', session.plan);
}

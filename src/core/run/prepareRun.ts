/**
 * 准备阶段 —— 把"目标解析/澄清、RunContext 创建、计划创建或恢复、计划就绪后的
 * 事件下发与预算初始化"从 `engine.ts` 抽到这里。
 *
 * 领域无关：只调 `src/core/**` 的纯函数与 `RuntimeAdapter`，不认识任何领域语义。
 * 所有对 UI 的输出都通过共享的 `events`（`RunEvents`）与 `deps.emit` 下发。
 *
 * 返回两种结果：
 * - `early_exit`：准备阶段就需结束（领域包未注册 / 需澄清 / 续跑快照非法 / 计划生成失败），
 *   调用方直接透传其 `EngineResult`；
 * - `ready`：计划、上下文、预算与后续阶段所需的元信息齐备，由调用方进入校验与执行。
 *
 * 这样一来 `engine.ts` 主要表现为：准备 → 校验 → 批准并开始 → 执行循环 → 统一收尾。
 */
import { type Goal, type Plan } from '@/shared/plan/types';
import { zRunContext, type RunContext } from '@/shared/run/types';
import type { EngineInput, EngineDeps, EngineResult } from '@/src/core/run/engine';
import { createPlan } from '@/src/core/planning/planner';
import { resumePlan } from '@/src/core/run/resume';
import { parseGoal } from '@/src/core/goal/parse';
import {
  applyAnswers,
  applyDomainAnswers,
  buildClarifyQuestionsForField,
  needsClarification,
} from '@/src/core/goal/clarify';
import { DEFAULT_GATE_CONFIG, type ReplanBudget } from '@/src/core/replan/gates';
import { getDomainPack, listDomainIds } from '@/src/core/registry/domainRegistry';
import type { RunEvents } from '@/src/core/run/runEvents';

/** 计划逐条下发之间的间隔（纯展示节奏，不影响语义）。 */
const DEFAULT_STEP_DELAY_MS = 90;

/** 准备阶段所需依赖。状态（plan/ctx/budget）由本模块产出，不在此预先持有。 */
export interface PrepareDeps {
  input: EngineInput;
  deps: EngineDeps;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  events: RunEvents;
  runId: string;
  traceId: string;
  /** 整轮开始的时刻（只用于 ctx.startedAt 记账，不用于时长闸门）。 */
  startedMs: number;
}

/** 准备阶段的产出：要么提前结束，要么交出可执行的计划与上下文。 */
export type PrepareResult =
  | { kind: 'early_exit'; result: EngineResult }
  | {
      kind: 'ready';
      plan: Plan;
      ctx: RunContext;
      budget: ReplanBudget;
      goal: Goal;
      domainId: string;
      runId: string;
      traceId: string;
      planReadyMs: number;
    };

export async function prepareRun(p: PrepareDeps): Promise<PrepareResult> {
  const { input, deps, now, sleep, events, runId, traceId, startedMs } = p;

  /* ---------------- 1. 目标解析与澄清 ---------------- */

  const domainId = input.domainId ?? listDomainIds()[0] ?? '';

  if (!domainId || !getDomainPack(domainId)) {
    return { kind: 'early_exit', result: await events.failRun(null, '领域包未注册', 'DOMAIN_PACK_NOT_FOUND') };
  }

  const parsed = parseGoal(
    { runId, raw: input.goal, now: now() },
    { requireConstraints: input.requireConstraints ?? false },
  );
  const answers = input.answers ?? {};

  /**
   * ★ 领域澄清优先：领域包可以消费上一轮的表单答案，**并顺带摘掉 `missingFields`**。
   * 见 `engine.ts` 原注释：领域注入点必须在 `needsClarification` 之前生效，
   * 才有一条"领域能问领域问题"的通路（红线：core 不含领域词，这里只认 clarify 槽位）。
   */
  const clarifyContribution = getDomainPack(domainId)?.clarify;
  const goal = applyDomainAnswers(applyAnswers(parsed.goal, answers), answers, clarifyContribution);

  if (needsClarification(goal)) {
    const question = buildClarifyQuestionsForField(
      goal,
      goal.missingFields[0] ?? 'goal.detail',
      answers,
      clarifyContribution,
    )[0];
    if (question) {
      await events.emitComponent({
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
    return { kind: 'early_exit', result: events.finish('awaiting_user', null, 'GOAL_NEEDS_CLARIFICATION') };
  }

  let ctx: RunContext = zRunContext.parse({
    runId,
    traceId,
    goalId: goal.id,
    domainId,
    revision: 1,
    startedAt: new Date(startedMs).toISOString(),
    // 这里的 deadlineAt 只是**占位**：真正的建计划调用（`createPlan`）发生在它之后，
    // 等计划就绪后会按 `planReadyMs` 重新赋值（见下方注释）。
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
    if (!resumed.ok) {
      return { kind: 'early_exit', result: await events.failRun(null, resumed.message, resumed.reason) };
    }
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
      return {
        kind: 'early_exit',
        result: await events.failRun(null, created.error.message || '计划生成失败', created.error.code),
      };
    }
    plan = created.plan;
  }

  /**
   * ★★ 时长预算的起算点：**计划就绪**时刻，不是整轮开始时刻。
   * `ctx.startedAt` 忠实记录整轮起点用于追溯；闸门度量"计划产出之后还剩多少可用时间"。
   * 因此从这一刻起重新起算，并把 `ctx.deadlineAt` 一并顺延（`ctx` 会由调用方继续传递）。
   */
  const planReadyMs = now().getTime();
  ctx = {
    ...ctx,
    deadlineAt: new Date(planReadyMs + DEFAULT_GATE_CONFIG.maxDurationMs).toISOString(),
  };

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
    // 起算点 = 计划就绪（见 planReadyMs 处的注释），不是整轮开始。
    startedAtMs: planReadyMs,
  };

  return {
    kind: 'ready',
    plan,
    ctx,
    budget,
    goal,
    domainId,
    runId,
    traceId,
    planReadyMs,
  };
}

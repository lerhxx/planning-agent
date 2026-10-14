/**
 * 重规划协调器 —— 把"决定重排策略 / 计算影响面 / 闸门 / 收敛 / 复校验"从 `engine.ts` 抽出。
 *
 * 领域无关：只调 `src/core/**` 的纯函数与 `RuntimeAdapter`，**不 import Mastra**，
 * 也**不自行下发 AG-UI 终态事件**（`component_*` / `done` / `error`）。
 * 需要下发的计划级事件（`step_status` / `step_add` / `plan_status`）通过通用的
 * `emit(StreamEvent)` 发出 —— 这些属于内核流式契约，不是传输层 AG-UI 事件。
 *
 * 调度与重规划规则仍属于内核，不移到 `mastra`：本模块直接依赖 `decideStrategy`、
 * `collectImpact`、各类闸门与收敛判定，并经由 `RuntimeAdapter` 调用 `runtime.replan()`。
 */
import { makeReplanStepId, type Goal, type Plan, type Step } from '@/shared/plan/types';
import type { StreamEvent } from '@/shared/stream/events';
import { applyReplanDraft } from '@/src/core/planning/planner';
import { validatePlan, highestSeverity } from '@/src/core/planning/validate';
import {
  checkGates,
  DEFAULT_GATE_CONFIG,
  judgeConvergence,
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
import { getStepTypes, getTemplates } from '@/src/core/registry/domainRegistry';
import type { RuntimeAdapter } from '@/src/core/runtime/adapter';
import type { RunContext } from '@/shared/run/types';

/**
 * 一轮 run 内由多个阶段共享的可变状态。
 *
 * ★ 克制原则：只放确实跨阶段共享的 `plan` / `ctx` / 重规划预算，不做包含所有字段的
 *   "万能上下文"。`executionLoop` 与 `prepareRun` 后续也会读写同一个 session。
 */
export interface RunSession {
  plan: Plan;
  ctx: RunContext;
  budget: ReplanBudget;
}

/** 重规划协调器运行所需的外部依赖（不持有状态，状态在 session 上）。 */
export interface ReplanEnv {
  runtime: RuntimeAdapter;
  emit: (event: StreamEvent) => void;
  now: () => Date;
  goal: Goal;
  domainId: string;
  runId: string;
}

/** 重规划结果：成功带新计划与增删信息，失败带内核通用诊断。 */
export type ReplanOutcome =
  | { ok: true; plan: Plan; removedIds: string[]; addedSteps: Step[]; delta: number }
  | { ok: false; reason: string; context: string };

/* ---------------- 内核通用诊断（只服务于重规划失败原因） ---------------- */

const MAX_DIAGNOSTIC_IDS = 5;

/** 单条失败原因摘要的字符上限（防御性：内核标签都很短，但渲染出口只留一道闸）。 */
const MAX_REASON_CHARS = 24;

/** 失败步骤没有可用原因文本时的**显式占位**。 */
const REASON_UNKNOWN = '原因未知';

/** 受影响但从未执行过的步骤（纯粹被依赖关系带进影响面，自身没失败）。 */
const REASON_NOT_RUN = '未执行';

/**
 * 内核通用错误码 → 面向用户的短标签。
 *
 * ★★ 这是**唯一**允许出现在失败原因位置的数据源：键取自内核通用码白名单，
 * 值是内核自己写死的常量，因此渲染出的字符**全部来自内核**，
 * 不含任何模型输出、工具入参或用户输入。
 */
const KERNEL_ERROR_LABELS: Readonly<Record<string, string>> = {
  PROVIDER_VALIDATION_FAILED: '返回内容未通过校验',
  SOURCE_MISSING: '缺少结果来源',
  TOOL_FAILED: '工具调用失败',
  TOOL_TIMEOUT: '工具调用超时',
  PLAN_CYCLE_DETECTED: '计划存在循环依赖',
  PLAN_DEPENDENCY_MISSING: '计划缺少依赖步骤',
  PLAN_PARALLEL_GROUP_DEPENDENCY: '并行分组依赖非法',
  PLAN_GENERATION_FAILED: '计划生成失败',
  DOMAIN_PACK_NOT_FOUND: '领域包未注册',
  REPLAN_GATE_BLOCKED: '重排被闸门拦截',
  REPLAN_NO_CONVERGENCE: '重排未收敛',
  USER_ABORTED: '用户已中止',
  INTERNAL_ERROR: '内核内部错误',
};

/** 截断到上限（超长时补省略号）。内核标签都很短，这里给渲染出口留一道闸。 */
function clipReason(text: string): string {
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS)}…`;
}

/**
 * 单个步骤的失败原因摘要（内核通用，无领域语义、无外部原文）。
 *
 * 三种取值，从不编造：
 * - 该步骤**不在计划里** → `原因未知`（拿不到就是拿不到，不猜）；
 * - **不是失败**（被依赖关系带进影响面、尚未轮到执行）→ `未执行`；
 * - 失败了但 `error` 缺失、或 `error.code` 不在白名单 → `原因未知`。
 */
function describeStepFailureReason(step: Step | undefined): string {
  if (!step) return REASON_UNKNOWN;
  if (step.status !== 'failed') return REASON_NOT_RUN;
  const label = step.error ? KERNEL_ERROR_LABELS[step.error.code] : undefined;
  return label ? clipReason(label) : REASON_UNKNOWN;
}

/**
 * 重排失败的诊断尾巴：**内核通用**信息 —— 触发码（`ReplanTrigger`）+
 * 被替换的步骤 id + **每个步骤各自的失败原因**。
 *
 * @param impacted 每个受影响步骤的 id 与其失败原因摘要，**一一对应、不允许缺项**。
 */
function describeReplanContext(
  trigger: ReplanTrigger,
  impacted: readonly { id: string; reason: string }[],
): string {
  if (impacted.length === 0) {
    return `（触发=${trigger}，受影响步骤=无）`;
  }
  const shown = impacted
    .slice(0, MAX_DIAGNOSTIC_IDS)
    .map((item) => `${item.id}=${item.reason}`)
    .join('、');
  const rest = impacted.length - Math.min(impacted.length, MAX_DIAGNOSTIC_IDS);
  const suffix = rest > 0 ? ` 等共 ${impacted.length} 个` : '';
  return `（触发=${trigger}，受影响步骤=${shown}${suffix}）`;
}

/* ---------------- 重规划：策略 → 影响面 → 闸门 → 收敛 → 复校验 ---------------- */

/**
 * 触发一轮重规划（**事前**闸门 + **事后**收敛判定 + 重排结果复校验）。
 *
 * 失败时除 `reason` 外还带一个 `context`：内核通用的诊断尾巴（触发码 + 被替换的
 * 步骤 id + 每个步骤各自的失败原因）。
 *
 * ★ 不改写任何"终态协议收尾"：失败只返回 `{ ok: false, ... }`，由调用方决定
 *   如何收尾（转人工 / 失败）。本模块只负责把"重排发生了什么"算清楚。
 */
export async function doReplan(
  session: RunSession,
  env: ReplanEnv,
  params: {
    seedIds: string[];
    trigger: ReplanTrigger;
    severity?: 'error' | 'warning';
    attempt: number;
    maxAttempts: number;
  },
): Promise<ReplanOutcome> {
  /**
   * 诊断尾巴：`trigger` 在整个 `doReplan` 期间不变，先绑上免得每条 return 都写一遍。
   *
   * ★ 原因从**当前计划**里按 id 现查，而不是从调用点传进来：失败原因写在每一步的
   *   `error.code` 上（`executor.ts` 的 `finalize` 写的），让调用点组装就等于让每个
   *   `fail(...)` 都要重复一遍查表逻辑 —— 而"哪一步为什么失败"只有一个权威来源，
   *   就是步骤本身。`doReplan` 成功之前不会重赋值 `session.plan`，所以这里读到的
   *   始终是失败那一刻的计划。
   */
  const fail = (
    reason: string,
    impactedIds: readonly string[] = [],
  ): ReplanOutcome => ({
    ok: false,
    reason,
    context: describeReplanContext(
      params.trigger,
      impactedIds.map((id) => ({
        id,
        reason: describeStepFailureReason(session.plan.steps.find((step) => step.id === id)),
      })),
    ),
  });

  const before = session.plan;
  const strategy = decideStrategy({
    trigger: params.trigger,
    severity: params.severity ?? 'error',
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
  });

  // 策略决定不重排（改重试 / 转人工）时，影响面还没算出来 —— 诊断只带触发码。
  if (strategy === 'retry-step') return fail('RETRY_EXHAUSTED');
  if (strategy === 'ask-user') return fail('ASK_USER');

  const impact =
    strategy === 'full-replan'
      ? {
          impactedIds: before.steps.filter((step) => step.status !== 'done').map((s) => s.id),
          frozenIds: before.steps.filter((step) => step.status === 'done').map((s) => s.id),
          resumeFrom: null,
        }
      : collectImpact(before, params.seedIds);

  if (impact.impactedIds.length === 0) return fail('NOTHING_TO_REPLAN');

  // ★ 事前闸门：唯一该问"还该不该再开一轮"的地方。红线 17。
  const gated = checkGates(session.budget, env.now().getTime(), DEFAULT_GATE_CONFIG);
  if (!gated.allowed) return fail(gated.reason, impact.impactedIds);

  const revision = before.revision + 1;
  const beforeIds = new Set(before.steps.map((step) => step.id));
  const draft = await env.runtime.replan(
    {
      goal: env.goal,
      revision,
      trigger: params.trigger,
      failedStepIds: params.seedIds,
      impactedStepIds: impact.impactedIds,
      retainedSteps: before.steps.filter((step) => !impact.impactedIds.includes(step.id)),
      impactedSteps: before.steps.filter((step) => impact.impactedIds.includes(step.id)),
      stepTypes: getStepTypes(env.domainId),
      templates: getTemplates(env.domainId),
    },
    session.ctx,
  );

  const candidate = applyReplanDraft({
    plan: before,
    draft,
    impactedIds: impact.impactedIds,
    revision,
    reason: describeTrigger(params.trigger),
    runId: env.runId,
    // ★ 重排新生成的步骤同样要调工具、同样需要目标摘要才能识别出口径 ——
    // 与首次规划走同一个内核事实（`env.goal` 是 `parseGoal` + 澄清答案合成后的结果）。
    goalSummary: env.goal.summary,
    now: env.now,
    makeId: (index) => makeReplanStepId(revision, index),
  });

  // ★ 收敛判定只比**受影响子树**：被替换掉的那几步 vs 本次新生成的那几步。
  // 若比整个计划，25 步计划只重排 1 步的 delta 会 < 0.15，被误判成"原地打转"。
  const replaced = before.steps.filter((step) => impact.impactedIds.includes(step.id));
  const generated = candidate.steps.filter((step) => !beforeIds.has(step.id));
  const delta = subtreeDelta(replaced, generated);

  // ★ 事后判定**只**看收敛，不复查预算：预算类闸门是"事前"约束（见 gates.ts 的
  // 不变式注释）。此处若再查一次时长，那一次真模型调用（10–30s）本身就会把
  // 25s 预算顶穿，于是每一轮重排都在算完之后被自己耗时打成 MAX_DURATION。
  const verdict = judgeConvergence({ delta });
  if (!verdict.allowed) return fail(verdict.reason, impact.impactedIds);

  // 重排结果同样要过校验：新计划依旧不合法 → 这一轮重排无效。
  // 注意 attempt + 1：重排本身已经消耗掉一次尝试，再用尽就转人工，不无限重排。
  const postValidation = await validatePlan(candidate, session.ctx);
  const postAction = decideValidationAction({
    ok: postValidation.ok,
    severity: highestSeverity(postValidation),
    attempt: params.attempt + 1,
    maxAttempts: params.maxAttempts,
  });
  if (postAction === 'ask-user') return fail('VALIDATION_ASK_USER', impact.impactedIds);
  if (postAction !== 'continue') return fail('VALIDATION_FAILED', impact.impactedIds);

  session.budget.replanCount += 1;
  session.budget.costCNY += 0.05;

  return {
    ok: true,
    plan: candidate,
    removedIds: [...beforeIds].filter((id) => !candidate.steps.some((step) => step.id === id)),
    addedSteps: generated,
    delta,
  };
}

/**
 * 把一次成功的重规划结果落盘到 session：下发被取消步骤、更新计划与上下文版本、
 * 下发新增步骤、把计划状态翻回 running。
 *
 * 通过通用的 `emit(StreamEvent)` 下发 `step_status` / `step_add` / `plan_status`，
 * 不直接触碰任何 AG-UI 终态事件。
 */
export function applyReplanOutcome(
  session: RunSession,
  env: ReplanEnv,
  outcome: { ok: true; plan: Plan; removedIds: string[]; addedSteps: Step[] },
): void {
  for (const id of outcome.removedIds) {
    env.emit({
      type: 'step_status',
      planId: outcome.plan.id,
      stepId: id,
      status: 'cancelled',
      reason: 'REPLAN',
    });
  }
  session.plan = outcome.plan;
  // 上下文跟随计划版本：Runtime 可据此区分"重排前后的同名步骤"。
  session.ctx = { ...session.ctx, revision: session.plan.revision };
  for (const step of outcome.addedSteps) {
    env.emit({ type: 'step_add', planId: session.plan.id, step });
  }
  env.emit({
    type: 'plan_status',
    planId: session.plan.id,
    status: 'running',
    revision: session.plan.revision,
  });
}

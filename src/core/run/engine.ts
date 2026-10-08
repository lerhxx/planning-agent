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
import { applyAnswers, applyDomainAnswers, buildClarifyQuestionsForField, needsClarification } from '@/src/core/goal/clarify';
import { applyEdit } from '@/src/core/planning/edit';
import { applyReplanDraft, createPlan } from '@/src/core/planning/planner';
import { highestSeverity, validatePlan, validateStep } from '@/src/core/planning/validate';
import {
  checkGates,
  DEFAULT_GATE_CONFIG,
  describeGateReason,
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

/**
 * 诊断尾巴里最多列出的被替换步骤 id 个数。
 *
 * 超过就只给个数不给清单：id 列表是给排障的人看的定位线索，不是给人读的故事，
 * 贴满一屏既没人看，也会把真正的原因（触发码）挤出去。
 */
const MAX_DIAGNOSTIC_IDS = 5;

/** 单条失败原因摘要的字符上限（防御性：内核标签都很短，但渲染出口只留一道闸）。 */
const MAX_REASON_CHARS = 24;

/**
 * 失败步骤没有可用原因文本时的**显式占位**。
 *
 * ★ 为什么必须显式写出来而不是静默省略：`受影响步骤=s-1=工具调用超时、s-2` 里
 *   读不出"s-2 到底为什么没的" —— 省略与"它没问题"在文本上无法区分。空缺也要可见。
 */
const REASON_UNKNOWN = '原因未知';

/** 受影响但从未执行过的步骤（纯粹被依赖关系带进影响面，自身没失败）。 */
const REASON_NOT_RUN = '未执行';

/**
 * 内核通用错误码 → 面向用户的短标签。
 *
 * ★★ 这是**唯一**允许出现在失败原因位置的数据源：键取自内核通用码白名单，
 * 值是内核自己写死的常量，因此渲染出的字符**全部来自内核**，
 * 不含任何模型输出、工具入参或用户输入。
 *
 * 为什么**不**展示 `Step.error.message`：
 * - 该字段的来源不受内核约束 —— `executor.ts` 的兜底 catch 直接透传
 *   `error instanceof Error ? error.message`（任意异常消息，含外部文本），
 *   `runtime/mastra/parse.ts` 又会把 zod 的校验文本拼进去；
 * - 更进一步，`AgentError.detail` 里明确躺着 `toolName` 与 `allowedToolNames`
 *   （`planner.ts` 有意回传给模型"该改成什么"），那是**给模型看的纠错数据**，
 *   透给用户等于把模型的中间状态铺到 UI 上。
 *
 * 所以走"**白名单查表**"而不是"截断原文"：不在表里的码一律 `原因未知`。
 * 这样"防泄漏"就不依赖"截断得够短"，而是结构上不可能渲染出外部文本。
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
 * 连续三轮的排查都卡在同一处：报错只说"哪些步骤失败了"，不说"为什么失败"。
 * 触发码与步骤 id 是先补上的（它们直接让下一个缺陷暴露了出来），原因是最后一块 ——
 * 步骤状态里其实**一直**带着 `error.code`，只是没有任何一条用户可见信息把它带出来。
 *
 * ★ 为什么不放进 `ErrorState` 的 props（而是并进 `failRun` 的 message）：
 *   - 故障现场是 `Error:重规划被闸门拦截：MAX_DURATION` 这一行**纯文本** ——
 *     它来自 `failRun` 的 `message`（同时进 `ErrorState` 卡片与 `error` 事件）。
 *     卡片 props 是结构化的、只在 UI 里可见，而报错那一刻看的人看的是日志/告警文本；
 *     把上下文补进 `message` 才能真正到达"看到报错的人"手里。
 *   - 这样也只改一处文案出口，不必给 `ErrorState` 再加一个字段（组件 props 契约
 *     在 `src/components/**`，属于传输层，不该被内核的错误语义撑大）。
 *
 * ⚠️ 全是内核通用表述，**不得出现任何领域语义**（触发码本身已是内核枚举，
 * 步骤 id 是内核生成的，原因标签来自上面的白名单查表）。
 *
 * @param impacted 每个受影响步骤的 id 与其失败原因摘要，**一一对应、不允许缺项**
 *                 （缺项会让"原因"与"步骤"对不上号）。
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
  /**
   * ★ 整轮开始的时刻 —— **只用于记账，不用于时长闸门**。
   * 见下面 `planReadyMs` 的注释：闸门度量的是"计划产出之后还剩多少可用时间"。
   */
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

  /**
   * 失败收尾：先把要展示的内容发完，最后才发终态事件。
   *
   * ★ 发射顺序不变式（改动前请看懂再动）：`error` 是本轮对外的**终态**事件 ——
   *   传输层把它翻成协议终态之后，客户端会拒收它后面的**任何**事件（连组件增量
   *   也算，实测报错形如 "The run has already errored ... No further events can be
   *   sent"）。所以凡是想让用户看见的东西（组件三连 + `plan_status`）都必须排在
   *   `error` 之前；`error` 之后只剩 `finish()` 那条内核记账用的终态事件，
   *   它在协议侧会被终态互斥规则丢弃 —— 也就是说客户端看到的最后一个事件就是
   *   `error`，而错误卡片已经在 `error` 之前完整送达。
   */
  const failRun = async (
    plan: Plan | null,
    message: string,
    reason: string,
  ): Promise<EngineResult> => {
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
    deps.emit({ type: 'error', traceId, message, recoverable: false });
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
  const answers = input.answers ?? {};

  /**
   * ★ 领域澄清优先：领域包可以消费上一轮的表单答案，**并顺带摘掉 `missingFields`**。
   *
   * 为什么必须在 `needsClarification` 之前调用：
   * 本文件原本是「内核先判 `needsClarification` → 是则 early-return → 否则才建计划、
   * 跑工具」。这意味着领域下发的表单澄清（领域包 `tools.ts` 里那条）
   * **永远轮不到** —— 工具根本没被建出来。对"北京一日游"这类目标，内核那一句
   * `raw.length < minRawLength` 会直接拦下，用户只看到两个按钮。
   * 领域注入点在 `needsClarification` **之前**生效，才有一条"领域能问领域问题"的通路。
   *
   * ★ 领域无关：这里只认"有没有 clarify 槽位"，不认任何领域内容（红线：core 不含领域词）。
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

  /**
   * ★★ 时长预算的起算点：**计划就绪**时刻，不是整轮开始时刻。
   *
   * 为什么必须是两个不同的时刻：
   * - `ctx.startedAt`（= `startedMs`）**记录事实** —— 这一轮是什么时候开始的，
   *   用于上报、追溯、算总耗时。它必须忠实于真实起点，不能被挪动。
   * - 时长闸门（`maxDurationMs`）度量的是**"计划产出之后还剩多少可用时间"** ——
   *   它是留给"执行 + 自动修复（重排）"的作业窗口。
   *
   * 之前两者都从整轮开始起算，于是：真模型的首次 `createPlan` 本身就要 10–30s，
   * 等计划回来时 25s 的预算已经被规划吃光（甚至 `ctx.deadlineAt` 已经变成过去时刻），
   * 任何一次校验失败都必然以`MAX_DURATION` 收场 —— 自动修复事实上已经死了。
   *
   * 因此从这一刻起重新起算，并把 `ctx.deadlineAt` 一并顺延（`ctx` 是 `let`，可直接重赋值）。
   * 注意 `startedAt` 仍然保留真实的整轮起点：闸门量的是剩余可用时间，不是总耗时。
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

  /**
   * 触发一轮重规划（**事前**闸门 + **事后**收敛判定 + 重排结果复校验）。
   *
   * 失败时除`reason` 外还带一个 `context`：内核通用的诊断尾巴（触发码 + 被替换的
   * 步骤 id + 每个步骤各自的失败原因）。这轮排查之所以绕了这么多层，就是因为错误
   * 一路都不带上下文 —— 只看得到"被闸门拦截"，看不到"是哪一步失败、因为什么才触发
   * 的重排"，更看不到"它自己又是为什么失败的"。
   */
  const doReplan = async (params: {
    seedIds: string[];
    trigger: ReplanTrigger;
    severity?: 'error' | 'warning';
    attempt: number;
    maxAttempts: number;
  }): Promise<
    | { ok: true; plan: Plan; removedIds: string[]; addedSteps: Step[]; delta: number }
    | { ok: false; reason: string; context: string }
  > => {
    /**
     * 诊断尾巴：`trigger` 在整个 `doReplan` 期间不变，先绑上免得每条return 都写一遍。
     *
     * ★ 原因从**当前 `plan`** 里按 id 现查，而不是从调用点传进来：
     *   失败原因写在每一步的 `error.code` 上（`executor.ts` 的 `finalize` 写的），
     *   让调用点组装就等于让每个 `fail(...)` 都要重复一遍查表逻辑 ——
     *   而"哪一步为什么失败"这件事只有一个权威来源，就是步骤本身。
     *   `doReplan` 成功之前不会重赋值 `plan`，所以这里读到的始终是失败那一刻的计划。
     */
    const fail = (
      reason: string,
      impactedIds: readonly string[] = [],
    ): { ok: false; reason: string; context: string } => ({
      ok: false,
      reason,
      context: describeReplanContext(
        params.trigger,
        impactedIds.map((id) => ({
          id,
          reason: describeStepFailureReason(plan.steps.find((step) => step.id === id)),
        })),
      ),
    });

    const before = plan;
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
    const gated = checkGates(budget, now().getTime(), DEFAULT_GATE_CONFIG);
    if (!gated.allowed) return fail(gated.reason, impact.impactedIds);

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
      // ★ 重排新生成的步骤同样要调工具、同样需要目标摘要才能识别出口径 ——
      // 与首次规划走同一个内核事实（`goal` 是本闭包里 `parseGoal` + 澄清答案合成后的结果）。
      goalSummary: goal.summary,
      now,
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
    const postValidation = await validateCurrent(candidate);
    const postAction = decideValidationAction({
      ok: postValidation.ok,
      severity: postValidation.severity,
      attempt: params.attempt + 1,
      maxAttempts: params.maxAttempts,
    });
    if (postAction === 'ask-user') return fail('VALIDATION_ASK_USER', impact.impactedIds);
    if (postAction !== 'continue') return fail('VALIDATION_FAILED', impact.impactedIds);

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
        return failRun(
          plan,
          `校验未通过且无法重排：${outcome.reason}${outcome.context}`,
          outcome.reason,
        );
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
    // 闸门从**计划就绪**起算（不是整轮开始）：给执行与自动修复留出完整窗口。
    if (now().getTime() - planReadyMs > DEFAULT_GATE_CONFIG.maxDurationMs) {
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
        // 收敛判定是**事后**判断：走到这里的 `NO_CONVERGENCE` 意味着"算出来的计划
        // 和原来几乎一样"，钱和时间都已经花掉了，此时唯一有意义的事是如实告知并停下。
        const message =
          outcome.reason === 'NO_CONVERGENCE'
            ? '重规划结果与原计划几乎一致，判定为原地打转，已停止自动修复'
            : `重规划未能继续：${outcome.reason}`;
        return failRun(plan, `${message}${outcome.context}`, outcome.reason);
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

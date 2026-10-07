/**
 * Planner —— `Goal → Plan`（C0-02）。
 *
 * 模型调用一律走 `RuntimeAdapter`（红线 13）。Runtime 的返回是**不可信输入**，
 * 必须先 `zPlanDraft.safeParse`，失败即返回内核通用错误码，绝不把脏数据写进计划。
 *
 * 本文件位于 `src/core/**`：只认 `step.type` 这类**槽位**，不认识任何领域语义。
 */
import {
  makeIdempotencyKey,
  makeStepId,
  zPlan,
  type AgentError,
  type Goal,
  type Plan,
  type Step,
  type StepDraft,
} from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import { zPlanDraft, type PlanDraft, type RuntimeAdapter } from '@/src/core/runtime/adapter';
import { getDomainPack, getStepType, getTemplates } from '@/src/core/registry/domainRegistry';

export interface PlannerDeps {
  runtime: RuntimeAdapter;
  now?: () => Date;
}

export type CreatePlanResult = { ok: true; plan: Plan } | { ok: false; error: AgentError };

export interface CreatePlanInput {
  goal: Goal;
  ctx: RunContext;
  domainId: string;
  revision?: number;
  signals?: string[];
}

/** Goal → Plan（状态 `draft`）。 */
export async function createPlan(input: CreatePlanInput, deps: PlannerDeps): Promise<CreatePlanResult> {
  const now = deps.now ?? (() => new Date());
  const pack = getDomainPack(input.domainId);
  if (!pack) {
    return {
      ok: false,
      error: {
        code: 'DOMAIN_PACK_NOT_FOUND',
        message: '领域包未注册',
        retryable: false,
        traceId: input.ctx.traceId,
      },
    };
  }

  const revision = input.revision ?? 1;
  const raw = await deps.runtime.plan(
    {
      goal: input.goal,
      stepTypes: pack.planning.stepTypes,
      templates: getTemplates(input.domainId),
      signals: input.signals ?? input.ctx.signals,
      revision,
    },
    input.ctx,
  );

  const parsed = zPlanDraft.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'PLAN_GENERATION_FAILED',
        message: '计划草稿未通过 schema 校验',
        retryable: false,
        traceId: input.ctx.traceId,
        detail: parsed.error.issues.slice(0, 5),
      },
    };
  }

  const steps = buildSteps(parsed.data, {
    domainId: input.domainId,
    runId: input.ctx.runId,
    revision,
    now,
    goalSummary: input.goal.summary,
    validateType: (type) => getStepType(input.domainId, type) !== undefined,
    maxAttemptsFor: (type) => getStepType(input.domainId, type)?.maxAttempts ?? 2,
  });

  if (!steps.ok) return { ok: false, error: steps.error };

  const iso = now().toISOString();
  const plan: Plan = zPlan.parse({
    id: `plan-${input.ctx.runId}`,
    runId: input.ctx.runId,
    goalId: input.goal.id,
    domainId: input.domainId,
    revision,
    status: 'draft',
    summary: parsed.data.summary,
    steps: steps.value,
    createdAt: iso,
    updatedAt: iso,
  });

  return { ok: true, plan };
}

/* ------------------------------------------------------------------ *
 * 草稿 → Step
 * ------------------------------------------------------------------ */

export interface BuildStepsOptions {
  domainId: string;
  runId: string;
  revision: number;
  now?: () => Date;
  /**
   * 内核持有的**真实**目标摘要（用户原话，经 `parseGoal` / 澄清答案合成处理过的那份）。
   * 调用方直接从 `Goal.summary` 取来；`buildSteps` 把它注入每个带 `intent` 的步骤，
   * 语义（尤其是"覆盖模型写入值"）见 `injectGoalSummary` 的注释。
   */
  goalSummary?: string;
  /** step.type 是否在领域白名单内。 */
  validateType?: (type: string) => boolean;
  maxAttemptsFor?: (type: string) => number;
  /** 自定义 id 生成（重规划时用带 revision 的 id）。 */
  makeId?: (index: number, draft: StepDraft) => string;
  originFor?: (index: number, draft: StepDraft) => Step['origin'];
  /**
   * 额外的**合法引用**集合（默认空）：重排时新步骤可以合法引用「未被替换的保留步骤」的 id，
   * 那些 id 不在本草稿自己铸造出的 id 里，必须显式放行。
   */
  allowRefs?: readonly string[];
}

/** ★ 工具入参里"目标摘要"这个槽位键名（领域工具按这个名字读口径）。 */
const GOAL_SUMMARY_INPUT_KEY = 'goalSummary';

/**
 * ★ 把内核持有的真实目标摘要注入步骤的工具入参（**全仓库唯一的注入点**）。
 *
 * ## 为什么需要它
 *
 * 领域工具普遍从入参里的目标摘要读取口径（范围、期限、额度）来决定检索目标，
 * 而这份摘要是**内核的事实**（用户原话 + 已确认的澄清答案），不是模型的自由发挥。
 * 过去只有 MockRuntime 在回放模板时顺手把摘要塞进入参，真模型路径下这一步**缺失** ——
 * 工具拿不到口径、识别不出范围、报错，步骤被重试到上限仍然全失败。
 * 这是一条"只有 Mock 才满足的隐性契约"：Mock 顺手替内核兜了底，把缺口一直遮着。
 *
 * ## 为什么放在`buildSteps` 而不是 runtime 里
 *
 * `buildSteps` 是**草稿 → `Step` 的唯一转换点**，首次规划与重排都走它。
 * 放在这里 ⇒ 两个 runtime、两条路径自动一致，不必每个 runtime 各记得一次。
 * 放在 runtime 里 ⇒ 每接入一个新runtime 就要重犯一次，且只有"用过 Mock"的那条被测过。
 *
 * ## 覆盖语义：内核事实**覆盖**模型写入的值
 *
 * 模型在 `intent.input.goalSummary` 里写的是它自己的**转述**。按红线 2，模型产出是不可信输入，
 * 转述属于"未经取数的事实"：一旦被当成口径，工具就会拿一份没人核对过的目标去检索 ——
 * 错城市、错天数、错预算，而且完全静默。所以这里**无条件覆盖**为内核持有的真实摘要。
 *
 * ★ 模型写的**其它**入参字段（分类、条数、偏好等）一律保留不动：
 * 那些是模型的自由度，覆盖它们会把"注入一个事实"变成"接管整个入参"。
 *
 * ## 两个边界
 *
 * - `intent: null`（纯推理步骤）没有工具入参，不注入 —— 否则凭空造出一个没人消费的字段；
 * - `goalSummary` 未提供（调用方拿不到目标）时保持草稿原样，不写入 `undefined`。
 */
function injectGoalSummary(draft: StepDraft, goalSummary: string | undefined): StepDraft['intent'] {
  if (!draft.intent) return null;
  if (goalSummary === undefined) return draft.intent;
  return { ...draft.intent, input: { ...draft.intent.input, [GOAL_SUMMARY_INPUT_KEY]: goalSummary } };
}

/** `detail` 里最多列几条悬空引用 —— 再多就刷屏了，够定位即可。 */
const MAX_DANGLING_DETAIL = 5;

/**
 * 草稿 → Step（补齐运行态字段）。纯函数。
 *
 * 两处拒绝点，都返回内核通用错误码 `PLAN_GENERATION_FAILED`：
 * 1. 步骤类型不在白名单内；
 * 2. ★ `dependsOn` 指向了不存在的步骤 id（悬空引用）。
 *
 * ★ 为什么必须在**这里**就查悬空引用（红线 2：模型产出是不可信输入）：
 * 悬空引用一旦静默写进 `Plan`，就再没有人知道它是"模型写错了 id"——
 *   - 编译期 `compilePlan` 只会以 `PLAN_DEPENDENCY_MISSING` 拒绝**整个计划**
 *     （见 `src/core/compiler/planCompiler.ts` 依赖完整性检查），用户看到的是一句
 *     与模型行为无关的通用拒绝，排查要一路回溯到草稿；
 *   - 重排路径上，`buildSteps` 的失败会被 `applyReplanDraft` 折叠成"这一步没生成"，
 *     表现为一轮说不清原因的重排空转，而不是一条能指回模型的诊断。
 * 因此在这里就把它挡掉，并标 `retryable: true` —— 重新采样一次模型很可能就对了。
 */
export function buildSteps(
  draft: PlanDraft,
  options: BuildStepsOptions,
): { ok: true; value: Step[] } | { ok: false; error: AgentError } {
  const now = options.now ?? (() => new Date());
  const iso = now().toISOString();
  const steps: Step[] = [];

  for (let index = 0; index < draft.steps.length; index += 1) {
    const item = draft.steps[index];
    if (options.validateType && !options.validateType(item.type)) {
      return {
        ok: false,
        error: {
          code: 'PLAN_GENERATION_FAILED',
          message: '步骤类型不在领域白名单内',
          retryable: false,
          detail: { type: item.type },
        },
      };
    }
    const id = options.makeId?.(index, item) ?? item.id ?? makeStepId(index);
    steps.push({
      id,
      domainId: options.domainId,
      type: item.type,
      order: index,
      title: item.title,
      description: item.description,
      estimate: item.estimate,
      dependsOn: item.dependsOn.slice(),
      parallelGroup: item.parallelGroup,
      status: 'pending',
      intent: injectGoalSummary(item, options.goalSummary),
      idempotencyKey: makeIdempotencyKey(options.runId, id, 0),
      attempt: 0,
      maxAttempts: options.maxAttemptsFor?.(item.type) ?? 2,
      origin:
        options.originFor?.(index, item) ?? { kind: 'planner' as const, revision: options.revision },
      emittedNodeIds: [],
      renderAs: item.renderAs,
      createdAt: iso,
      updatedAt: iso,
    });
  }

  // ★ 第二遍才校验引用：草稿允许**前向引用**（某步依赖排在它后面的步骤），
  // 边铸边查会把这种合法写法误杀，所以必须等全部 id 铸造完再查。
  const referable = new Set<string>(steps.map((step) => step.id));
  for (const ref of options.allowRefs ?? []) referable.add(ref);

  const dangling: Array<{ stepId: string; ref: string }> = [];
  for (const step of steps) {
    for (const ref of step.dependsOn) {
      if (!referable.has(ref)) dangling.push({ stepId: step.id, ref });
    }
  }
  if (dangling.length > 0) {
    return {
      ok: false,
      error: {
        code: 'PLAN_GENERATION_FAILED',
        message: '计划里有步骤依赖了不存在的步骤 id',
        retryable: true,
        detail: {
          dangling: dangling.slice(0, MAX_DANGLING_DETAIL),
          total: dangling.length,
        },
      },
    };
  }

  return { ok: true, value: steps };
}

/**
 * 把重规划草稿合并回计划 —— **纯函数**。
 *
 * ★ 已完成步骤不进入 `impactedIds`，因此它们的 id 与状态原样保留（红线 14）。
 *
 * ★ 草稿构建失败（类型越界 / `dependsOn` 悬空）时**不会**把新步骤整批丢掉 ——
 * 那等于静默删除受影响步骤。此时保留原有步骤，本轮重排退化成空操作，
 * 由上层闸门与重排次数去收敛；具体原因通过 `onReject` 交给调用方上报。
 */
export function applyReplanDraft(input: {
  plan: Plan;
  draft: PlanDraft;
  impactedIds: readonly string[];
  revision: number;
  reason: string;
  runId: string;
  /**
   * 内核持有的真实目标摘要。★ 重排路径**必须**由调用方传入：
   * 本函数拿不到 `Goal`（只有 `plan` / `draft` / `impactedIds`），
   * 而重排生成的新步骤同样要调工具、同样需要那份口径 —— 不传就等于把
   * "只有 Mock 才注入"的缺口原样留在重排路径上。
   */
  goalSummary?: string;
  now?: () => Date;
  makeId?: (index: number, draft: StepDraft) => string;
  /** 草稿被拒时的回调：让"模型契约违规"在第一现场可见，而不是变成一次无声的空操作。 */
  onReject?: (error: AgentError) => void;
}): Plan {
  const now = input.now ?? (() => new Date());
  const impacted = new Set(input.impactedIds);
  const remain = input.plan.steps.filter((step) => !impacted.has(step.id));

  const built = buildSteps(input.draft, {
    domainId: input.plan.domainId,
    runId: input.runId,
    revision: input.revision,
    now,
    goalSummary: input.goalSummary,
    makeId: input.makeId,
    // ★ 保留步骤（含已完成步骤）仍留在计划里，新步骤引用它们的 id 是合法的，必须放行。
    allowRefs: remain.map((step) => step.id),
    originFor: (index, _draft) => ({
      kind: 'replan' as const,
      revision: input.revision,
      parentStepId: input.impactedIds[index] ?? input.impactedIds[0],
      reason: input.reason,
    }),
  });

  if (!built.ok) {
    input.onReject?.(built.error);
    // 保留原计划的全部步骤（含受影响步骤）：宁可这一轮重排白跑，也不让步骤凭空消失。
    const unchanged = input.plan.steps.map((step, index) => ({ ...step, order: index }));
    return {
      ...input.plan,
      revision: input.revision,
      status: 'running',
      steps: unchanged,
      updatedAt: now().toISOString(),
    };
  }

  const merged = [...remain, ...built.value].map((step, index) => ({ ...step, order: index }));

  return {
    ...input.plan,
    revision: input.revision,
    status: 'running',
    summary: input.draft.summary || input.plan.summary,
    steps: merged,
    updatedAt: now().toISOString(),
  };
}

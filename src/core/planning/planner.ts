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
  /** step.type 是否在领域白名单内。 */
  validateType?: (type: string) => boolean;
  maxAttemptsFor?: (type: string) => number;
  /** 自定义 id 生成（重规划时用带 revision 的 id）。 */
  makeId?: (index: number, draft: StepDraft) => string;
  originFor?: (index: number, draft: StepDraft) => Step['origin'];
}

/**
 * 草稿 → Step（补齐运行态字段）。纯函数。
 * 步骤类型不在白名单内 → 返回内核通用错误码 `PLAN_GENERATION_FAILED`。
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
      intent: item.intent ?? null,
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

  return { ok: true, value: steps };
}

/**
 * 把重规划草稿合并回计划 —— **纯函数**。
 *
 * ★ 已完成步骤不进入 `impactedIds`，因此它们的 id 与状态原样保留（红线 14）。
 */
export function applyReplanDraft(input: {
  plan: Plan;
  draft: PlanDraft;
  impactedIds: readonly string[];
  revision: number;
  reason: string;
  runId: string;
  now?: () => Date;
  makeId?: (index: number, draft: StepDraft) => string;
}): Plan {
  const now = input.now ?? (() => new Date());
  const impacted = new Set(input.impactedIds);
  const remain = input.plan.steps.filter((step) => !impacted.has(step.id));

  const built = buildSteps(input.draft, {
    domainId: input.plan.domainId,
    runId: input.runId,
    revision: input.revision,
    now,
    makeId: input.makeId,
    originFor: (index, _draft) => ({
      kind: 'replan' as const,
      revision: input.revision,
      parentStepId: input.impactedIds[index] ?? input.impactedIds[0],
      reason: input.reason,
    }),
  });

  const newSteps = built.ok ? built.value : [];
  const merged = [...remain, ...newSteps].map((step, index) => ({ ...step, order: index }));

  return {
    ...input.plan,
    revision: input.revision,
    status: 'running',
    summary: input.draft.summary || input.plan.summary,
    steps: merged,
    updatedAt: now().toISOString(),
  };
}

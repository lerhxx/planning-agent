/**
 * 用户编辑的三档回写（PRD §6.3 / C0-08）—— 纯函数。
 *
 * | 档 | 触发 | 行为 | 成本 |
 * |----|------|------|------|
 * | L0 | 只改尚未执行的步骤文本 | 本地直接改 | 0 |
 * | L1 | 影响下游 | 从最早受影响的未完成步开始重排（保留已完成 stepId） | 低 |
 * | L2 | 改了目标级约束 | 全量重排，revision+1 | 高 |
 *
 * ★ 已完成步骤**默认冻结**：改动已完成的步骤需要显式 `rollback_to_step`，否则拒绝。
 */
import { z } from 'zod';
import {
  zEditCommand,
  type EditCommand,
  type Goal,
  type Plan,
  type Step,
} from '@/shared/plan/types';
import { collectImpact } from '@/src/core/replan/impact';

export { zEditCommand };
export type { EditCommand };

export const zEditLevel = z.enum(['L0', 'L1', 'L2']);
export type EditLevel = z.infer<typeof zEditLevel>;

export interface EditClassification {
  level: EditLevel;
  /** 需要重排的步骤（已完成步骤永远不在其中）。 */
  impactedStepIds: string[];
}

export type EditResult =
  | {
      ok: true;
      plan: Plan;
      goal: Goal;
      level: EditLevel;
      impactedStepIds: string[];
    }
  | { ok: false; reason: 'FROZEN_STEP' | 'STEP_NOT_FOUND' };

const TEXT_ONLY_FIELDS = new Set(['title', 'description']);

/** 该步骤是否处于"已执行过"的状态（冻结门槛）。 */
function isSettled(step: Step): boolean {
  return step.status === 'done' || step.status === 'running';
}

/**
 * 判定编辑属于哪一档。**不改动计划**，只给结论（可单测、可预演）。
 */
export function classifyEdit(command: EditCommand, plan: Plan): EditClassification {
  switch (command.kind) {
    case 'editGoal':
      // 改目标级约束：影响面最大，全量重排。
      return {
        level: 'L2',
        impactedStepIds: plan.steps.filter((step) => step.status !== 'done').map((step) => step.id),
      };

    case 'rollback_to_step': {
      // 显式解冻：该步骤及其下游全部回到未完成，按 L1 重排。
      const impact = collectImpact(plan, [command.stepId], { skipTerminal: false });
      return { level: 'L1', impactedStepIds: [...new Set([command.stepId, ...impact.impactedIds])] };
    }

    case 'editStep': {
      const target = plan.steps.find((step) => step.id === command.stepId);
      if (!target) return { level: 'L0', impactedStepIds: [] };
      const fields = Object.keys(command.patch);
      const textOnly = fields.length > 0 && fields.every((field) => TEXT_ONLY_FIELDS.has(field));
      const hasDependents = plan.steps.some((step) => step.dependsOn.includes(command.stepId));
      if (textOnly && !hasDependents && !isSettled(target)) {
        return { level: 'L0', impactedStepIds: [] };
      }
      return { level: 'L1', impactedStepIds: collectImpact(plan, [command.stepId]).impactedIds };
    }

    case 'removeStep': {
      // 删除必然影响下游：L1。
      return { level: 'L1', impactedStepIds: collectImpact(plan, [command.stepId]).impactedIds };
    }

    case 'addStep': {
      // 新增步骤：只有挂了依赖才需要重算拓扑。
      return command.dependsOn.length > 0
        ? { level: 'L1', impactedStepIds: plan.steps.filter((s) => s.status !== 'done').map((s) => s.id) }
        : { level: 'L0', impactedStepIds: [] };
    }

    case 'reorder': {
      return { level: 'L1', impactedStepIds: collectImpact(plan, [command.stepId]).impactedIds };
    }

    case 'retryStep': {
      // 重试 = 解冻该步及其下游（含已完成步骤），重新执行。
      const impact = collectImpact(plan, [command.stepId], { skipTerminal: false });
      return { level: 'L1', impactedStepIds: [...new Set([command.stepId, ...impact.impactedIds])] };
    }

    case 'skipStep': {
      // 跳过该步：自身转 skipped，下游重新评估。
      return { level: 'L1', impactedStepIds: collectImpact(plan, [command.stepId]).impactedIds };
    }

    default:
      return { level: 'L1', impactedStepIds: [] };
  }
}

/**
 * 应用编辑。**纯函数**：返回新的 Plan / Goal，不改动入参。
 *
 * L0：直接改。L1/L2：本地改完后把受影响步骤打回 `pending`，
 * 并把 `impactedStepIds` 交给上层触发 `runtime.replan`（真正的重排由 Runtime 生成）。
 */
export function applyEdit(
  plan: Plan,
  goal: Goal,
  command: EditCommand,
  options: { runId: string; now?: Date; revision?: number } = { runId: '' },
): EditResult {
  const now = (options.now ?? new Date()).toISOString();
  const classification = classifyEdit(command, plan);

  switch (command.kind) {
    case 'editStep': {
      const target = plan.steps.find((step) => step.id === command.stepId);
      if (!target) return { ok: false, reason: 'STEP_NOT_FOUND' };
      if (isSettled(target)) return { ok: false, reason: 'FROZEN_STEP' };

      const fields = Object.keys(command.patch);
      const steps = plan.steps.map((step) =>
        step.id === command.stepId
          ? {
              ...step,
              ...command.patch,
              status: step.status === 'ready' ? ('pending' as const) : step.status,
              origin: {
                kind: 'user' as const,
                revision: plan.revision,
                editedFromStepId: step.id,
                editedFields: fields,
                editedAt: now,
              },
              updatedAt: now,
            }
          : step,
      );
      return finishEdit(plan, steps, classification, goal, now);
    }

    case 'removeStep': {
      const target = plan.steps.find((step) => step.id === command.stepId);
      if (!target) return { ok: false, reason: 'STEP_NOT_FOUND' };
      if (isSettled(target)) return { ok: false, reason: 'FROZEN_STEP' };
      const steps = plan.steps
        .filter((step) => step.id !== command.stepId)
        .map((step) => ({
          ...step,
          dependsOn: step.dependsOn.filter((dep) => dep !== command.stepId),
          updatedAt: now,
        }));
      return finishEdit(plan, renumber(steps), classification, goal, now);
    }

    case 'addStep': {
      const id = `u-${plan.steps.length + 1}`;
      const step: Step = {
        id,
        domainId: plan.domainId,
        type: command.draft.type,
        order: plan.steps.length,
        title: command.draft.title,
        description: command.draft.description,
        estimate: command.draft.estimate,
        dependsOn: command.dependsOn.slice(),
        parallelGroup: command.draft.parallelGroup,
        status: 'pending',
        intent: command.draft.intent ?? null,
        idempotencyKey: `${options.runId}:${id}:0`,
        attempt: 0,
        maxAttempts: 2,
        origin: {
          kind: 'user',
          revision: plan.revision,
          editedFromStepId: id,
          editedFields: ['*'],
          editedAt: now,
        },
        emittedNodeIds: [],
        renderAs: command.draft.renderAs,
        createdAt: now,
        updatedAt: now,
      };
      return {
        ok: true,
        plan: { ...plan, steps: renumber([...plan.steps, step]), updatedAt: now },
        goal,
        level: classification.level,
        impactedStepIds: classification.impactedStepIds,
      };
    }

    case 'reorder': {
      const steps = plan.steps.map((step) =>
        step.id === command.stepId ? { ...step, order: command.toOrder, updatedAt: now } : step,
      );
      return finishEdit(plan, renumber(steps), classification, goal, now);
    }

    case 'editGoal': {
      const nextGoal: Goal = { ...goal, constraints: command.constraints };
      const steps = plan.steps.map((step) =>
        step.status === 'done' ? step : { ...step, status: 'pending' as const, updatedAt: now },
      );
      return {
        ok: true,
        plan: { ...plan, steps, revision: options.revision ?? plan.revision + 1, updatedAt: now },
        goal: nextGoal,
        level: 'L2',
        impactedStepIds: classification.impactedStepIds,
      };
    }

    case 'rollback_to_step':
    case 'retryStep': {
      // 显式解冻：把该步骤及其下游打回 pending，允许再次编辑/重跑。
      const impacted = new Set(classification.impactedStepIds);
      const steps = plan.steps.map((step) =>
        impacted.has(step.id) && step.status !== 'pending'
          ? {
              ...step,
              status: 'pending' as const,
              attempt: command.kind === 'retryStep' ? 0 : step.attempt,
              result: undefined,
              error: undefined,
              updatedAt: now,
            }
          : step,
      );
      return {
        ok: true,
        plan: { ...plan, steps, updatedAt: now },
        goal,
        level: 'L1',
        impactedStepIds: classification.impactedStepIds,
      };
    }

    case 'skipStep': {
      const target = plan.steps.find((step) => step.id === command.stepId);
      if (!target) return { ok: false, reason: 'STEP_NOT_FOUND' };
      if (isSettled(target)) return { ok: false, reason: 'FROZEN_STEP' };

      const steps = plan.steps.map((step) =>
        step.id === command.stepId ? { ...step, status: 'skipped' as const, updatedAt: now } : step,
      );
      return finishEdit(plan, steps, classification, goal, now);
    }

    default:
      return { ok: false, reason: 'STEP_NOT_FOUND' };
  }
}

/**
 * L1：把受影响步骤打回 `pending`，交给上层触发 `runtime.replan`。
 * ★ 已完成步骤不在 `impactedIds` 中，因此天然被保护（红线 14）。
 */
function withImpactedReset(
  steps: readonly Step[],
  impactedIds: readonly string[],
  now: string,
): Step[] {
  const impacted = new Set(impactedIds);
  return steps.map((step) =>
    impacted.has(step.id) && step.status !== 'done'
      ? { ...step, status: 'pending' as const, updatedAt: now }
      : step,
  );
}

function finishEdit(
  plan: Plan,
  steps: readonly Step[],
  classification: EditClassification,
  goal: Goal,
  now: string,
): EditResult {
  const reset = withImpactedReset(steps, classification.impactedStepIds, now);
  return {
    ok: true,
    plan: { ...plan, steps: reset, updatedAt: now },
    goal,
    level: classification.level,
    impactedStepIds: classification.impactedStepIds,
  };
}

function renumber(steps: Step[]): Step[] {
  return steps.map((step, index) => ({ ...step, order: index }));
}

/**
 * 续跑计划解析 —— 把客户端回传的计划快照变回可执行的计划。
 *
 * ★ plan 来自网络 → **不可信**：先 `zPlan.safeParse`，失败即拒绝（不静默吃脏数据）。
 * ★ 编辑命令只在终态生效：已完成步骤仍然受"默认冻结"约束（红线 14 / PRD §6.3）。
 *
 * 纯函数：只依赖 `shared/plan/types` 与 `planning/edit`，不读任何运行时闭包状态，
 * 因此可被 `engine.ts` 直接复用，也能被单测独立验证。
 */
import { zPlan, type EditCommand, type Goal, type Plan } from '@/shared/plan/types';
import { applyEdit } from '@/src/core/planning/edit';

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

/**
 * 影响面分析 —— 纯函数。
 *
 * ★ 局部重规划 = **反向收集下游受影响子树**；**已完成 step 不进入影响面**（天然冻结）。
 * 这是 C0-07「重规划后已完成 step id 不变」的实现根据。
 */
import { z } from 'zod';
import type { Plan, Step } from '@/shared/plan/types';

export const zImpactSet = z.object({
  /** 需要重排的步骤（已完成步骤已被剔除）。 */
  impactedIds: z.array(z.string()).default([]),
  /** 被冻结的已完成步骤（保留原 id，不参与重排）。 */
  frozenIds: z.array(z.string()).default([]),
  /** 影响面内最早的未完成步骤；`null` 表示不需要重排。 */
  resumeFrom: z.string().nullable().default(null),
});
export type ImpactSet = z.infer<typeof zImpactSet>;

/**
 * 从种子步骤出发，反向收集所有**直接/间接依赖它**的步骤。
 *
 * @param plan      当前计划
 * @param seedIds   触发重规划的步骤（通常是失败的那一步）
 * @param opts.skipTerminal 是否跳过终态步骤（默认 true：done 步骤被冻结）
 */
export function collectImpact(
  plan: Plan,
  seedIds: readonly string[],
  opts: { skipTerminal?: boolean } = {},
): ImpactSet {
  const skipTerminal = opts.skipTerminal ?? true;
  const byId = new Map<string, Step>();
  const dependents = new Map<string, string[]>();
  for (const step of plan.steps) {
    byId.set(step.id, step);
    dependents.set(step.id, []);
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      dependents.get(dep)?.push(step.id);
    }
  }

  const frozenIds = new Set<string>();
  const impacted = new Set<string>();
  const queue: string[] = [];

  for (const seed of seedIds) {
    const step = byId.get(seed);
    if (!step) continue;
    if (skipTerminal && step.status === 'done') {
      frozenIds.add(step.id);
      continue;
    }
    if (!impacted.has(seed)) {
      impacted.add(seed);
      queue.push(seed);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of dependents.get(current) ?? []) {
      if (impacted.has(next)) continue;
      const step = byId.get(next);
      if (!step) continue;
      if (skipTerminal && step.status === 'done') {
        frozenIds.add(step.id);
        continue;
      }
      impacted.add(next);
      queue.push(next);
    }
  }

  const impactedList = plan.steps.filter((s) => impacted.has(s.id)).map((s) => s.id);
  const resumeFrom = plan.steps.find((s) => impacted.has(s.id))?.id ?? null;

  return {
    impactedIds: impactedList,
    frozenIds: plan.steps.filter((s) => frozenIds.has(s.id)).map((s) => s.id),
    resumeFrom,
  };
}

/** 已完成步骤的 id 集合（重规划前后必须保持一致）。 */
export function completedStepIds(plan: Pick<Plan, 'steps'>): string[] {
  return plan.steps.filter((s) => s.status === 'done').map((s) => s.id);
}

/**
 * 校验重规划后的计划是否满足「已完成 step id 不变」。
 * 内核自检用：返回被破坏的 id 列表，空数组 = 通过。
 */
export function brokenCompletedIds(before: Pick<Plan, 'steps'>, after: Pick<Plan, 'steps'>): string[] {
  const beforeDone = new Map(
    before.steps.filter((s) => s.status === 'done').map((s) => [s.id, s] as const),
  );
  const afterById = new Map(after.steps.map((s) => [s.id, s] as const));
  const broken: string[] = [];
  for (const [id, step] of beforeDone) {
    const next = afterById.get(id);
    if (!next || next.status !== 'done' || next.type !== step.type) broken.push(id);
  }
  return broken;
}

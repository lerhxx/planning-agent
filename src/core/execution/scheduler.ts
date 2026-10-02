/**
 * 调度器 —— 纯函数：把 `ExecutionGraph` 翻译成可执行的批次与并发块。
 *
 * 规则（C0-04）：按依赖拓扑分批；同一 `parallelGroup` 内并行，非分组步骤顺序执行。
 */
import { z } from 'zod';
import { isTerminalStepStatus, type Step, type StepStatus } from '@/shared/plan/types';
import type { ExecutionGraph } from '@/src/core/compiler/planCompiler';

export const zExecutionChunk = z.object({
  parallelGroup: z.string().optional(),
  stepIds: z.array(z.string()).min(1),
});
export type ExecutionChunk = z.infer<typeof zExecutionChunk>;

/** 还会参与调度的状态（终态不再调度）。 */
export const LIVE_STEP_STATUSES: readonly StepStatus[] = ['pending', 'ready', 'failed', 'awaiting_user'];

export function isLiveStepStatus(status: StepStatus): boolean {
  return LIVE_STEP_STATUSES.includes(status);
}

/**
 * 过滤掉终态步骤后的批次。
 * @param statuses 步骤 id → 当前状态（用 Map 传入以保持纯函数，不持有可变引用）
 */
export function liveBatches(graph: ExecutionGraph, statuses: Map<string, StepStatus>): string[][] {
  return graph.batches
    .map((batch) => batch.filter((id) => {
      const status = statuses.get(id);
      return status === undefined || isLiveStepStatus(status);
    }))
    .filter((batch) => batch.length > 0);
}

/** 把批次内的步骤切成并发块：同组并行，其余顺序执行。 */
export function partitionBatch(steps: readonly Step[]): ExecutionChunk[] {
  const chunks: ExecutionChunk[] = [];
  const seenGroups = new Set<string>();

  for (const step of steps) {
    if (step.parallelGroup) {
      if (seenGroups.has(step.parallelGroup)) continue;
      seenGroups.add(step.parallelGroup);
      const members = steps.filter((s) => s.parallelGroup === step.parallelGroup);
      chunks.push({
        parallelGroup: step.parallelGroup,
        stepIds: members.map((m) => m.id),
      });
      continue;
    }
    chunks.push({ stepIds: [step.id] });
  }

  return chunks;
}

/** 一个批次是否已全部进入终态（用于跳过已完成批次）。 */
export function isBatchSettled(stepIds: readonly string[], statuses: Map<string, StepStatus>): boolean {
  if (stepIds.length === 0) return true;
  return stepIds.every((id) => {
    const status = statuses.get(id);
    return status !== undefined && isTerminalStepStatus(status) && status !== 'failed';
  });
}

/**
 * 把批次内步骤置为 `ready`（表示它们的依赖已满足，可以开跑）。
 * 纯函数：返回新的步骤数组，不改动入参。
 */
export function markBatchReady(steps: readonly Step[], stepIds: readonly string[]): Step[] {
  const targets = new Set(stepIds);
  return steps.map((step) =>
    targets.has(step.id) && step.status === 'pending' ? { ...step, status: 'ready' as const } : step,
  );
}

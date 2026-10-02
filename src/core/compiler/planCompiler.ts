/**
 * ★ PlanCompiler —— **纯函数**：`Plan → ExecutionGraph(IR)`。
 *
 * 红线 12：必须纯（无副作用、可单测）、含环检测，且**不得放在 runtime 目录**。
 * 它不认识任何领域语义，只做三件事：校验依赖完整性 → 检测环 → 计算拓扑批次。
 */
import { z } from 'zod';
import {
  zStepStatus,
  type AgentError,
  type Plan,
  type Step,
} from '@/shared/plan/types';
import { detectCycle } from './cycleDetect';

export const zExecutionNode = z.object({
  stepId: z.string().min(1),
  type: z.string().min(1),
  /** 拓扑层级（= 批次序号）。 */
  depth: z.number().int().nonnegative(),
  dependsOn: z.array(z.string()).default([]),
  parallelGroup: z.string().optional(),
  status: zStepStatus,
});
export type ExecutionNode = z.infer<typeof zExecutionNode>;

export const zExecutionEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type ExecutionEdge = z.infer<typeof zExecutionEdge>;

export const zExecutionGraph = z.object({
  planId: z.string().min(1),
  domainId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  nodes: z.array(zExecutionNode).default([]),
  edges: z.array(zExecutionEdge).default([]),
  /** 按批次排列的 stepId；同一批次内可并行，`parallelGroup` 决定并发策略。 */
  batches: z.array(z.array(z.string())).default([]),
});
export type ExecutionGraph = z.infer<typeof zExecutionGraph>;

export type CompileResult =
  | { ok: true; graph: ExecutionGraph }
  | { ok: false; error: AgentError; cycle: string[] };

function makeError(
  code: AgentError['code'],
  message: string,
  detail?: unknown,
): AgentError {
  return { code, message, retryable: false, detail };
}

/**
 * 编译计划为可执行的 IR。
 *
 * 失败路径优先（CONSTRAINTS Do's #7）：
 * 1. 依赖指向不存在的 step → `PLAN_DEPENDENCY_MISSING`
 * 2. 依赖成环 → `PLAN_CYCLE_DETECTED`（绝不死循环）
 * 3. 同 `parallelGroup` 内存在依赖关系 → `PLAN_PARALLEL_GROUP_DEPENDENCY`
 */
export function compilePlan(plan: Plan): CompileResult {
  const steps = plan.steps;
  const byId = new Map<string, Step>();
  for (const step of steps) {
    byId.set(step.id, step);
  }

  const missing: Array<{ stepId: string; dep: string }> = [];
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) missing.push({ stepId: step.id, dep });
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      cycle: [],
      error: makeError(
        'PLAN_DEPENDENCY_MISSING',
        '计划依赖指向了不存在的步骤',
        missing,
      ),
    };
  }

  const detected = detectCycle(steps);
  if (detected.hasCycle) {
    return {
      ok: false,
      cycle: detected.cycle,
      error: makeError('PLAN_CYCLE_DETECTED', '计划依赖图存在环', detected.cycle),
    };
  }

  const depth = computeDepths(steps, byId);

  // 同组内不允许互相依赖：否则会被排进同一批次，破坏依赖顺序。
  for (const step of steps) {
    if (!step.parallelGroup) continue;
    for (const dep of step.dependsOn) {
      const depStep = byId.get(dep);
      if (depStep && depStep.parallelGroup === step.parallelGroup) {
        return {
          ok: false,
          cycle: [],
          error: makeError(
            'PLAN_PARALLEL_GROUP_DEPENDENCY',
            '同一并行分组内不允许存在依赖',
            { group: step.parallelGroup, from: dep, to: step.id },
          ),
        };
      }
    }
  }

  const nodes: ExecutionNode[] = steps.map((step) => ({
    stepId: step.id,
    type: step.type,
    depth: depth.get(step.id) ?? 0,
    dependsOn: step.dependsOn.slice(),
    parallelGroup: step.parallelGroup,
    status: step.status,
  }));

  const edges: ExecutionEdge[] = [];
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      edges.push({ from: dep, to: step.id });
    }
  }

  const batches = buildBatches(steps, depth);

  return {
    ok: true,
    graph: {
      planId: plan.id,
      domainId: plan.domainId,
      revision: plan.revision,
      nodes,
      edges,
      batches,
    },
  };
}

/**
 * 计算每个 step 的拓扑层级：
 * `depth = max(depth(dep) + 1)`，随后把同一 `parallelGroup` 的成员抬平到组内最大层级，
 * 并向下游传播，直到稳定（迭代上限 = 步骤数，保证必然终止）。
 */
function computeDepths(steps: readonly Step[], byId: Map<string, Step>): Map<string, number> {
  const depth = new Map<string, number>();
  const order = topologicalOrder(steps);
  for (const id of order) {
    const step = byId.get(id)!;
    let value = 0;
    for (const dep of step.dependsOn) {
      value = Math.max(value, (depth.get(dep) ?? 0) + 1);
    }
    depth.set(id, value);
  }

  // 抬平并行组：同组成员必须落在同一批次。
  for (let round = 0; round < steps.length; round += 1) {
    let changed = false;
    const groupMax = new Map<string, number>();
    for (const step of steps) {
      if (!step.parallelGroup) continue;
      const current = depth.get(step.id) ?? 0;
      groupMax.set(step.parallelGroup, Math.max(groupMax.get(step.parallelGroup) ?? 0, current));
    }
    for (const step of steps) {
      if (!step.parallelGroup) continue;
      const target = groupMax.get(step.parallelGroup) ?? 0;
      if ((depth.get(step.id) ?? 0) !== target) {
        depth.set(step.id, target);
        changed = true;
      }
    }
    // 向下游传播抬平结果。
    for (const id of order) {
      const step = byId.get(id)!;
      let value = 0;
      for (const dep of step.dependsOn) {
        value = Math.max(value, (depth.get(dep) ?? 0) + 1);
      }
      if (value > (depth.get(id) ?? 0)) {
        depth.set(id, value);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return depth;
}

/** Kahn 拓扑序（调用前已确保无环）。 */
function topologicalOrder(steps: readonly Step[]): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, 0);
    dependents.set(step.id, []);
  }
  for (const step of steps) {
    const deps = new Set(step.dependsOn);
    indegree.set(step.id, deps.size);
    for (const dep of deps) dependents.get(dep)!.push(step.id);
  }
  const queue = steps.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of dependents.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  return out;
}

/** 按 depth 分桶；桶内按 `order` 再按 id 稳定排序。 */
function buildBatches(steps: readonly Step[], depth: Map<string, number>): string[][] {
  const buckets = new Map<number, Step[]>();
  for (const step of steps) {
    const d = depth.get(step.id) ?? 0;
    const bucket = buckets.get(d);
    if (bucket) bucket.push(step);
    else buckets.set(d, [step]);
  }
  const depths = [...buckets.keys()].sort((a, b) => a - b);
  return depths.map((d) =>
    buckets
      .get(d)!
      .slice()
      .sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order))
      .map((s) => s.id),
  );
}

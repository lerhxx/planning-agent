/**
 * 依赖环检测 —— 纯函数，无副作用。
 *
 * 采用 Kahn 拓扑排序：能全部出队则无环，否则返回一条具体的环路径（便于报错与单测）。
 */
import type { Step } from '@/shared/plan/types';

export interface CycleDetectResult {
  hasCycle: boolean;
  /** 形如 ['a','b','a'] 的环路径；无环时为空数组。 */
  cycle: string[];
}

/**
 * 检测 step 依赖图是否存在环。
 *
 * 入参只用到 `id` 与 `dependsOn`，因此可直接传 Step 或任意同构对象。
 * 指向不存在节点的依赖**不构成环**，由 `planCompiler` 单独报 `PLAN_DEPENDENCY_MISSING`。
 */
export function detectCycle(steps: readonly Pick<Step, 'id' | 'dependsOn'>[]): CycleDetectResult {
  const known = new Set(steps.map((s) => s.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    indegree.set(step.id, 0);
    dependents.set(step.id, []);
  }

  for (const step of steps) {
    // 同一个 dep 重复出现只算一次，避免入度被重复累加。
    const deps = new Set(step.dependsOn.filter((d) => known.has(d)));
    indegree.set(step.id, deps.size);
    for (const dep of deps) {
      dependents.get(dep)!.push(step.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of dependents.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (visited === steps.length) {
    return { hasCycle: false, cycle: [] };
  }

  return { hasCycle: true, cycle: findCyclePath(steps, indegree) };
}

/** 从入度仍 >0 的节点出发做 DFS，取出一条具体环路径用于报错。 */
function findCyclePath(
  steps: readonly Pick<Step, 'id' | 'dependsOn'>[],
  indegree: Map<string, number>,
): string[] {
  const edges = new Map<string, string[]>();
  for (const step of steps) {
    edges.set(step.id, step.dependsOn.slice());
  }

  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 / 1 访问中 / 2 已完成
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    path.push(id);
    for (const dep of edges.get(id) ?? []) {
      if (!edges.has(dep)) continue;
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const start = path.indexOf(dep);
        return [...path.slice(start < 0 ? 0 : start), dep];
      }
      if (s === 0) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };

  for (const [id, deg] of indegree) {
    if (deg > 0 && (state.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return [];
}

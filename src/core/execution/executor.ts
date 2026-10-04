/**
 * Executor —— 执行单个步骤（经 `RuntimeAdapter`，红线 13：内核只依赖接口）。
 *
 * 职责边界：
 * - 负责状态机流转（ready → running → done/failed/awaiting_user）与事件下发；
 * - **不解析步骤结果的语义**：结果如何渲染由领域的 `stepRenderers.toProps` 决定，
 *   内核只把 props 转成 JSON Patch 增量下发（`/items/-`，红线 7）。
 */
import type {
  JsonPatchOperation,
  StreamEvent,
} from '@/shared/stream/events';
import type { RunContext } from '@/shared/run/types';
import {
  makeIdempotencyKey,
  type Step,
  type StepResult,
} from '@/shared/plan/types';
import type { RuntimeAdapter, ToolCall, ToolOutcome } from '@/src/core/runtime/adapter';
import { observe, toStepResult, type Observation } from './observer';
import { getComponentDefinition, getStepRenderer, getTool } from '@/src/core/registry/domainRegistry';

export interface ExecutorDeps {
  runtime: RuntimeAdapter;
  emit: (event: StreamEvent) => void;
  domainId: string;
  /** 计划 id（事件需要它把步骤归到正确的计划上）。 */
  planId: string;
  /** 注入式 sleep：可测、可被中断。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** 组件 props 增量下发的间隔（ms），用于让"逐条长出"可见。 */
  streamDelayMs?: number;
}

export interface StepExecutionResult {
  step: Step;
  observation: Observation;
}

const DEFAULT_STREAM_DELAY_MS = 80;
const NOOP_SLEEP = async (): Promise<void> => undefined;

/**
 * 执行一个步骤。**不修改入参**：返回新的 Step 对象。
 *
 * `intent === null` 视为纯推理步骤，直接完成，不调工具。
 */
export async function executeStep(
  step: Step,
  ctx: RunContext,
  deps: ExecutorDeps,
): Promise<StepExecutionResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().getTime();
  const attempt = step.attempt + 1;

  let current: Step = {
    ...step,
    attempt,
    status: 'running',
    idempotencyKey: makeIdempotencyKey(ctx.runId, step.id, attempt),
    updatedAt: now().toISOString(),
  };
  deps.emit({
    type: 'step_status',
    planId: deps.planId,
    stepId: current.id,
    status: 'running',
    attempt,
  });

  // 纯推理步骤：没有工具意图，直接完成。
  if (current.intent === null) {
    const result: StepResult = {
      ok: true,
      data: { note: '纯推理步骤' },
      sourceRefs: [],
      isEstimate: false,
      durationMs: 0,
    };
    current = {
      ...current,
      status: 'done',
      result,
      updatedAt: now().toISOString(),
    };
    deps.emit({
      type: 'step_status',
      planId: deps.planId,
      stepId: current.id,
      status: 'done',
      attempt,
    });
    return { step: current, observation: { kind: 'success', stepId: current.id } };
  }

  const tool = getTool(deps.domainId, current.intent.toolName);
  if (!tool) {
    const finished = now().getTime();
    const outcome: ToolOutcome = {
      ok: false,
      sourceRefs: [],
      isEstimate: false,
      durationMs: finished - startedAt,
      error: {
        code: 'TOOL_FAILED',
        message: '工具未在当前领域注册',
        retryable: false,
        traceId: ctx.traceId,
      },
    };
    return finalize(current, outcome, ctx, deps, startedAt);
  }

  const call: ToolCall = {
    stepId: current.id,
    toolName: tool.name,
    input: current.intent.input,
    idempotencyKey: current.idempotencyKey,
    attempt,
    timeoutMs: tool.timeoutMs,
    producesFacts: current.intent.producesFacts,
  };

  let outcome: ToolOutcome;
  try {
    outcome = await withTimeout(
      deps.runtime.runTool(call, ctx),
      tool.timeoutMs,
      () => ({
        ok: false,
        sourceRefs: [],
        isEstimate: false,
        durationMs: tool.timeoutMs,
        error: {
          code: 'TOOL_TIMEOUT' as const,
          message: '工具调用超时',
          retryable: true,
          traceId: ctx.traceId,
        },
      }),
    );
  } catch (error) {
    outcome = {
      ok: false,
      sourceRefs: [],
      isEstimate: false,
      durationMs: now().getTime() - startedAt,
      error: {
        code: 'TOOL_FAILED',
        message: error instanceof Error ? error.message : '工具调用抛出异常',
        retryable: true,
        traceId: ctx.traceId,
      },
    };
  }

  return finalize(current, outcome, ctx, deps, startedAt);
}

/** 统一收尾：写状态机 → 下发结果组件 → 返回 Observation。 */
async function finalize(
  step: Step,
  outcome: ToolOutcome,
  ctx: RunContext,
  deps: ExecutorDeps,
  startedAtMs: number,
): Promise<StepExecutionResult> {
  const now = deps.now ?? (() => new Date());
  const durationMs = Math.max(0, now().getTime() - startedAtMs);
  const observation = observe(step, outcome);
  const result = toStepResult(outcome, outcome.durationMs || durationMs);

  let next: Step = { ...step, result, updatedAt: now().toISOString() };

  switch (observation.kind) {
    case 'success': {
      next = { ...next, status: 'done' };
      break;
    }
    case 'retry': {
      // 保持可调度状态，由上层决定 attempt+1 后重跑。
      next = { ...next, status: 'pending', error: observation.error };
      break;
    }
    case 'clarify': {
      next = { ...next, status: 'awaiting_user', error: observation.error };
      break;
    }
    case 'fail':
    default: {
      next = { ...next, status: 'failed', error: observation.error };
      break;
    }
  }

  deps.emit({
    type: 'step_status',
    planId: deps.planId,
    stepId: next.id,
    status: next.status,
    attempt: next.attempt,
    reason: observation.trigger,
  });

  if (observation.kind === 'success') {
    const nodeIds = await emitResultComponents(next, result.data, ctx, deps);
    next = { ...next, emittedNodeIds: [...next.emittedNodeIds, ...nodeIds] };
  }

  return { step: next, observation };
}

/**
 * 把步骤结果映射为组件节点并流式下发。
 *
 * 组件名与 props 均由领域的 `stepRenderers` 提供，内核**只做转发**；
 * 组件未注册时降级为内核通用的 `RawPayloadCard`（绝不白屏）。
 */
export async function emitResultComponents(
  step: Step,
  data: unknown,
  ctx: RunContext,
  deps: ExecutorDeps,
): Promise<string[]> {
  const sleep = deps.sleep ?? NOOP_SLEEP;
  const delay = deps.streamDelayMs ?? DEFAULT_STREAM_DELAY_MS;
  const renderer = getStepRenderer(deps.domainId, step.type);
  const nodeId = `node-${step.id}-a${step.attempt}`;

  if (!renderer) return [];

  const known = getComponentDefinition(deps.domainId, renderer.component) !== undefined;
  const component = known ? renderer.component : 'RawPayloadCard';

  deps.emit({
    type: 'component_start',
    nodeId,
    component,
    stepId: step.id,
    traceId: ctx.traceId,
  });

  const props = known
    ? renderer.toProps(data, step, ctx)
    : { title: step.title, payload: data, reason: '组件未注册', traceId: ctx.traceId };

  for (const operation of propsToPatches(props)) {
    await sleep(delay);
    deps.emit({ type: 'component_props_delta', nodeId, patch: [operation] });
  }

  deps.emit({ type: 'component_end', nodeId, status: known ? 'ready' : 'degraded' });
  return [nodeId];
}

/**
 * props → JSON Patch 增量。
 * 数组字段先建父节点 `add /<key> = []`，再逐项 `add /<key>/-`（列表逐条长出）；
 * 标量字段 `add /<key>`。**只发一遍，绝不整包重发**（红线 7）。
 *
 * ★ **为什么一律用 `add` 而不是 `replace`**：消费方（CopilotKit v2 / AG-UI）按
 * **严格 RFC 6902** 应用补丁，起点是 `component_start` 下发的空对象 `{}`：
 *   - `replace` 要求目标路径**已存在**，打在 `{}` 上必然失败；
 *   - `add /<key>/-` 要求 `/<key>` **已存在且是数组**，直接打在 `{}` 上同样失败。
 * `add` 到对象成员在 RFC 6902 里等价于写入，且这条补丁流从空对象开始，
 * 因此不存在"覆盖已有值"的语义差别。结果：**澄清卡片曾因这两条规则一条
 * props 都打不上，且不报错 —— 只剩一行 console 警告**（见 AG-UI 端点修复记录）。
 *
 * ★ 旧前端 `src/features/run/nodeReducer.ts` 的 `applyPatch` 对对象成员上的
 * `add` / `replace` 处理完全相同（`record[last] = operation.value`），
 * 且父节点缺失时会自动创建，因此本次改动对旧路径**零行为差异**。
 *
 * ★ 空数组**必须**建父节点：`options: []` / `fields: []` 是合法且需要存在的键，
 * 否则消费方的 props 完整性判定会认为字段缺失。
 */
export function propsToPatches(props: Record<string, unknown>): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      operations.push({ op: 'add', path: `/${key}`, value: [] });
      for (const item of value) {
        operations.push({ op: 'add', path: `/${key}/-`, value: item });
      }
      continue;
    }
    operations.push({ op: 'add', path: `/${key}`, value });
  }
  return operations;
}

/** 超时竞速：超时返回兜底结果，绝不无限等待。 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 组件事件、失败收尾与终态事件。
 *
 * 把原来挤在 `engine.ts` 里的 `emitComponent` / `finish` / `failRun` / `askUserForValidation`
 * 收拢到这里，通过 `createRunEvents(sink)` 注入 `emit` / `sleep` / `traceId` 后再返回绑定好的函数。
 * 这样内核的事件出口只有一处，且**不读取任何模块级闭包状态**——传入什么就发什么。
 *
 * ★ 失败事件顺序不变式（改动前请看懂再动）：`failRun` 里 `error` 是本轮对外的**终态**事件，
 * 传输层把它翻成协议终态之后，客户端会拒收它后面的**任何**事件（含组件增量，
 * 实测报错形如 "The run has already errored ... No further events can be sent"）。
 * 所以凡是想让用户看见的东西（错误卡片三连 + `plan_status`）必须排在 `error` 之前；
 * `error` 之后只剩 `finish()` 那条内核记账用的终态事件，它在协议侧会被终态互斥规则丢弃。
 * 即客户端看到的最后一个事件就是 `error`，而错误卡片已在 `error` 之前完整送达。
 */
import type { StreamEvent } from '@/shared/stream/events';
import type { Plan } from '@/shared/plan/types';
import type { RunTerminalStatus } from '@/shared/run/types';
import type { EngineResult } from '@/src/core/run/engine';
import { propsToPatches } from '@/src/core/execution/executor';

const DEFAULT_COMPONENT_DELAY_MS = 60;

/** 事件出口注入点：全部来自运行时，模块本身不持有状态。 */
export interface RunEventSink {
  emit: (event: StreamEvent) => void;
  sleep: (ms: number) => Promise<void>;
  traceId: string;
}

export interface EmitComponentOptions {
  nodeId: string;
  component: string;
  props: Record<string, unknown>;
  endStatus?: 'ready' | 'degraded' | 'error';
}

/**
 * 创建一个绑定好 `emit` / `sleep` / `traceId` 的事件集合。
 *
 * 返回的函数语义与 `engine.ts` 原有闭包**逐字一致**，只是把依赖显式传进来，
 * 便于在 `executionLoop` / `replanCoordinator` 等模块间复用同一套事件出口。
 */
export function createRunEvents(sink: RunEventSink) {
  const { emit, sleep, traceId } = sink;

  /** 统一下发组件节点：start → 逐条 props 增量 → end。 */
  const emitComponent = async (options: EmitComponentOptions): Promise<void> => {
    emit({
      type: 'component_start',
      nodeId: options.nodeId,
      component: options.component,
      traceId,
    });
    for (const operation of propsToPatches(options.props)) {
      await sleep(DEFAULT_COMPONENT_DELAY_MS);
      emit({ type: 'component_props_delta', nodeId: options.nodeId, patch: [operation] });
    }
    emit({
      type: 'component_end',
      nodeId: options.nodeId,
      status: options.endStatus ?? 'ready',
    });
  };

  const finish = (status: RunTerminalStatus, plan: Plan | null, reason?: string): EngineResult => {
    emit({
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
   * 失败收尾：先把要展示的内容发完，最后才发终态事件（见文件头注释的顺序不变式）。
   */
  const failRun = async (plan: Plan | null, message: string, reason: string): Promise<EngineResult> => {
    await emitComponent({
      nodeId: `node-error-${traceId}`,
      component: 'ErrorState',
      props: { title: '这一轮没能跑完', message, traceId, recoverable: true },
      endStatus: 'error',
    });
    if (plan) {
      emit({
        type: 'plan_status',
        planId: plan.id,
        status: 'failed',
        revision: plan.revision,
      });
    }
    emit({ type: 'error', traceId, message, recoverable: false });
    return finish('failed', plan, reason);
  };

  /**
   * 校验不通过且无法自动修复 → **转人工**（下发 ClarifyOptions，绝不白屏）。
   * 只给通用选项：内核不知道"该怎么改"是领域的事。
   */
  const askUserForValidation = async (plan: Plan, prompt: string): Promise<EngineResult> => {
    const paused: Plan = { ...plan, status: 'paused' };
    emit({ type: 'plan_status', planId: paused.id, status: 'paused', revision: paused.revision });
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
    return finish('awaiting_user', paused, 'VALIDATION_ASK_USER');
  };

  return { emitComponent, finish, failRun, askUserForValidation };
}

export type RunEvents = ReturnType<typeof createRunEvents>;

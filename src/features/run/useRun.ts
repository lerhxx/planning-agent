'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Attachment, EditCommand, Plan } from '@/shared/plan/types';
import { zStreamEvent, type StreamEvent } from '@/shared/stream/events';
import type { RunTerminalStatus } from '@/shared/run/types';
import { useCoalescedNodes } from './useCoalescedNodes';
import type { ComponentNode } from './nodeReducer';

export type RunPhase = 'idle' | 'streaming' | RunTerminalStatus;

export interface RunState {
  phase: RunPhase;
  plan: Plan | null;
  nodes: ComponentNode[];
  traceId: string;
  message: string;
  eventCount: number;
}

export interface StartInput {
  goal: string;
  domainId?: string;
  simulate?: 'none' | 'retryable' | 'fatal' | 'clarify';
  /** MockRuntime 调试旋钮：重排时"换方案"还是"原样重发"。 */
  replanMode?: 'diverge' | 'stagnant';
  requireConstraints?: boolean;
  answers?: Record<string, string>;
  /**
   * 本轮输入附件描述符。**只透传不解析**：本 hook 不认识附件的任何语义，
   * 也不读字节（字节已由 `/api/assets` 先落地）。
   */
  attachments?: Attachment[];
  /**
   * 续跑：带上一次的 plan 快照。不传 = 从目标重新规划一轮。
   * 与 `edit` 一起构成「先澄清/编辑，再原路重发」的恢复路径。
   */
  plan?: Plan | null;
  /** 续跑前要应用的编辑命令（只在 run 终态生效）。 */
  edit?: EditCommand | null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toPhase(status: RunTerminalStatus): RunPhase {
  return status;
}

/**
 * SSE 客户端：POST `/api/run` → 逐帧 `safeParse` → 累积到 plan 与组件节点。
 *
 * 所有来自网络的事件都必须过 `zStreamEvent.safeParse`：
 * 坏帧直接丢弃（计数不中断），**绝不因为一帧脏数据白屏**。
 */
export function useRun(): {
  state: RunState;
  start: (input: StartInput) => Promise<void>;
  abort: () => void;
  reset: () => void;
} {
  const { nodes, enqueue, reset: resetNodes } = useCoalescedNodes(16);
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [traceId, setTraceId] = useState('');
  const [message, setMessage] = useState('');
  const [eventCount, setEventCount] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    resetNodes();
    setPlan(null);
    setPhase('idle');
    setTraceId('');
    setMessage('');
    setEventCount(0);
  }, [resetNodes]);

  const start = useCallback(
    async (input: StartInput): Promise<void> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      resetNodes();
      setPlan(null);
      setPhase('streaming');
      setMessage('');
      setEventCount(0);

      const applyEvent = (event: StreamEvent): void => {
        setEventCount((count) => count + 1);
        switch (event.type) {
          case 'plan_start':
            setPlan({
              id: event.planId,
              runId: event.runId,
              goalId: event.goalId,
              domainId: event.domainId,
              revision: event.revision,
              status: event.status,
              summary: event.summary,
              steps: [],
              createdAt: '',
              updatedAt: '',
            });
            break;
          case 'step_add':
            setPlan((previous) =>
              previous
                ? {
                    ...previous,
                    steps: [...previous.steps.filter((s) => s.id !== event.step.id), event.step],
                  }
                : previous,
            );
            break;
          case 'step_status':
            setPlan((previous) =>
              previous
                ? {
                    ...previous,
                    steps: previous.steps.map((step) =>
                      step.id === event.stepId
                        ? {
                            ...step,
                            status: event.status,
                            attempt: event.attempt ?? step.attempt,
                          }
                        : step,
                    ),
                  }
                : previous,
            );
            break;
          case 'plan_status':
            setPlan((previous) =>
              previous ? { ...previous, status: event.status, revision: event.revision } : previous,
            );
            break;
          case 'component_start':
          case 'component_props_delta':
          case 'component_end':
            enqueue(event);
            break;
          case 'error':
            setMessage(event.message);
            break;
          case 'done':
            setTraceId(event.traceId);
            setPhase(toPhase(event.status));
            if (event.reason) setMessage(event.reason);
            break;
          default:
            break;
        }
      };

      try {
        const response = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            goal: input.goal,
            domainId: input.domainId,
            simulate: input.simulate ?? 'none',
            replanMode: input.replanMode ?? 'diverge',
            requireConstraints: input.requireConstraints ?? false,
            answers: input.answers ?? {},
            attachments: input.attachments ?? [],
            plan: input.plan ?? null,
            edit: input.edit ?? null,
          }),
        });

        if (!response.ok || !response.body) {
          setPhase('failed');
          setMessage(`请求失败：HTTP ${response.status}`);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const line = frame.split('\n').find((item) => item.startsWith('data:')) ?? '';
            const payload = line.slice('data:'.length).trim();
            if (payload.length === 0) continue;
            const parsed = zStreamEvent.safeParse(safeJson(payload));
            if (!parsed.success) continue; // 坏帧丢弃，不中断
            applyEvent(parsed.data);
          }
        }

        setPhase((current) => (current === 'streaming' ? 'completed' : current));
      } catch (error) {
        if (controller.signal.aborted) {
          setPhase('aborted');
        } else {
          setPhase('failed');
          setMessage(error instanceof Error ? error.message : '未知错误');
        }
      }
    },
    [enqueue, resetNodes],
  );

  const abort = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const state = useMemo<RunState>(
    () => ({ phase, plan, nodes, traceId, message, eventCount }),
    [phase, plan, nodes, traceId, message, eventCount],
  );

  return { state, start, abort, reset };
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StreamEvent } from '@/shared/stream/events';
import {
  applyNodeEvent,
  initialNodeState,
  toNodeList,
  type ComponentNode,
  type NodeState,
} from './nodeReducer';

/**
 * 16ms 合批：高频 `component_props_delta` 先入队，再按帧刷新，
 * 避免每个 patch 都触发一次 React 重渲染。
 */
export function useCoalescedNodes(flushMs = 16): {
  nodes: ComponentNode[];
  enqueue: (event: StreamEvent) => void;
  reset: () => void;
} {
  const [state, setState] = useState<NodeState>(initialNodeState);
  const pending = useRef<StreamEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const events = pending.current;
    pending.current = [];
    if (events.length === 0) return;
    setState((previous) => events.reduce(applyNodeEvent, previous));
  }, []);

  const enqueue = useCallback(
    (event: StreamEvent) => {
      pending.current.push(event);
      if (timer.current === null) {
        timer.current = setTimeout(flush, flushMs);
      }
    },
    [flush, flushMs],
  );

  const reset = useCallback(() => {
    pending.current = [];
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setState(initialNodeState);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const nodes = useMemo(() => toNodeList(state), [state]);
  return { nodes, enqueue, reset };
}

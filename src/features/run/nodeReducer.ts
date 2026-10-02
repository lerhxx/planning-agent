/**
 * 组件节点的 props 累积器 —— 纯函数，可单测。
 *
 * 流式增量统一用 RFC 6902 JSON Patch：列表追加 `{"op":"add","path":"/items/-"}`，
 * **绝不整包重发 props**（红线 7）。
 */
import type { JsonPatchOperation, StreamEvent } from '@/shared/stream/events';

export type ComponentNodeStatus = 'streaming' | 'ready' | 'degraded' | 'error';

export interface ComponentNode {
  nodeId: string;
  component: string;
  stepId?: string;
  traceId?: string;
  status: ComponentNodeStatus;
  props: Record<string, unknown>;
}

export interface NodeState {
  order: string[];
  nodes: Record<string, ComponentNode>;
}

export const initialNodeState: NodeState = { order: [], nodes: {} };

/** JSON 安全深拷贝（props 一定是可序列化的）。 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepClone(item);
    }
    return out as T;
  }
  return value;
}

function isIndexPart(part: string): boolean {
  return part === '-' || /^\d+$/.test(part);
}

function toIndex(part: string): number {
  const value = Number(part);
  return Number.isFinite(value) ? value : 0;
}

type Container = Record<string, unknown> | unknown[];

/** 下钻一层：目标缺失时按下一段的形状自动补 `[]` 或 `{}`。 */
function descend(cursor: Container, part: string, nextPart: string): Container {
  const created = (): Container => (isIndexPart(nextPart) ? [] : {});

  if (Array.isArray(cursor)) {
    const index = part === '-' ? cursor.length - 1 : toIndex(part);
    const child = cursor[index];
    if (child === null || typeof child !== 'object') {
      cursor[index] = created();
      return cursor[index] as Container;
    }
    return child as Container;
  }

  const record = cursor as Record<string, unknown>;
  const child = record[part];
  if (child === null || typeof child !== 'object') {
    record[part] = created();
    return record[part] as Container;
  }
  return child as Container;
}

/** 应用一条 JSON Patch 到 props（不可变）。 */
export function applyPatch(
  props: Record<string, unknown>,
  operation: JsonPatchOperation,
): Record<string, unknown> {
  const next = deepClone(props);
  const parts = operation.path.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) return next;

  let cursor: Container = next;
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = descend(cursor, parts[index], parts[index + 1]);
  }
  const last = parts[parts.length - 1];

  if (Array.isArray(cursor)) {
    if (last === '-') cursor.push(operation.value);
    else if (operation.op === 'remove') cursor.splice(toIndex(last), 1);
    else cursor[toIndex(last)] = operation.value;
    return next;
  }

  const record = cursor as Record<string, unknown>;
  if (last === '-') return next; // 防御：对象上没有 `-` 语义
  if (operation.op === 'remove') delete record[last];
  else record[last] = operation.value;
  return next;
}

/** 应用一条流式事件到节点状态（不可变）。未知事件原样返回。 */
export function applyNodeEvent(state: NodeState, event: StreamEvent): NodeState {
  switch (event.type) {
    case 'component_start': {
      if (state.nodes[event.nodeId]) return state;
      return {
        order: [...state.order, event.nodeId],
        nodes: {
          ...state.nodes,
          [event.nodeId]: {
            nodeId: event.nodeId,
            component: event.component,
            stepId: event.stepId,
            traceId: event.traceId,
            status: 'streaming',
            props: {},
          },
        },
      };
    }

    case 'component_props_delta': {
      const current = state.nodes[event.nodeId];
      if (!current) return state;
      const props = event.patch.reduce<Record<string, unknown>>(
        (accumulator, operation) => applyPatch(accumulator, operation),
        current.props,
      );
      return {
        order: state.order,
        nodes: { ...state.nodes, [event.nodeId]: { ...current, props } },
      };
    }

    case 'component_end': {
      const current = state.nodes[event.nodeId];
      if (!current) return state;
      return {
        order: state.order,
        nodes: {
          ...state.nodes,
          [event.nodeId]: { ...current, status: event.status },
        },
      };
    }

    default:
      return state;
  }
}

/** 顺序化输出（供渲染）。 */
export function toNodeList(state: NodeState): ComponentNode[] {
  return state.order
    .map((nodeId) => state.nodes[nodeId])
    .filter((node): node is ComponentNode => node !== undefined);
}

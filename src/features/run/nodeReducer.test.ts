import { describe, expect, it } from 'vitest';
import {
  applyNodeEvent,
  applyPatch,
  initialNodeState,
  toNodeList,
  type NodeState,
} from './nodeReducer';

describe('applyPatch（JSON Patch 累积）', () => {
  it('列表追加：`/items/-` 逐条长出', () => {
    let props: Record<string, unknown> = {};
    props = applyPatch(props, { op: 'add', path: '/items/-', value: { id: 'a' } });
    props = applyPatch(props, { op: 'add', path: '/items/-', value: { id: 'b' } });
    expect(props['items']).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('标量替换：`/title`', () => {
    const props = applyPatch({}, { op: 'replace', path: '/title', value: '你好' });
    expect(props['title']).toBe('你好');
  });

  it('不改动入参（不可变）', () => {
    const before = { items: [{ id: 'a' }] };
    const after = applyPatch(before, { op: 'add', path: '/items/-', value: { id: 'b' } });
    expect(before.items).toHaveLength(1);
    expect((after['items'] as unknown[])).toHaveLength(2);
  });

  it('remove 操作', () => {
    const props = applyPatch({ title: 'x' }, { op: 'remove', path: '/title' });
    expect(props['title']).toBeUndefined();
  });

  it('嵌套路径自动创建父级', () => {
    const props = applyPatch({}, { op: 'replace', path: '/meta/label', value: 'L' });
    expect(props['meta']).toEqual({ label: 'L' });
  });
});

describe('applyNodeEvent', () => {
  it('start → delta → end 的完整生命周期', () => {
    let state: NodeState = initialNodeState;

    state = applyNodeEvent(state, {
      type: 'component_start',
      nodeId: 'n1',
      component: 'FactList',
      stepId: 's-1',
      traceId: 't1',
    });
    expect(toNodeList(state)).toHaveLength(1);
    expect(state.nodes['n1'].status).toBe('streaming');
    expect(state.nodes['n1'].stepId).toBe('s-1');

    state = applyNodeEvent(state, {
      type: 'component_props_delta',
      nodeId: 'n1',
      patch: [{ op: 'replace', path: '/title', value: '采集结果' }],
    });
    expect(state.nodes['n1'].props['title']).toBe('采集结果');

    state = applyNodeEvent(state, {
      type: 'component_props_delta',
      nodeId: 'n1',
      patch: [{ op: 'add', path: '/items/-', value: { id: 'f1' } }],
    });
    expect(state.nodes['n1'].props['items']).toEqual([{ id: 'f1' }]);

    state = applyNodeEvent(state, { type: 'component_end', nodeId: 'n1', status: 'ready' });
    expect(state.nodes['n1'].status).toBe('ready');
  });

  it('未知 nodeId 的 delta 被忽略，不崩', () => {
    const state = applyNodeEvent(initialNodeState, {
      type: 'component_props_delta',
      nodeId: 'ghost',
      patch: [{ op: 'replace', path: '/title', value: 'x' }],
    });
    expect(state).toEqual(initialNodeState);
  });

  it('重复 start 不覆盖已有节点', () => {
    let state = applyNodeEvent(initialNodeState, {
      type: 'component_start',
      nodeId: 'n1',
      component: 'FactList',
    });
    state = applyNodeEvent(state, {
      type: 'component_props_delta',
      nodeId: 'n1',
      patch: [{ op: 'replace', path: '/title', value: 'keep' }],
    });
    state = applyNodeEvent(state, {
      type: 'component_start',
      nodeId: 'n1',
      component: 'FactList',
    });
    expect(state.nodes['n1'].props['title']).toBe('keep');
    expect(state.order).toEqual(['n1']);
  });

  it('非组件事件原样返回', () => {
    const state = applyNodeEvent(initialNodeState, {
      type: 'plan_start',
      planId: 'p',
      runId: 'r',
      goalId: 'g',
      domainId: 'd',
      revision: 1,
      status: 'draft',
      summary: '',
    });
    expect(state).toEqual(initialNodeState);
  });
});

/**
 * P3 · 澄清表单的五层防漏（设计文档 §4.3）。
 *
 * 背景（探针实测）：`shared` 里新增一个要透传到 UI 的键，需要**同一个 PR 内改 3 处**
 * —— `shared/**` schema → 组件 schema → `requiredProps`。
 * 而漏掉任意一处，在 `npm test` 下都是**绿的**：
 * - 漏组件 schema → zod 默认 strip，`fields` 被**静默丢弃**；
 * - 漏 `requiredProps` → 表单模式永久 skeleton，表单**永远不渲染**。
 *
 * 五层：
 * - L1 键集合同源守卫（契约新增键而组件忘了加 → 立刻红）
 * - L2 strip 反向断言（把"静默丢弃"变成红灯）
 * - L3 端到端刻画（生产 → 传输 → 消费全链）
 * - L4 表单模式必须渲染（探针 P3 点名要的）
 * - L5 `submit_form` 动作契约
 */
import { describe, expect, it } from 'vitest';
import { makeFormKey, zClarifyQuestion } from '@/shared/plan/types';
import { zClarifyOptionsProps, zComponentAction } from '@/src/components/generative-ui/ClarifyOptions/schema';
import { registerCoreUIComponents } from '@/src/components/generative-ui/coreComponents';
import { resolveComponent } from '@/src/components/generative-ui/registry';
import { isPropsComplete } from '@/src/core/degrade/policy';
import { applyNodeEvent, initialNodeState, toNodeList } from '@/src/features/run/nodeReducer';
import type { JsonPatchOperation } from '@/shared/stream/events';

const FIELD_A = { id: 'days', kind: 'number', label: '几天', required: true };
const FIELD_B = { id: 'budget', kind: 'text', label: '预算' };

function fieldPatch(value: unknown): JsonPatchOperation {
  return { op: 'add', path: '/fields/-', value };
}

describe('L1 · 键集合同源守卫', () => {
  it('契约里每个要透传的键，组件 schema 里都有', () => {
    const propsKeys = new Set(Object.keys(zClarifyOptionsProps.shape));
    const missing = Object.keys(zClarifyQuestion.shape).filter((key) => !propsKeys.has(key));

    // `id` 以 `questionId` 的名字透传（改名，不是漏）；`multi` 由组件按 kind 处理。
    const allowed = new Set(['id', 'multi']);
    expect(missing.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it('反向：组件 schema 不得凭空多出契约没有的键（traceId 是传输字段，放行）', () => {
    const questionKeys = new Set(Object.keys(zClarifyQuestion.shape));
    const extra = Object.keys(zClarifyOptionsProps.shape).filter(
      (key) => !questionKeys.has(key) && !['questionId', 'traceId'].includes(key),
    );
    expect(extra).toEqual([]);
  });
});

describe('L2 · strip 反向断言', () => {
  it('fields 不会被 zod 默认 strip 掉', () => {
    const parsed = zClarifyOptionsProps.parse({
      questionId: 'q',
      prompt: 'p',
      fields: [FIELD_A],
    });
    expect(Object.keys(parsed)).toContain('fields');
    expect(parsed.fields).toHaveLength(1);
    expect(parsed.fields[0].id).toBe('days');
  });

  it('字段里的约束（min/max/pattern）也一并到达（内核只透传不解析）', () => {
    const parsed = zClarifyOptionsProps.parse({
      questionId: 'q',
      prompt: 'p',
      fields: [{ id: 'days', kind: 'number', label: '几天', min: 1, max: 10, pattern: '^\\d+$' }],
    });
    expect(parsed.fields[0].min).toBe(1);
    expect(parsed.fields[0].max).toBe(10);
    expect(parsed.fields[0].pattern).toBe('^\\d+$');
  });
});

describe('L3 · 端到端刻画（生产 → 传输 → 消费）', () => {
  it('两条 /fields/- patch 后，累积 props 能过 schema 且长度为 2', () => {
    let state = applyNodeEvent(initialNodeState, {
      type: 'component_start',
      nodeId: 'n1',
      component: 'ClarifyOptions',
      traceId: 'trace-1',
    });
    state = applyNodeEvent(state, {
      type: 'component_props_delta',
      nodeId: 'n1',
      patch: [fieldPatch(FIELD_A)],
    });
    state = applyNodeEvent(state, {
      type: 'component_props_delta',
      nodeId: 'n1',
      patch: [fieldPatch(FIELD_B)],
    });

    const node = toNodeList(state)[0];
    expect(node).toBeDefined();
    const parsed = zClarifyOptionsProps.safeParse(node!.props);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.fields).toHaveLength(2);
  });
});

describe('L4 · 表单模式必须渲染（不是永久骨架）', () => {
  it('表单模式（有 fields 无 options）算 props 补齐', () => {
    registerCoreUIComponents();
    const definition = resolveComponent('', 'ClarifyOptions');
    expect(definition).toBeDefined();

    expect(
      isPropsComplete(
        { questionId: 'q', prompt: 'p', fields: [FIELD_A] },
        definition!.requiredProps,
      ),
    ).toBe(true);
  });

  it('选项模式不回归', () => {
    registerCoreUIComponents();
    const definition = resolveComponent('', 'ClarifyOptions');
    expect(
      isPropsComplete(
        { questionId: 'q', prompt: 'p', options: [{ id: 'a', label: 'A' }] },
        definition!.requiredProps,
      ),
    ).toBe(true);
  });

  it('缺 prompt 仍然骨架（requiredProps 真的在起作用）', () => {
    registerCoreUIComponents();
    const definition = resolveComponent('', 'ClarifyOptions');
    expect(
      isPropsComplete({ questionId: 'q', fields: [FIELD_A] }, definition!.requiredProps),
    ).toBe(false);
  });
});

describe('L5 · submit_form 动作契约', () => {
  it('submit_form + values 能过校验', () => {
    const parsed = zComponentAction.safeParse({
      type: 'submit_form',
      questionId: 'clarify:tool:s-1',
      values: { days: '3', unresolved_action: JSON.stringify(['skip']) },
    });
    expect(parsed.success).toBe(true);
  });

  it('回灌键由 makeFormKey 生成，与 K3 约定一致', () => {
    const values = { days: '3' };
    const answers: Record<string, string> = {};
    for (const [fieldId, value] of Object.entries(values)) {
      answers[makeFormKey('clarify:tool:s-1', fieldId)] = value;
    }
    expect(answers).toEqual({ 'clarify:tool:s-1::days': '3' });
  });
});

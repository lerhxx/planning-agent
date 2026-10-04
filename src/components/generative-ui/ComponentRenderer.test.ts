// @vitest-environment jsdom
/**
 * `ComponentRenderer` 的字段型卡片回调桥接（`toFieldCallbacks`）。
 *
 * 盯的是这条红线：字段卡（CalendarField / ChoiceGroupField）收 `onConfirm`/`onSkip`，
 * 而渲染器只给 `onAction` —— 不桥接的话**点了确认什么都不发生、还不报错**。
 * 所以这里的断言都是"动作真的被产出并被下游消费"，不是"没抛错"。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';

/**
 * 本文件只用 `aguiRenderers` 的纯函数 `planAnswers`，但那个模块**运行时**会
 * `import { useCopilotKit } from '@copilotkit/react-core/v2'`，而该包的入口
 * `import './index.css'` —— node/vitest 加载不了 `.css`（`ERR_UNKNOWN_FILE_EXTENSION`，
 * 全量跑会让整条 suite 挂掉）。所以这里把它桩掉；这两份用例压根不需要真的
 * CopilotKit，只需要模块能被加载。（同款处理见 `aguiRenderers.test.ts`。）
 */
vi.mock('@copilotkit/react-core/v2', () => ({
  useCopilotKit: () => ({
    copilotkit: { runAgent: async () => ({}) },
    executingToolCallIds: new Set<string>(),
  }),
}));

import ComponentRenderer, {
  toFieldCallbacks,
  type RenderableNode,
} from './ComponentRenderer';
import { planAnswers } from './aguiRenderers';
import { registerCoreUIComponents } from './coreComponents';
import { makeFormKey } from '@/shared/plan/types';
import type { ComponentAction } from './ClarifyOptions/schema';

function makeNode(props: Record<string, unknown>): RenderableNode {
  return { nodeId: 'node-1', component: 'CalendarField', props, status: 'ready' };
}

afterEach(() => {
  cleanup();
});

describe('toFieldCallbacks', () => {
  it('没有 onAction → 不产出回调（空壳回调比没有回调更糟）', () => {
    // 产出一对什么都不做的 onConfirm/onSkip 会让"点击看起来成功了" —— 那正是静默失效。
    expect(toFieldCallbacks(makeNode({}))).toEqual({});
    expect(toFieldCallbacks(makeNode({}), undefined)).toEqual({});
  });

  it('★ onConfirm 产出 submit_form，且下游 planAnswers 的键是 makeFormKey(questionId, fieldId)', () => {
    const actions: ComponentAction[] = [];
    const node = makeNode({ questionId: 'clarify:travel.trip-brief', fieldId: 'days' });

    toFieldCallbacks(node, (action) => actions.push(action)).onConfirm?.('3');

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: 'submit_form',
      questionId: 'clarify:travel.trip-brief',
      values: { days: '3' },
    });

    // ★ 端到端：交给 planAnswers 必须 ok，且键正是领域 tools.ts 的读法。
    const plan = planAnswers(actions[0]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.answers[makeFormKey('clarify:travel.trip-brief', 'days')]).toBe('3');
  });

  it('非字符串值按 K3 用 JSON 编码（不是 String(value) 丢成 [object Object]）', () => {
    const actions: ComponentAction[] = [];
    const node = makeNode({ questionId: 'clarify:tool:s-1', fieldId: 'days' });

    toFieldCallbacks(node, (a) => actions.push(a)).onConfirm?.({ mode: 'single', date: '2026-05-01' });

    expect(actions[0].values).toEqual({ days: '{"mode":"single","date":"2026-05-01"}' });
  });

  it('fieldId 回退链：fieldId → id → value', () => {
    for (const [props, expected] of [
      [{ questionId: 'q', fieldId: 'a' }, 'a'],
      [{ questionId: 'q', id: 'b' }, 'b'],
      [{ questionId: 'q' }, 'value'],
    ] as const) {
      const actions: ComponentAction[] = [];
      toFieldCallbacks(makeNode({ ...props }), (a) => actions.push(a)).onConfirm?.('x');
      expect(Object.keys(actions[0].values ?? {})).toEqual([expected]);
    }
  });

  it('★ questionId 缺失：照样产出回调，但下游 planAnswers 判 ok:false（不静默吞点击）', () => {
    const actions: ComponentAction[] = [];
    toFieldCallbacks(makeNode({}), (a) => actions.push(a)).onConfirm?.('3');

    // ① 回调**存在** —— 用户的点击没有被这一层吞掉。
    expect(actions).toHaveLength(1);
    // ② 但它发不出去，且给出原因。
    const plan = planAnswers(actions[0]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('makeFormKey');
  });

  it('onSkip 产出 values 为空的 submit_form', () => {
    const actions: ComponentAction[] = [];
    const node = makeNode({ questionId: 'clarify:tool:s-1', fieldId: 'days' });

    toFieldCallbacks(node, (a) => actions.push(a)).onSkip?.();

    expect(actions[0]).toEqual({
      type: 'submit_form',
      questionId: 'clarify:tool:s-1',
      values: {},
    });
  });

  it('questionId 不是非空字符串时按缺失处理（不把 0 / 空串当键）', () => {
    for (const questionId of ['', 0, null, {}]) {
      const actions: ComponentAction[] = [];
      toFieldCallbacks(makeNode({ questionId, fieldId: 'days' }), (a) => actions.push(a)).onConfirm?.(
        '3',
      );
      expect(actions[0].questionId, `questionId=${String(questionId)}`).toBeUndefined();
    }
  });
});

describe('桥接真的接上了（渲染层集成）', () => {
  it('★ ChoiceGroupField 点确认 → onAction 收到 submit_form（不是点了没反应）', async () => {
    registerCoreUIComponents();
    const onAction = vi.fn();

    render(
      createElement(ComponentRenderer, {
        node: {
          nodeId: 'node-1',
          component: 'ChoiceGroupField',
          props: {
            questionId: 'clarify:travel.trip-brief',
            fieldId: 'style',
            groups: [
              { id: 'g1', title: '偏好', options: [{ id: 'o1', label: '方案一' }] },
            ],
          },
          status: 'ready',
        },
        domainId: '',
        onAction,
      }),
    );

    fireEvent.click(await screen.findByText('方案一'));
    fireEvent.click(await screen.findByText('确认'));

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledTimes(1);
    });
    const action = onAction.mock.calls[0]![0] as ComponentAction;
    expect(action.type).toBe('submit_form');
    expect(action.questionId).toBe('clarify:travel.trip-brief');
    // 值是 Record<groupId, optionId[]>，按 K3 JSON 编码。
    expect(action.values).toEqual({ style: '{"g1":["o1"]}' });

    const plan = planAnswers(action);
    expect(plan.ok).toBe(true);
  });
});

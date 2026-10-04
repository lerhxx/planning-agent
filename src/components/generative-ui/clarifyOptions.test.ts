// @vitest-environment jsdom
/**
 * 任务 2：`ClarifyOptions.renderControl` 接入两张字段卡。
 *
 * 断言标准是"管道真的吃到了"，不是"卡片渲染出来了"：
 * 一路走到 `onAction` 的 action → 再喂给 `planAnswers` → 断言键形与值都对。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * 与 `ComponentRenderer.test.ts` 同款处理：本文件只用 `aguiRenderers` 的纯函数
 * `planAnswers`，但该模块运行时会 import `@copilotkit/react-core/v2`（入口带
 * `import './index.css'`，node/vitest 加载不了），必须桩掉才能被加载。
 */
vi.mock('@copilotkit/react-core/v2', () => ({
  useCopilotKit: () => ({
    copilotkit: { runAgent: async () => ({}) },
    executingToolCallIds: new Set<string>(),
  }),
}));

import ClarifyOptions from './ClarifyOptions';
import { planAnswers } from './aguiRenderers';
import { zClarifyField, makeFormKey } from '@/shared/plan/types';
import type { ClarifyField } from '@/shared/plan/types';
import type { ComponentAction } from './ClarifyOptions/schema';

const QUESTION_ID = 'clarify:travel.trip-brief';

function fieldOf(partial: Record<string, unknown>): ClarifyField {
  return zClarifyField.parse({ id: 'f1', kind: 'text', label: '题', ...partial });
}

function renderForm(field: ClarifyField, onAction: (a: ComponentAction) => void) {
  return render(
    createElement(ClarifyOptions, {
      questionId: QUESTION_ID,
      prompt: '请补充',
      fields: [field],
      onAction,
    }),
  );
}

/** 日历里当月可选（未置灰）的日期格。 */
function clickableDays(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label]')).filter(
    (button) =>
      /^\d{4}-\d{2}-\d{2}$/.test(button.getAttribute('aria-label') ?? '') && !button.disabled,
  );
}

afterEach(() => {
  cleanup();
});

describe('renderControl · date → CalendarField', () => {
  it('★ 选一天 → 底部提交 → onAction 收到 YYYY-MM-DD，且下游键是 makeFormKey', () => {
    const onAction = vi.fn();
    const field = fieldOf({ id: 'deadline', kind: 'date', label: '出发日期' });

    const { container } = renderForm(field, onAction);

    const days = clickableDays(container);
    expect(days.length).toBeGreaterThan(0);
    fireEvent.click(days[3]!);

    fireEvent.click(screen.getByText('提交'));

    expect(onAction).toHaveBeenCalledTimes(1);
    const action = onAction.mock.calls[0]![0] as ComponentAction;
    expect(action.type).toBe('submit_form');
    expect(action.questionId).toBe(QUESTION_ID);
    // 组件层 values 的键是裸 fieldId（拼键统一在 planAnswers 一处做）。
    expect(action.values).toEqual({ deadline: days[3]!.getAttribute('aria-label') });
    expect(action.values?.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // ★ 端到端：下游 planAnswers 必须 ok，且键正是领域 tools.ts 的读法。
    const plan = planAnswers(action);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.answers[makeFormKey(QUESTION_ID, 'deadline')]).toBe(
      days[3]!.getAttribute('aria-label'),
    );
  });

  it('★ 反向锁：容器内不出现卡片自带的确认按钮（两个确认按钮的防线）', () => {
    const { container } = renderForm(
      fieldOf({ id: 'deadline', kind: 'date', label: '出发日期' }),
      vi.fn(),
    );
    // 只有容器自己的「提交」。
    expect(screen.getByText('提交')).toBeTruthy();
    expect(screen.queryByText('确认')).toBeNull();
    expect(screen.queryByText('暂不设置日期')).toBeNull();
    // 日历网格仍然在（只去掉了动作条）。
    expect(clickableDays(container).length).toBeGreaterThan(0);
  });

  it('只开单日期：不出现「灵活的天数」页签（否则会产生没有下游的 flexible 值）', () => {
    renderForm(fieldOf({ id: 'deadline', kind: 'date', label: '出发日期' }), vi.fn());
    expect(screen.queryByText('灵活的天数')).toBeNull();
    expect(screen.queryByText('具体日期')).toBeNull(); // tabs 只有一个 → 不渲染分段器
  });
});

describe('renderControl · multi / select → ChoiceGroupField', () => {
  const CHOICES = [
    { id: 'a', label: '选项A' },
    { id: 'b', label: '选项B' },
  ];

  it('★ multi 选两项 → 值是 JSON.stringify([...])，与 K4 / readMultiAnswer 对得上', () => {
    const onAction = vi.fn();
    renderForm(
      fieldOf({ id: 'tags', kind: 'multi', label: '偏好', options: CHOICES }),
      onAction,
    );

    fireEvent.click(screen.getByText('选项A'));
    fireEvent.click(screen.getByText('选项B'));
    fireEvent.click(screen.getByText('提交'));

    const action = onAction.mock.calls[0]![0] as ComponentAction;
    expect(action.values).toEqual({ tags: JSON.stringify(['a', 'b']) });
  });

  it('★ 端到端接回 planAnswers：ok 且键形正确', () => {
    const onAction = vi.fn();
    renderForm(
      fieldOf({ id: 'tags', kind: 'multi', label: '偏好', options: CHOICES }),
      onAction,
    );

    fireEvent.click(screen.getByText('选项A'));
    fireEvent.click(screen.getByText('提交'));

    const plan = planAnswers(onAction.mock.calls[0]![0] as ComponentAction);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.answers[makeFormKey(QUESTION_ID, 'tags')]).toBe(JSON.stringify(['a']));
  });

  it('select（单选）只存一个值，不存数组', () => {
    const onAction = vi.fn();
    renderForm(
      fieldOf({ id: 'level', kind: 'select', label: '档次', options: CHOICES }),
      onAction,
    );

    fireEvent.click(screen.getByText('选项B'));
    fireEvent.click(screen.getByText('提交'));

    const action = onAction.mock.calls[0]![0] as ComponentAction;
    expect(action.values).toEqual({ level: 'b' });
  });

  it('★ 反向锁：容器内不出现卡片自带的确认按钮', () => {
    renderForm(
      fieldOf({ id: 'tags', kind: 'multi', label: '偏好', options: CHOICES }),
      vi.fn(),
    );
    expect(screen.getByText('提交')).toBeTruthy();
    expect(screen.queryByText('确认')).toBeNull();
  });

  it('候选项为空 → 沿用「暂无候选项」，不渲染卡片', () => {
    renderForm(fieldOf({ id: 'tags', kind: 'multi', label: '偏好', options: [] }), vi.fn());
    expect(screen.getByText('暂无候选项')).toBeTruthy();
    expect(screen.queryByText('确认')).toBeNull();
  });
});

describe('renderControl · number / text 保留原生 input', () => {
  it('text 仍然是原生 input（自由文本换成卡片只会更难用）', () => {
    const { container } = renderForm(fieldOf({ id: 'note', kind: 'text', label: '备注' }), vi.fn());
    expect(container.querySelector('input[type="text"]')).toBeTruthy();
    expect(screen.queryByText('确认')).toBeNull();
  });

  it('number 仍然是原生 input', () => {
    const { container } = renderForm(
      fieldOf({ id: 'days', kind: 'number', label: '天数' }),
      vi.fn(),
    );
    expect(container.querySelector('input[type="number"]')).toBeTruthy();
  });
});

/**
 * 静默丢的防线：Card 回传 range / flexible 时草稿**不被写入**。
 *
 * 用一个替身 CalendarField 强行回传这两种值 —— 真实配置下它们不可达
 * （`tabs={['date']}` + `calendarMode="single"`），但守卫必须独立成立。
 *
 * ★ 放最后：用 `vi.doMock`，只影响这条用例的动态 import。
 */
describe('date 字段的取值守卫', () => {
  it('★ 卡片回传 range / flexible 时，草稿不被写入（不会静默丢进 answers）', async () => {
    vi.doMock('./fields/CalendarField', () => ({
      default: (props: { onChange?: (value: unknown) => void }) =>
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => {
              props.onChange?.({ mode: 'range', start: '2026-05-01', end: '2026-05-05' });
              props.onChange?.({ mode: 'flexible', days: 3 });
            },
          },
          'emit-range',
        ),
    }));
    vi.resetModules();

    const { default: ClarifyWithStub } = await import('./ClarifyOptions');
    const onAction = vi.fn();

    render(
      createElement(ClarifyWithStub, {
        questionId: QUESTION_ID,
        prompt: '请补充',
        fields: [fieldOf({ id: 'deadline', kind: 'date', label: '出发日期' })],
        onAction,
      }),
    );

    fireEvent.click(screen.getByText('emit-range'));
    fireEvent.click(screen.getByText('提交'));

    const action = onAction.mock.calls[0]![0] as ComponentAction;
    // 守卫生效 → 草稿仍是空串，而不是把区间值塞进去让下游解析失败。
    expect(action.values).toEqual({ deadline: '' });

    vi.doUnmock('./fields/CalendarField');
    vi.resetModules();
  });
});

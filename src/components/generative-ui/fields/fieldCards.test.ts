// @vitest-environment jsdom
/**
 * 字段卡（CalendarField / ChoiceGroupField）的 `showActions` 与 `onChange`。
 *
 * 这是任务 2 的**前置件**：把两张卡变成能内嵌进 `ClarifyOptions` 的"纯选值控件"。
 * 两条关键性质：
 * 1. `showActions={false}` 必须真的不渲染自带按钮（否则容器里会出现两个确认按钮）；
 * 2. `onChange` 是**旁路通知**，不能把组件改成受控组件 —— 默认行为必须完全不变。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import CalendarField from './CalendarField';
import ChoiceGroupField from './ChoiceGroupField';

const ONE_GROUP = [
  { id: 'g1', title: '偏好', multi: false, options: [
    { id: 'o1', label: '方案一' },
    { id: 'o2', label: '方案二' },
  ] },
];

const MULTI_GROUP = [{ ...ONE_GROUP[0], multi: true }];

function textsOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
}

/** 日历里当月可选（未置灰）的日期格：`aria-label` 是 `YYYY-MM-DD`。 */
function clickableDays(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label]')).filter(
    (button) => /^\d{4}-\d{2}-\d{2}$/.test(button.getAttribute('aria-label') ?? '') && !button.disabled,
  );
}

afterEach(() => {
  cleanup();
});

describe('ChoiceGroupField · showActions', () => {
  it('默认（不传）渲染自带确认按钮 —— 独立使用行为不变', () => {
    const { container } = render(
      createElement(ChoiceGroupField, { groups: ONE_GROUP, confirmLabel: '确认' }),
    );
    expect(textsOf(container)).toContain('确认');
  });

  it('★ showActions={false} 不渲染自带确认按钮（防止容器内出现两个确认按钮）', () => {
    const { container } = render(
      createElement(ChoiceGroupField, {
        groups: ONE_GROUP,
        confirmLabel: '确认',
        skipLabel: '跳过',
        showActions: false,
      }),
    );
    expect(textsOf(container)).not.toContain('确认');
    expect(textsOf(container)).not.toContain('跳过');
    // 选项本身还在 —— 只去掉了动作条。
    expect(textsOf(container)).toContain('方案一');
  });
});

describe('ChoiceGroupField · onChange', () => {
  it('单选：每次点选都回传**完整**选中态（含取消与换选）', () => {
    const onChange = vi.fn();
    const { getByText } = render(
      createElement(ChoiceGroupField, { groups: ONE_GROUP, onChange }),
    );

    fireEvent.click(getByText('方案一'));
    expect(onChange).toHaveBeenLastCalledWith({ g1: ['o1'] });

    fireEvent.click(getByText('方案一')); // 再点一次 = 取消
    expect(onChange).toHaveBeenLastCalledWith({ g1: [] });

    fireEvent.click(getByText('方案二')); // 换选
    expect(onChange).toHaveBeenLastCalledWith({ g1: ['o2'] });
  });

  it('多选：累加与取消都回传完整列表', () => {
    const onChange = vi.fn();
    const { getByText } = render(
      createElement(ChoiceGroupField, { groups: MULTI_GROUP, onChange }),
    );

    fireEvent.click(getByText('方案一'));
    fireEvent.click(getByText('方案二'));
    expect(onChange).toHaveBeenLastCalledWith({ g1: ['o1', 'o2'] });

    fireEvent.click(getByText('方案一'));
    expect(onChange).toHaveBeenLastCalledWith({ g1: ['o2'] });
  });

  it('★ onChange 是旁路通知：不传时组件照旧独立工作（确认按钮仍能提交）', () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      createElement(ChoiceGroupField, { groups: ONE_GROUP, confirmLabel: '确认', onConfirm }),
    );

    fireEvent.click(getByText('方案一'));
    fireEvent.click(getByText('确认'));
    expect(onConfirm).toHaveBeenCalledWith({ g1: ['o1'] });
  });
});

describe('CalendarField · showActions', () => {
  it('默认（不传）渲染自带的跳过与确认按钮', () => {
    const { container } = render(createElement(CalendarField, {}));
    expect(textsOf(container)).toContain('确认');
    expect(textsOf(container)).toContain('暂不设置日期');
  });

  it('★ showActions={false} 两个按钮都不渲染', () => {
    const { container } = render(createElement(CalendarField, { showActions: false }));
    expect(textsOf(container)).not.toContain('确认');
    expect(textsOf(container)).not.toContain('暂不设置日期');
    // 日期网格还在 —— 只去掉了动作条。
    expect(clickableDays(container).length).toBeGreaterThan(0);
  });
});

describe('CalendarField · onChange', () => {
  it('★ 点一天后回传 { mode: "single", date: "YYYY-MM-DD" }', () => {
    const onChange = vi.fn();
    const { container } = render(createElement(CalendarField, { onChange }));

    const days = clickableDays(container);
    expect(days.length).toBeGreaterThan(0);
    fireEvent.click(days[0]!);

    expect(onChange).toHaveBeenCalledTimes(1);
    const value = onChange.mock.calls[0]![0] as { mode: string; date?: string };
    expect(value.mode).toBe('single');
    expect(value.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('取值没变就不重复回传（同一次选中不会刷屏）', () => {
    const onChange = vi.fn();
    const { container } = render(createElement(CalendarField, { onChange }));

    const days = clickableDays(container);
    fireEvent.click(days[0]!);
    expect(onChange).toHaveBeenCalledTimes(1);

    // 再点同一天：值没变 → 不再回传。
    fireEvent.click(days[0]!);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('★ 只开单日期页签时不会回传 range / flexible', () => {
    const onChange = vi.fn();
    const { container } = render(
      createElement(CalendarField, { tabs: ['date'], calendarMode: 'single', onChange }),
    );

    const days = clickableDays(container);
    fireEvent.click(days[0]!);
    fireEvent.click(days[1]!);

    for (const call of onChange.mock.calls) {
      expect((call[0] as { mode: string }).mode).toBe('single');
    }
  });
});

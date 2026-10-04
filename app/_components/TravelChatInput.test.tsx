/**
 * ★ 常驻回归：`TravelChatInput` 的插槽契约与「智能解析」行为。
 *
 * 要锁住的两件事：
 *   1. 「智能解析」按钮只**填字、不发送** —— 点击后 `onChange` 恰好被调用**一次**、
 *      且严格等于 `SMART_PARSE_TEXT`，同时**绝不**触发 `onSubmitMessage`。
 *      这条通道是"智能解析"填充输入框的唯一方式（靠 `<CopilotChatInput>` 注入的
 *      `onChange`，不是自己改 `value`），改坏插槽契约这里会立刻红。
 *   2. 胶囊里 SDK 自带的两件控件确实在场：发送按钮（`data-testid="copilot-send-button"`）
 *      与上传按钮（`aria-label="上传图片"`）；且「智能解析」在**没有** `onChange` 时禁用
 *      （防止点了没反应还看不出为什么）。
 *
 * 渲染层级：`<Providers>` 同时提供 `ShellConfig`（upload 按钮要 `useShellConfig`）
 * 与 CopilotKit 上下文（`<CopilotChatInput>` 内部读 `useCopilotChatConfiguration`，
 * 缺省回落默认 labels，不抛）。这与已有的 `attachmentWait.test.tsx` 同构。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import TravelChatInput, { SMART_PARSE_TEXT } from '@/app/_components/TravelChatInput';
import Providers from '@/app/providers';

// shell project 未开 `globals`，RTL 不会自动清理挂载的 DOM；不手动清会跨用例累积，
// 导致多个「智能解析」/发送按钮，getByRole/getByTestId 报"找到多个"。
afterEach(cleanup);

/** 在真实 Provider 树下渲染输入框；`onChange` / `onSubmitMessage` 由调用方注入。 */
function renderTravelChatInput(
  props: Partial<React.ComponentProps<typeof TravelChatInput>>,
): ReturnType<typeof render> {
  return render(
    React.createElement(Providers, null, React.createElement(TravelChatInput, props)),
  );
}

describe('TravelChatInput', () => {
  it('点击「智能解析」→ onChange 恰好一次且严格等于 SMART_PARSE_TEXT，且不触发 onSubmitMessage', () => {
    const onChange = vi.fn();
    const onSubmitMessage = vi.fn();

    renderTravelChatInput({ onChange, onSubmitMessage });

    const smartParseButton = screen.getByRole('button', { name: '智能解析' });
    fireEvent.click(smartParseButton);

    // 只填字，不发送。
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(SMART_PARSE_TEXT);
    expect(onSubmitMessage).not.toHaveBeenCalled();
  });

  it('胶囊内 SDK 控件齐全：发送按钮（copilot-send-button）与上传按钮（aria-label=上传图片）', () => {
    renderTravelChatInput({ onChange: vi.fn(), onSubmitMessage: vi.fn() });

    // 发送按钮来自 SDK 自带的 BoundSendButton，data-testid 固定。
    expect(screen.getByTestId('copilot-send-button')).toBeTruthy();
    // 上传按钮用 aria-label 暴露，方便无障碍与测试定位。
    expect(screen.getByLabelText('上传图片')).toBeTruthy();
  });

  it('缺 onChange 时「智能解析」按钮禁用（点了也没反应，必须让用户看出为什么）', () => {
    // 不传 onChange。
    renderTravelChatInput({ onSubmitMessage: vi.fn() });

    const smartParseButton = screen.getByRole('button', { name: '智能解析' }) as HTMLButtonElement;
    expect(smartParseButton.disabled).toBe(true);
  });
});

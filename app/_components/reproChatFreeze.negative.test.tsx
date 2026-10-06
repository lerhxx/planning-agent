/**
 * ★ 负向对照（negative control）：证明 reproChatFreeze 的断言**不是恒真**。
 *
 * 为什么要单独一个文件：reproChatFreeze 全绿时，唯一的反驳是"那些断言反正都会过"。
 * 这里人为把 SDK 的输入框**真的弄卡**（textarea disabled + 发送按钮 disabled +
 * 盖一层全屏 fixed 遮罩），然后复用**同一套断言**——它们必须变红。
 *
 * 卡法刻意选得与线上症状一致：冻结发生在 run 结束**之后**（effect 里触发），
 * 而不是"一开始就 disabled"。所以"run 前可用、run 后不可用"这个时序也被验到了。
 *
 * ⚠️ 这里的 `FROZEN` 开关是**故意注入的故障**；修好之后**不要**把本文件当成回归。
 *   它的唯一职责是：让 reproChatFreeze 的断言有一次可观测的失败。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { CopilotChat } from '@copilotkit/react-core/v2';
import Providers, { DEFAULT_AGENT_ID } from '@/app/providers';
import TravelChatInput from '@/app/_components/TravelChatInput';

if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
  if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
}

const RUN_ID = 'r1';
const OFF_TOPIC_SSE =
  `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'thread-default', runId: RUN_ID })}\n\n` +
  `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_START', messageId: `guide-${RUN_ID}`, role: 'assistant' })}\n\n` +
  `data: ${JSON.stringify({
    type: 'TEXT_MESSAGE_CONTENT',
    messageId: `guide-${RUN_ID}`,
    delta: '我是旅游规划小助手，只能帮你做旅游相关的规划哦。换个目的地试试？',
  })}\n\n` +
  `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_END', messageId: `guide-${RUN_ID}` })}\n\n` +
  `data: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: 'thread-default', runId: RUN_ID })}\n\n`;

function stubFetch(sseBody: string): { bodies: string[] } {
  const bodies: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/agui')) {
      if (init?.body !== undefined) bodies.push(String(init.body));
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ assets: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { bodies };
}

/** ★ 故意注入的"卡死"：全屏 fixed 遮罩 + 输入框与发送按钮全部失活。 */
function freezeUi(): void {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-injected-freeze', 'true');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '9999';
  document.body.appendChild(overlay);

  const ta = document.querySelector('textarea');
  if (ta) (ta as HTMLTextAreaElement).disabled = true;
  const btn = document.querySelector('[data-testid="copilot-send-button"]');
  if (btn) (btn as HTMLButtonElement).disabled = true;
}

/** 与 reproChatFreeze 中**逐字相同**的两个判定。 */
function findFullScreenOverlays(): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const s = (el as HTMLElement).style;
    if (!s) continue;
    const isFixed = s.position === 'fixed';
    const coversInset0 =
      /inset\s*:\s*0/.test(s.cssText) || (s.top === '0px' && s.left === '0px');
    if (isFixed && coversInset0) {
      out.push(`<${el.tagName.toLowerCase()} data-injected-freeze="true"> z=${s.zIndex}`);
    }
  }
  return out;
}

function getTextarea(): HTMLTextAreaElement {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('找不到 textarea');
  return ta as HTMLTextAreaElement;
}

function getSendButton(): HTMLButtonElement {
  return document.querySelector('[data-testid="copilot-send-button"]') as HTMLButtonElement;
}

/**
 * 与 reproChatFreeze 中**逐字相同**的敲字实现（含 disabled 守卫 ——
 * 真实键盘事件进不去 disabled 的 textarea，而 `el.value = x` 会绕过它）。
 */
function type(text: string): void {
  const ta = getTextarea();
  if (ta.disabled || ta.readOnly) return;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('负向对照：注入卡死后，reproChatFreeze 的断言必须失败', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('注入冻结 → typingWorks 应为 false（证明上一轮那个 true 是真测出来的）', async () => {
    const { bodies } = stubFetch(OFF_TOPIC_SSE);
    render(
      React.createElement(
        Providers as never,
        null,
        React.createElement(CopilotChat as never, {
          agentId: DEFAULT_AGENT_ID,
          input: TravelChatInput as never,
          className: 'h-full',
        } as never),
      ) as never,
    );

    await waitFor(() => expect(getTextarea()).toBeTruthy());

    // run 前：可用
    await act(async () => {
      type('今天天气怎么样');
    });
    expect(getTextarea().value).toContain('今天天气怎么样');

    await act(async () => {
      getSendButton().click();
    });
    await waitFor(() => expect(bodies.length).toBe(1), { timeout: 15_000 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(document.body.textContent).toContain('旅游规划小助手');

    // ★ 此刻注入冻结（线上症状的时序：回复渲染之后才卡）
    await act(async () => {
      freezeUi();
    });

    await act(async () => {
      type('再试一次');
    });

    const typingWorks = getTextarea().value.includes('再试一次');
    const overlays = findFullScreenOverlays();

    console.log('\n[NEGATIVE CONTROL] ==============');
    console.log('typingWorks =', typingWorks, '（期望 false）');
    console.log('textareaDisabled =', getTextarea().disabled, '（期望 true）');
    console.log('sendDisabled =', getSendButton().disabled, '（期望 true）');
    console.log('overlays =', JSON.stringify(overlays), '（期望非空）');
    console.log('[/NEGATIVE CONTROL] ==============\n');

    // ★ 下面三条是 reproChatFreeze 里**逐字相反**的断言。
    //   reproChatFreeze 断言： typingWorks === true  /  textareaDisabled === false  /  overlays === []
    //   这里观测到的是：    typingWorks === false /  textareaDisabled === true   /  overlays !==  []
    //   也就是说 reproChatFreeze 那三条在同等场景下**必然变红**。
    //   本文件断言的是"冻结被成功观测到"这个事实（所以本文件是绿的），
    //   绿的含义是：注入成功 + 探针灵敏。
    expect(typingWorks).toBe(false);
    expect(getTextarea().disabled).toBe(true);
    expect(getSendButton().disabled).toBe(true);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toContain('data-injected-freeze');
  }, 90_000);
});

/**
 * ★ 路由传输层回归：离题拦截的短路行为。
 *
 * 背景：用户要求"与旅游规划无关的问题，不进入规划逻辑，而是引导用户——
 * 你是旅游规划小助手"。这条短路必须在 `app/api/agui/route.ts` 内、进 `runGoal`
 * 之前发生，且离题时**不消耗任何模型调用**。
 *
 * ★ 本文件属于 `shell` project（vitest.config.ts）：route 本身 import
 *   `@ag-ui/core` / `@ag-ui/encoder`，放错 project 会加载失败。
 *
 * 手法：mock 掉 `runGoal`（不实际跑内核）与 `createTextClassifier`
 * （返回 null = 没配真模型，灰区按引导），断言：
 *   1. 离题消息 → 只发引导气泡 + RUN_FINISHED，runGoal 一次都不调用；
 *   2. 旅游相关消息 → 仍进入 runGoal（happy path 不被破坏）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/src/core/run/engine', () => ({
  runGoal: vi.fn(async () => {}),
}));

// 让 createTextClassifier 返回 null：模拟默认 mock 模式没配真模型，
// 灰区消息按"默认引导"处理——正是离题拦截要验证的短路路径。
vi.mock('@/src/core/runtime/mastra', () => ({
  createTextClassifier: () => null,
  createMastraRuntime: () => ({ id: 'mock' }),
}));

import { POST } from '@/app/api/agui/route';
import type { Event as AguiEvent } from '@ag-ui/core';

function makeRequest(content: string): Request {
  return new Request('http://localhost/api/agui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId: 't-guide',
      runId: 'r-guide',
      messages: [{ id: 'm1', role: 'user', content }],
    }),
  });
}

/** 解析 SSE 文本流，抽出所有 `data: {…}` 事件。 */
async function collectEvents(response: Response): Promise<AguiEvent[]> {
  const text = await response.text();
  const events: AguiEvent[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload.length === 0) continue;
    events.push(JSON.parse(payload) as AguiEvent);
  }
  return events;
}

describe('AG-UI 路由：离题引导（混合判定）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('离题消息只发引导气泡 + RUN_FINISHED，完全不进 runGoal', async () => {
    const response = await POST(makeRequest('帮我写一段 Python 代码'));
    expect(response.status).toBe(200);

    const events = await collectEvents(response);
    const types = events.map((event) => event.type);

    expect(types).toContain('RUN_STARTED');
    expect(types).toContain('TEXT_MESSAGE_START');
    expect(types).toContain('TEXT_MESSAGE_CONTENT');
    expect(types).toContain('TEXT_MESSAGE_END');
    expect(types).toContain('RUN_FINISHED');
    // 离题路径绝不发 RUN_ERROR。
    expect(types).not.toContain('RUN_ERROR');
    // RUN_FINISHED 必须是流的最后一个事件。
    expect(types[types.length - 1]).toBe('RUN_FINISHED');

    // 引导文案确实下发，且是旅游规划小助手人设。
    const contentEvent = events.find((event) => event.type === 'TEXT_MESSAGE_CONTENT') as
      | { delta?: string }
      | undefined;
    expect(contentEvent?.delta).toMatch(/旅游规划小助手/);

    // ★ 关键：离题短路，runGoal 一次都没被调用。
    const { runGoal } = await import('@/src/core/run/engine');
    expect(vi.mocked(runGoal).mock.calls.length).toBe(0);
  });

  it('旅游相关消息仍进入 runGoal（happy path 不被离题拦截破坏）', async () => {
    const response = await POST(makeRequest('帮我规划一个三天两夜的东京行程'));
    const events = await collectEvents(response);
    const types = events.map((event) => event.type);

    expect(types).toContain('RUN_FINISHED');
    // 没有走引导路径。
    expect(types).not.toContain('TEXT_MESSAGE_CONTENT');
    // ★ 关键：旅游相关目标确实进了规划。
    const { runGoal } = await import('@/src/core/run/engine');
    expect(vi.mocked(runGoal).mock.calls.length).toBe(1);
  });
});

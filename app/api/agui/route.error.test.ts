/**
 * ★ 路由传输层回归：错误路径的终态事件顺序。
 *
 * 背景（真实踩出来的 bug）：`app/api/agui/route.ts` 的 catch 块在发完
 * `RUN_ERROR`（AG-UI 终态）后又调了 `finishRun()` 发 `RUN_FINISHED`，
 * 客户端状态机会拒绝并抛
 * "Cannot send event type 'RUN_FINISHED': The run has already errored"。
 *
 * 这条路径此前**永远不触发**——默认走 mock 永不报错。直到 `RUNTIME_ADAPTER=mastra`
 * 真正生效、真模型调用失败，第一次进入 catch，才把潜伏的传输层 bug 暴露出来。
 * 缺这条测试，它才藏了这么久。
 *
 * ★ 本文件属于 `shell` project（vitest.config.ts）：只有 shell 才内联 `@ag-ui`，
 *   route 本身 import `@ag-ui/core` / `@ag-ui/encoder`，放错 project 会加载失败。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// 让 runGoal 必然抛错，强制走路由的 catch 分支（无需真实模型、无需网络）。
vi.mock('@/src/core/run/engine', () => ({
  runGoal: vi.fn(async () => {
    throw new Error('injected failure: downstream boom');
  }),
}));

import { POST } from '@/app/api/agui/route';
import type { Event as AguiEvent } from '@ag-ui/core';

function makeRequest(): Request {
  return new Request('http://localhost/api/agui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId: 't-error',
      runId: 'r-error',
      messages: [{ id: 'm1', role: 'user', content: '做个两步计划' }],
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

describe('AG-UI 路由：runGoal 抛错时的终态顺序', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('只发 RUN_ERROR，不紧随 RUN_FINISHED（修复 AGUIError）', async () => {
    const response = await POST(makeRequest());

    // 错误路径仍是 200 + SSE 流（错误通过事件体承载，不是 HTTP 状态码）。
    expect(response.status).toBe(200);

    const events = await collectEvents(response);
    const types = events.map((event) => event.type);

    expect(types).toContain('RUN_STARTED');
    expect(types).toContain('RUN_ERROR');

    // ★ 关键断言：终态 RUN_ERROR 之后绝不能再发 RUN_FINISHED。
    expect(types).not.toContain('RUN_FINISHED');

    // RUN_ERROR 必须是流的最后一个事件。
    expect(types[types.length - 1]).toBe('RUN_ERROR');

    // 错误信息确实透传（不再被 AGUIError 协议冲突盖掉）。
    const runError = events.find((event) => event.type === 'RUN_ERROR') as
      | { message?: string }
      | undefined;
    expect(runError?.message).toContain('injected failure');
  });

  it('RUN_ERROR 的 message 是底层真实错误，而非协议噪音', async () => {
    const response = await POST(makeRequest());
    const events = await collectEvents(response);
    const runError = events.find((event) => event.type === 'RUN_ERROR') as
      | { message?: string; code?: string }
      | undefined;

    expect(runError).toBeDefined();
    expect(runError?.code).toBe('INTERNAL_ERROR');
    // 业务错误文案在，证明传输层不再吞掉它。
    expect(runError?.message).toMatch(/injected failure/);
  });
});

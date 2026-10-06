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
import { runGoal } from '@/src/core/run/engine';
import type { Event as AguiEvent } from '@ag-ui/core';

/** 注入用例统一用的 trace / node 标识（字段按 `shared/stream/events.ts` 的真实契约给）。 */
const TRACE_ID = 'trace-injected';
const NODE_ID = 'node-error-injected';

function makeRequest(): Request {
  return new Request('http://localhost/api/agui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: 't-error',
        runId: 'r-error',
        messages: [{ id: 'm1', role: 'user', content: '帮我规划一个两天一夜的东京行程' }],
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

  /**
   * ★ 第二个回归：内核**不抛错**，而是通过 `deps.emit` 发事件并正常返回 ——
   *   发射顺序刻意照抄修复前的 `failRun`（先 `error`、后组件三连）。
   *
   *   翻译器把 `error` 翻成终态 `RUN_ERROR`、把 `component_start` 翻成
   *   `ACTIVITY_SNAPSHOT`；AG-UI 客户端在 RUN_ERROR 之后收到**任何**事件都会抛
   *   `AGUIError: ... No further events can be sent.`。
   *   所以只能由传输层兜住：终态之后一律不发。缺了这层守卫，
   *   错误卡片永远到不了界面，控制台还会刷满 AGUIError。
   */
  it('内核先发 error 再发组件事件：RUN_ERROR 之后不再有任何事件', async () => {
    vi.mocked(runGoal).mockImplementationOnce(async (_input, deps) => {
      deps.emit({
        type: 'error',
        traceId: TRACE_ID,
        message: 'injected kernel failure',
        recoverable: false,
      });
      deps.emit({
        type: 'component_start',
        nodeId: NODE_ID,
        component: 'ErrorState',
        traceId: TRACE_ID,
      });
      deps.emit({
        type: 'component_props_delta',
        nodeId: NODE_ID,
        patch: [{ op: 'add', path: '/message', value: 'injected kernel failure' }],
      });
      deps.emit({ type: 'component_end', nodeId: NODE_ID, status: 'error' });
      deps.emit({ type: 'done', traceId: TRACE_ID, status: 'failed' });
      return { status: 'failed', plan: null, traceId: TRACE_ID };
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);

    const events = await collectEvents(response);
    const types: string[] = events.map((event) => event.type);
    const errorIndex = types.indexOf('RUN_ERROR');

    // RUN_ERROR 必须出现，且是流的最后一个事件 —— 其后一个事件都不能有。
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(types[types.length - 1]).toBe('RUN_ERROR');
    expect(types.slice(errorIndex + 1)).toEqual([]);

    // ★ 关键断言：错误之后不再出现 ACTIVITY_SNAPSHOT（错误卡片的上线通道），
    //   也不再出现第二个终态 RUN_FINISHED。
    expect(types).not.toContain('ACTIVITY_SNAPSHOT');
    expect(types).not.toContain('ACTIVITY_DELTA');
    expect(types).not.toContain('RUN_FINISHED');

    // 错误真实透传：不是协议噪音，也不是空壳。
    const runError = events.find((event) => event.type === 'RUN_ERROR') as
      | { message?: string }
      | undefined;
    expect(runError?.message).toContain('injected kernel failure');
  });

  /**
   * 第三个回归：`failRun` 修好之后的顺序（组件三连在前、`error` 收尾）。
   * 断言错误卡片**确实到达**界面，同时 RUN_ERROR 仍是最后一个事件 ——
   * 即"卡片先到、错误收尾"这条不变式的端到端证据。
   */
  it('组件在前、error 收尾：卡片到达界面且 RUN_ERROR 仍是最后一个事件', async () => {
    vi.mocked(runGoal).mockImplementationOnce(async (_input, deps) => {
      deps.emit({
        type: 'component_start',
        nodeId: NODE_ID,
        component: 'ErrorState',
        traceId: TRACE_ID,
      });
      deps.emit({
        type: 'component_props_delta',
        nodeId: NODE_ID,
        patch: [{ op: 'add', path: '/message', value: 'injected kernel failure' }],
      });
      deps.emit({ type: 'component_end', nodeId: NODE_ID, status: 'error' });
      deps.emit({
        type: 'error',
        traceId: TRACE_ID,
        message: 'injected kernel failure',
        recoverable: false,
      });
      deps.emit({ type: 'done', traceId: TRACE_ID, status: 'failed' });
      return { status: 'failed', plan: null, traceId: TRACE_ID };
    });

    const response = await POST(makeRequest());
    const events = await collectEvents(response);
    const types: string[] = events.map((event) => event.type);

    // 卡片先到（ACTIVITY_SNAPSHOT / ACTIVITY_DELTA 都在 error 之前发出）。
    expect(types).toContain('ACTIVITY_SNAPSHOT');
    expect(types).toContain('ACTIVITY_DELTA');

    // 终态仍是 RUN_ERROR，且它后面没有第二个终态。
    expect(types[types.length - 1]).toBe('RUN_ERROR');
    expect(types).not.toContain('RUN_FINISHED');

    const snapshotIndex = types.indexOf('ACTIVITY_SNAPSHOT');
    expect(snapshotIndex).toBeLessThan(types.indexOf('RUN_ERROR'));

    const runError = events.find((event) => event.type === 'RUN_ERROR') as
      | { message?: string }
      | undefined;
    expect(runError?.message).toContain('injected kernel failure');
  });
});

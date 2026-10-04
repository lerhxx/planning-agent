/**
 * SDK 级回归：用**真实的 `HttpAgent`** 复现"用户不点澄清选项、直接在输入框发新消息"
 * 这条路径，盯住两件事：
 *
 * 1. `AbstractAgent.onInitialize` 那道 pending-interrupt 校验确实会抛（用例 ① 原样保留这个
 *    "负面"断言 —— 一旦 SDK 改了行为我们能立刻知道修复是否还有必要）；
 * 2. 外壳的 `runAgent` wrapper（见 `app/providers.tsx`）确实把没交代的中断补成了 `cancelled`，
 *    并且**不会**覆盖用户已经提交的 `resolved` 答案。
 *
 * ★ 为什么单测之外还需要这层：`resume.ts` 的纯函数用例保证不了**接线位置**正确。
 *   这道校验发生在 `runAgent` 的参数阶段、早于 middleware —— 装在中间件上是无效的，
 *   纯函数测不出来这类"点错了位置"的错误。
 */
import { describe, expect, it } from 'vitest';
import { HttpAgent } from '@ag-ui/client';
import { buildResumeWithCancelled } from './resume';

const THREAD_ID = 'thread-probe';
const INTERRUPT_ID = 'clarify:probe-1';

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function interruptRun(): Response {
  return sseResponse([
    { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-1' },
    {
      type: 'RUN_FINISHED',
      threadId: THREAD_ID,
      runId: 'run-1',
      outcome: {
        type: 'interrupt',
        interrupts: [
          { id: INTERRUPT_ID, reason: 'STEP_AWAITING_USER', responseSchema: { answers: {} } },
        ],
      },
    },
  ]);
}

function successRun(): Response {
  return sseResponse([
    { type: 'RUN_STARTED', threadId: THREAD_ID, runId: 'run-2' },
    { type: 'RUN_FINISHED', threadId: THREAD_ID, runId: 'run-2', outcome: { type: 'success' } },
  ]);
}

/** 复刻 app/providers.tsx 里的接线。 */
function withWrapper(agent: HttpAgent): HttpAgent {
  const baseRunAgent = agent.runAgent.bind(agent);
  agent.runAgent = (parameters, subscriber) => {
    const resume = buildResumeWithCancelled(agent.pendingInterrupts ?? [], parameters?.resume);
    return baseRunAgent(
      resume === undefined ? parameters : { ...parameters, resume: [...resume] },
      subscriber,
    );
  };
  return agent;
}

describe('probe: pending interrupt 阻断后续 run', () => {
  it('① 复现 bug：有 pending 时不带 resume 再跑一次会被硬拦', async () => {
    const agent = new HttpAgent({
      url: 'http://probe.local/api/agui',
      fetch: async () => interruptRun(),
    });
    await agent.runAgent();

    expect(agent.pendingInterrupts.map((entry) => entry.id)).toEqual([INTERRUPT_ID]);

    await expect(agent.runAgent()).rejects.toThrow(/not addressed by resume/);
  });

  it('② 修复：wrapper 补 cancelled 后不再抛，且请求体里带着它', async () => {
    const captured: string[] = [];
    let call = 0;
    const agent = withWrapper(
      new HttpAgent({
        url: 'http://probe.local/api/agui',
        fetch: async (_url, init) => {
          call += 1;
          if (init?.body !== undefined) captured.push(String(init.body));
          // 第一次返回带中断的 run（制造 pending interrupt），之后返回正常成功。
          return call === 1 ? interruptRun() : successRun();
        },
      }),
    );
    await agent.runAgent();
    expect(agent.pendingInterrupts.map((entry) => entry.id)).toEqual([INTERRUPT_ID]);

    await expect(agent.runAgent()).resolves.toBeDefined();

    expect(captured.length).toBeGreaterThan(0);
    const lastBody = JSON.parse(captured[captured.length - 1]!) as { resume?: unknown[] };
    expect(lastBody.resume).toEqual([{ interruptId: INTERRUPT_ID, status: 'cancelled' }]);
  });

  it('③ 不能冲掉答案：resume 里已有 resolved 时不再补 cancelled', async () => {
    const captured: string[] = [];
    let call = 0;
    const agent = withWrapper(
      new HttpAgent({
        url: 'http://probe.local/api/agui',
        fetch: async (_url, init) => {
          call += 1;
          if (init?.body !== undefined) captured.push(String(init.body));
          return call === 1 ? interruptRun() : successRun();
        },
      }),
    );
    await agent.runAgent();
    expect(agent.pendingInterrupts.map((entry) => entry.id)).toEqual([INTERRUPT_ID]);

    await agent.runAgent({
      resume: [
        {
          interruptId: INTERRUPT_ID,
          status: 'resolved',
          payload: { answers: { budget: '3000' } },
        },
      ],
    });

    const lastBody = JSON.parse(captured[captured.length - 1]!) as { resume?: unknown[] };
    expect(lastBody.resume).toEqual([
      { interruptId: INTERRUPT_ID, status: 'resolved', payload: { answers: { budget: '3000' } } },
    ]);
  });
});

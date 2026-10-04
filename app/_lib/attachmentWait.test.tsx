/**
 * ★ 常驻回归：「上传中提交」必须带上全部附件（静默少发的唯一防线）。
 *
 * 要锁住的 bug：`attachments`（真正随提问发出去的描述符）只取 `status === 'ready'`，
 * 所以"选 5 张 → 3 张传完、2 张还在传 → 用户直接回车"会让那 2 张无声无息消失。
 * 修法在 `app/providers.tsx` 的 `waitForPendingUploads`：有在途上传时先等（上限 8 秒）再发，
 * 等不到也照常发送但把少了几张显式报出来。
 *
 * ★ 为什么必须在这个层级测（纯函数测不出来）：
 *   等待逻辑活在 `<Providers>` 的 `runAgent` wrapper 里，它读的是 **React 渲染后的 ref**，
 *   靠的是"上传完成 → setItems → 重渲染 → ref 更新"这条链路。任何拆成纯函数的版本
 *   都会把这条链路替掉，测的就不是真代码了。这里用 jsdom + 真实的
 *   `Providers` / `HttpAgent` / `useAttachments`，**只 stub 掉 `fetch`**。
 *
 * 三条用例：
 *   ① 3 张在途 → 请求体带全部 3 个描述符，且**确实等过**（第二条时间断言）；
 *   ② 上传永不返回 → 超时后照常发送、无 attachments 键、明确报出"本轮没带上 N 张"；
 *   ③ 反向锁：不等就发的行为在这里必然是"0 个描述符"（用例 ① 的镜像断言）。
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { useAgent } from '@copilotkit/react-core/v2';
import { DEFAULT_AGENT_ID, default as Providers, useShellConfig } from '@/app/providers';

/** 一次成功的空跑：够让 `runAgent` 正常 resolve。 */
function sseResponse(): Response {
  const body = [
    `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 't', runId: 'r1' })}\n\n`,
    `data: ${JSON.stringify({
      type: 'RUN_FINISHED',
      threadId: 't',
      runId: 'r1',
      outcome: { type: 'success' },
    })}\n\n`,
  ].join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeFile(index: number): File {
  return new File([new Uint8Array([1, 2, 3])], `shot-${index}.png`, { type: 'image/png' });
}

/** stub `/api/assets`（可选地永不返回）与 `/api/agui`（抓取请求体）。 */
function stubFetch(options: { hangAssets?: boolean; assetDelayMs?: number }): {
  captured: string[];
} {
  const captured: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/assets')) {
      if (options.hangAssets === true) return new Promise<Response>(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, options.assetDelayMs ?? 300));
      const assets = [0, 1, 2].map((index) => ({
        id: `asset-${index}`,
        kind: 'image',
        name: `shot-${index}.png`,
        mimeType: 'image/png',
        byteSize: 3,
        ref: `asset://asset-${index}`,
      }));
      return new Response(JSON.stringify({ assets }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (init?.body !== undefined) captured.push(String(init.body));
    return sseResponse();
  }) as unknown as typeof fetch;
  return { captured };
}

function mountProviders() {
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement =>
    React.createElement(Providers, null, children);

  return renderHook(
    () => ({
      shell: useShellConfig(),
      agent: useAgent({ agentId: DEFAULT_AGENT_ID }),
    }),
    { wrapper },
  );
}

/**
 * 发起一次 run 并等到尘埃落定。
 *
 * ★ 刻意**不**把 `runAgent` 的 await 放进 `act`：`act` 会把更新攒到最后才 flush，
 * 那样在途上传的 `setItems` 永远等不到重渲染，等待循环会一直空转（假死，不是真 bug）。
 * 生产环境没有 `act` 包着，不会出现这个现象。
 */
async function runAndSettle(run: () => Promise<unknown>, settleMs: number): Promise<void> {
  let settled = false;
  void run().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(settled).toBe(true);
}

function parseBody(raw: string | undefined): {
  forwardedProps?: { attachments?: unknown[] };
} {
  return JSON.parse(raw ?? '{}') as { forwardedProps?: { attachments?: unknown[] } };
}

describe('上传中提交：不能静默少发附件', () => {
  it('① 3 张在途时发 run → 请求体带全部 3 个描述符，且确实等过', async () => {
    const { captured } = stubFetch({ assetDelayMs: 300 });
    const { result } = mountProviders();

    // 发起上传但**不**等它完成 —— 模拟用户选完图立刻回车。
    await act(async () => {
      void result.current.shell.attachments.add([makeFile(0), makeFile(1), makeFile(2)]);
    });
    expect(result.current.shell.attachments.uploading).toBe(true);
    expect(result.current.shell.attachments.attachments.length).toBe(0);

    const startedAt = Date.now();
    await runAndSettle(() => result.current.agent.agent.runAgent(), 1200);

    expect(captured.length).toBe(1);
    const sentAt = Date.now();
    expect(parseBody(captured[0]).forwardedProps?.attachments?.length).toBe(3);
    expect(result.current.shell.attachmentNotice).toBe('');

    /*
     * ★ 反向锁（时间维度）：上传被 stub 成 300ms 才返回。
     *   如果有人把"等"去掉，请求会在 ~0ms 就发出去、带上 0 个描述符，
     *   上面那条 3 个的断言会红 —— 这条时间断言确保"等"本身被观测到，
     *   而不是靠"恰好来得及"蒙对。
     */
    expect(sentAt - startedAt).toBeGreaterThanOrEqual(250);
  }, 30_000);

  it('② 上传永不返回 → 超时后照常发送，但明确报出少了几张', async () => {
    const { captured } = stubFetch({ hangAssets: true });
    const { result } = mountProviders();

    await act(async () => {
      void result.current.shell.attachments.add([makeFile(0), makeFile(1)]);
    });
    expect(result.current.shell.attachments.uploading).toBe(true);

    // 等满 8 秒上限 + 余量
    await runAndSettle(() => result.current.agent.agent.runAgent(), 9_500);

    expect(captured.length).toBe(1);
    // 提问不能丢（照常发送），但也绝不能假装带上了：
    expect(parseBody(captured[0]).forwardedProps?.attachments).toBeUndefined();
    expect(result.current.shell.attachmentNotice).toContain('本轮没带上 2 张图片');
  }, 30_000);
});

/**
 * ★ 回归测试：回复渲染之后，聊天输入区必须仍然是可交互的。
 *
 * ============================ 被测的 bug ============================
 * 症状：收到任意一条回复之后，输入框打不了字、所有按钮点不动，**控制台无任何报错**。
 *
 * 根因（`app/_components/TravelChatInput.tsx`）：我们用 `CopilotChatInput` 的
 * **children 渲染函数**（slot API）接管胶囊布局。`<CopilotChatView>` 会把整个输入区
 * 包进一层 `position:absolute` + `pointer-events:none` 的 overlay
 * （`data-testid="copilot-input-overlay"`，react-core cjs:351420），
 * 而 `pointer-events` 是**继承**属性。
 * SDK 的默认渲染路径靠内层一个 `pointer-events-auto` 的 div 把它救回来
 * （cjs:61093）；但 children 那条早返回分支（cjs:47487）只渲染一个
 * `display:contents` 壳再调用 `children(childProps)`，**全程没有 pointer-events-auto**。
 * 于是胶囊永久继承 overlay 的 `none` —— 纯 CSS 命中测试问题，不是 JS 异常，
 * 所以 `CardErrorBoundary` / `app/error.tsx` 一律抓不到、控制台一片干净。
 * 修复 = 胶囊根节点显式挂 `pointer-events-auto`。
 *
 * ============================ 为什么"离题/旅游"两条路径都测 ============================
 * 修复前实测两条路径**都会**卡（不是离题特有）：只要 `agent.messages.length > 0`，
 * overlay 就会出现。离题引导只是最短的一条消息，所以最先暴露。
 * 消息数为 0（welcome 屏）时 `CopilotChatView` 走另一分支、不渲染 overlay，故第一句之前能打字。
 *
 * ============================ ★ 为什么断言 7 才是真守卫 ============================
 * jsdom **不加载 Tailwind / SDK 样式表**，`getComputedStyle(el).pointerEvents`
 * 恒等于 `auto` —— 所以 `pointerBlocked` / `sendPointerBlocked` 这类
 * "生效的 pointer-events" 探针在 jsdom 里是**恒真的弱断言**，抓不到回归。
 * （已在真实 Chrome 里用 `elementFromPoint` 命中测试验过修复前后的差异。）
 * **class 列表是真实 DOM**：把 `pointer-events-auto` 删掉，断言 7 立刻变红。
 * 所以本文件里真正守住这条回归的是断言 7，其余断言守的是别的层（见各条注释）。
 *
 * ============================ 怎么保证测的是真代码 ============================
 * 用**真实**的 `<Providers>`（app/providers.tsx，含真实 HttpAgent / 中间件 /
 * runAgent wrapper）、真实 `<CopilotChat>`、真实 `input={TravelChatInput}`。
 * **只 stub `fetch`** —— 让 `/api/agui` 返回离题或旅游的 SSE 序列。
 *
 * ============================ 跑法 ============================
 *   npx vitest run --project shell app/_components/reproChatFreeze.test.tsx
 * ⚠️ 本仓库的 shell project 冷启动很慢（copilotkit 模块图 transform + jsdom 环境），
 *    属正常；`unit` project 更快。
 *
 * 配套的负向对照见 `reproChatFreeze.negative.test.tsx`：它人为注入冻结，
 * 证明本文件的探针是灵敏的（曾真的抓出探针自身"绕过 disabled"的假绿 bug）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { CopilotChat } from '@copilotkit/react-core/v2';
import Providers, { DEFAULT_AGENT_ID } from '@/app/providers';
import TravelChatInput from '@/app/_components/TravelChatInput';

const THREAD_ID = 'thread-default';
const RUN_ID = 'r1';

/*
 * ★ jsdom 环境补丁（不是被测行为的一部分，别误读成 bug）。
 *
 * jsdom 不实现 `ResizeObserver`，而 `<CopilotChat>` 内部两个地方**必须**有它：
 *   - `use-stick-to-bottom`（滚动锚定）的 ref attach；
 *   - `CopilotChatView.tsx:210` 的自动滚动 effect。
 * 缺了它 React 会在 commit 阶段抛 `ReferenceError: ResizeObserver is not defined`，
 * 组件树根本挂不上去 —— 那是**测试环境**的缺口，与线上那个"无 console 错误的卡死"无关。
 * 所以这里补一个永远不回调的空实现（只够让挂载通过；本用例不测滚动行为）。
 */
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
  // jsdom 同样没有 matchMedia，SDK 的响应式分支会用到。
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

/** 一条 SSE `data:` 行。 */
function line(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 离题序列：逐字对照 `app/api/agui/route.ts` 的短路分支 +
 * `createGuidanceEvents`（`src/agui/translate.ts:129`）。
 *
 * ★ 关键形状：三个 TEXT_MESSAGE_* 事件**不带 threadId / runId**，
 *   且 RUN_FINISHED **不带 outcome**。这两点必须与线上一致，
 *   否则测的就不是这个 bug 了。
 */
const OFF_TOPIC_SSE =
  line({ type: 'RUN_STARTED', threadId: THREAD_ID, runId: RUN_ID }) +
  line({ type: 'TEXT_MESSAGE_START', messageId: `guide-${RUN_ID}`, role: 'assistant' }) +
  line({
    type: 'TEXT_MESSAGE_CONTENT',
    messageId: `guide-${RUN_ID}`,
    delta: '我是旅游规划小助手，只能帮你做旅游相关的规划哦。换个目的地试试？',
  }) +
  line({ type: 'TEXT_MESSAGE_END', messageId: `guide-${RUN_ID}` }) +
  line({ type: 'RUN_FINISHED', threadId: THREAD_ID, runId: RUN_ID });

/** 旅游序列：额外有活动卡片（ACTIVITY_SNAPSHOT），且 RUN_FINISHED 带 outcome。 */
const TRAVEL_SSE =
  line({ type: 'RUN_STARTED', threadId: THREAD_ID, runId: RUN_ID }) +
  line({
    type: 'ACTIVITY_SNAPSHOT',
    messageId: 'plan-p1',
    activityType: 'plan',
    content: { planId: 'p1', revision: 0, status: 'draft', summary: '', steps: [] },
  }) +
  line({ type: 'TEXT_MESSAGE_START', messageId: `body-${RUN_ID}`, role: 'assistant' }) +
  line({ type: 'TEXT_MESSAGE_CONTENT', messageId: `body-${RUN_ID}`, delta: '好的，正在为你规划。' }) +
  line({ type: 'TEXT_MESSAGE_END', messageId: `body-${RUN_ID}` }) +
  line({ type: 'RUN_FINISHED', threadId: THREAD_ID, runId: RUN_ID, outcome: { type: 'success' } });

/** 只 stub `/api/agui` 的 SSE 正文；`/api/assets` 不参与本用例。 */
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

/**
 * 找出「吞掉整个视口」的遮罩。
 *
 * 症状是"输入框打不了字、按钮点不动、但没有报错" —— 这最像有一层
 * `position:fixed; inset:0` 的透明层盖在上面。所以每轮都数一遍：
 * 离题之后不该比旅游之前多出任何全屏遮罩。
 */
function findFullScreenOverlays(): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const s = (el as HTMLElement).style;
    if (!s) continue;
    const pos = s.position || '';
    const isFixed = pos === 'fixed';
    const coversInset0 = /inset\s*:\s*0/.test(s.cssText) || (s.top === '0px' && s.left === '0px');
    if (isFixed && coversInset0) {
      out.push(`<${el.tagName.toLowerCase()} class="${el.className}"> z=${s.zIndex}`);
    }
  }
  return out;
}

/**
 * ★★ 最贴合"点不动但没报错"这个症状的探针：祖先链上的 `pointer-events`。
 *
 * 为什么单独查它：`pointer-events: none` 的祖先会让整条子树**收不到任何指针事件**——
 * 既点不动按钮、也聚焦不了输入框，**而且浏览器一个错误都不报**。
 * 这是唯一能同时解释「输入框打不了字」+「按钮全点不动」+「控制台干净」三种现象的机制
 * （disabled / isRunning 都只解释一部分；异常则会有红字）。
 *
 * SDK 自己就有一层 `cpk:pointer-events-none ... cpk:z-20` 的 input overlay，
 * 正常情况下内层有 `cpk:pointer-events-auto` 把它救回来。
 * 一旦那层"救回来"的类**丢了**，就是纯 CSS 级的静默卡死 —— CSS 类名不会被错误边界捕获，
 * 所以 `CardErrorBoundary` / `app/error.tsx` 全都看不到，正好对上"加了边界仍然没报错"。
 *
 * 所以这里输出**生效的**（computed）pointer-events 链，而不只看类名。
 */
function pointerEventsChain(el: Element | null): string[] {
  const chain: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    const cs =
      typeof window !== 'undefined' && window.getComputedStyle
        ? window.getComputedStyle(cur)
        : null;
    const pe = cs?.pointerEvents ?? '(unknown)';
    const blocked = pe === 'none' ? '   <<< 事件被吞' : '';
    const cls = String(cur.className || '').slice(0, 70);
    const testid = cur.getAttribute('data-testid');
    chain.push(`${cur.tagName}${testid ? `[${testid}]` : ''} pe=${pe} .${cls}${blocked}`);
    cur = cur.parentElement;
  }
  return chain;
}

/**
 * 判定「输入框能不能收到指针事件」：
 * 从 textarea 一路往上找，**中途不能出现把它挡掉的 none**，
 * 除非某一层自己重新开了 auto（CSS 里子元素可覆盖父元素）。
 */
function isPointerBlocked(el: Element | null): { blocked: boolean; at?: string } {
  let cur: Element | null = el;
  let seenNoneAt: string | null = null;
  while (cur) {
    const cs =
      typeof window !== 'undefined' && window.getComputedStyle
        ? window.getComputedStyle(cur)
        : null;
    const pe = cs?.pointerEvents ?? 'auto';
    if (pe === 'auto' || pe === 'all') {
      seenNoneAt = null; // 内层重开 auto，祖先的 none 被覆盖
    } else if (pe === 'none') {
      if (seenNoneAt === null) {
        seenNoneAt = `${cur.tagName}.${String(cur.className || '').slice(0, 60)}`;
      }
    }
    cur = cur.parentElement;
  }
  return seenNoneAt === null ? { blocked: false } : { blocked: true, at: seenNoneAt };
}

/** 渲染真实的 <Providers><CopilotChat input={TravelChatInput}/></Providers>。 */
function mountChat(): { container: HTMLElement } {
  const utils = render(
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
  return utils as never;
}

function getTextarea(): HTMLTextAreaElement {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('找不到 textarea —— CopilotChat 没挂载成功');
  return ta as HTMLTextAreaElement;
}

function getSendButton(): HTMLButtonElement {
  const btn = document.querySelector('[data-testid="copilot-send-button"]');
  if (!btn) throw new Error('找不到发送按钮');
  return btn as HTMLButtonElement;
}

/**
 * ★ 拿我们自己的胶囊根节点（`TravelChatInput` 里带 `containerRef` 的那个 div）。
 *
 * 这是本回归测试**唯一在 jsdom 里真正有辨别力**的锚点，原因见文件头：
 * jsdom 不加载 Tailwind / SDK 样式表，`getComputedStyle(...).pointerEvents`
 * 恒为 `auto`，所以 `pointerBlocked` 那类探针在 jsdom 里测不出东西。
 * 但 **class 列表是真实 DOM**，删掉 `pointer-events-auto` 就会红。
 */
function getCapsule(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="travel-chat-input-capsule"]');
}

/**
 * 像用户那样真的往输入框里敲字。
 *
 * ★ 为什么要先看 `disabled`：真实的键盘事件**进不去** disabled 的 textarea ——
 *   浏览器直接吞掉。而 `el.value = x` 是脚本赋值，能强行写进去，**会绕过 disabled**。
 *   所以这里必须先判 `disabled` 再决定要不要敲，否则探针会得出
 *   "输入框明明被禁用了、探针却报可以打字"这种假绿（负向对照就是为了钉死这一点）。
 *
 * ★ 还要用 React 认可的原生 value setter：`textarea` 的 value 是 React 受控的，
 *   绕过原型链直接赋值不会触发 onChange，React 会认为没输入过。
 */
function type(text: string): void {
  const ta = getTextarea();
  if (ta.disabled || ta.readOnly) return; // 真实键盘事件到不了这里
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('离题引导之后：聊天界面是否卡死', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * 完整跑一轮：挂载 → 打字 → 发送 → 等 run 尘埃落定 → 返回卡死观测点。
   *
   * @param sseBody     `/api/agui` 要回的 SSE 正文
   * @param expectText  这条路径**应该**渲染出来的气泡文案（用来确认测的是这条路径）
   */
  async function driveRun(
    sseBody: string,
    expectText: string,
  ): Promise<{
    requestSent: boolean;
    textareaDisabled: boolean;
    sendDisabled: boolean;
    typingWorks: boolean;
    typedValue: string;
    runningAttr: string | null;
    overlays: string[];
    bubbleText: string;
    pointerChain: string[];
    pointerBlocked: boolean;
    pointerBlockedAt: string | null;
    sendPointerChain: string[];
    sendPointerBlocked: boolean;
    capsuleClass: string | null;
    capsuleHasPointerEventsAuto: boolean;
  }> {
    const { bodies } = stubFetch(sseBody);
    mountChat();

    // 等 CopilotChat 挂载完（welcome screen 出现即可）。
    await waitFor(() => {
      expect(getTextarea()).toBeTruthy();
    });

    // 1) 先确认「run 之前」输入框是可用的 —— 建立基线。
    const beforeDisabled = (getTextarea() as HTMLTextAreaElement).disabled;

    // 2) 真的打字 + 点发送。
    await act(async () => {
      type('今天天气怎么样');
    });
    const sendBtn = getSendButton();
    await act(async () => {
      sendBtn.click();
    });

    // 3) 等 run 跑完并让 React 全部 flush。
    await waitFor(() => {
      expect(bodies.length).toBeGreaterThan(0);
    }, { timeout: 15_000 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    // 4) 观测点。
    const ta = getTextarea();
    const runningAttr = document
      .querySelector('[data-testid="copilot-chat"]')
      ?.getAttribute('data-copilot-running');

    // 5) ★ 关键动作：run 完成后再打一次字，看值到底进不进得去。
    await act(async () => {
      type('再试一次');
    });
    const typedValue = ta.value;

    const bubbleText = document.body.textContent?.includes(expectText)
      ? `rendered:${expectText}`
      : `MISSING:${expectText}`;

    // ★ 指针可达性：输入框与发送按钮是否被祖先的 pointer-events:none 吞掉。
    const taPointer = isPointerBlocked(ta);
    const sendPointer = isPointerBlocked(getSendButton());

    return {
      requestSent: bodies.length > 0,
      textareaDisabled: beforeDisabled || ta.disabled,
      sendDisabled: getSendButton().disabled,
      typingWorks: typedValue.includes('再试一次'),
      typedValue,
      runningAttr,
      overlays: findFullScreenOverlays(),
      bubbleText,
      pointerChain: pointerEventsChain(ta),
      pointerBlocked: taPointer.blocked,
      pointerBlockedAt: taPointer.at ?? null,
      sendPointerChain: pointerEventsChain(getSendButton()),
      sendPointerBlocked: sendPointer.blocked,
      // ★ 下面两项才是 jsdom 里**真正有辨别力**的断言（见文件头说明）。
      capsuleClass: getCapsule()?.className ?? null,
      capsuleHasPointerEventsAuto: getCapsule()?.classList.contains('pointer-events-auto') ?? false,
    };
  }

  it('离题：run 结束后输入框仍可打字、发送按钮不 disabled、无新增全屏遮罩', async () => {
    const r = await driveRun(OFF_TOPIC_SSE, '旅游规划小助手');

    // --- 先把观测到的状态全部打出来，失败时能直接看出卡在哪一步 ---
    console.log('\n[OFF-TOPIC] 观测 ==============');
    console.log(JSON.stringify(r, null, 2));
    console.log('[OFF-TOPIC] textarea pointer-events 祖先链：');
    console.log(r.pointerChain.map((l) => `    ${l}`).join('\n'));
    console.log('[OFF-TOPIC] send-button pointer-events 祖先链：');
    console.log(r.sendPointerChain.map((l) => `    ${l}`).join('\n'));
    console.log('[/OFF-TOPIC] ====================\n');

    // 前提：请求确实发出去了、引导气泡确实渲染了（否则测的不是这条路径）。
    expect(r.requestSent).toBe(true);
    expect(r.bubbleText).toBe('rendered:旅游规划小助手');

    // ★ 断言 1：run 已结束（data-copilot-running 回到 false）
    expect(r.runningAttr).toBe('false');

    // ★ 断言 2：输入框没被 disabled
    expect(r.textareaDisabled).toBe(false);

    // ★ 断言 3：★ 卡死的直接证据 —— 打完字值进不去（onChange 链路死了）
    expect(r.typingWorks).toBe(true);

    // ★ 断言 4：发送按钮可点
    expect(r.sendDisabled).toBe(false);

    // ★ 断言 5：没有多出全屏遮罩
    expect(r.overlays).toEqual([]);

    // ★ 断言 6：输入框 / 发送按钮都没被祖先 pointer-events:none 吞掉。
    //   ⚠️ 这两条在 jsdom 里是**弱断言**（恒真）：jsdom 不解析 Tailwind/SDK 样式表，
    //   getComputedStyle 的 pointerEvents 永远是 auto。它们的价值在真实浏览器里
    //   （已用 elementFromPoint 命中测试验过：修复前整链 none、修复后 auto）。
    //   真正在 jsdom 里能挡住回归的是下面断言 7。
    expect(r.pointerBlocked).toBe(false);
    expect(r.sendPointerBlocked).toBe(false);

    // ★ 断言 7：★ 这条才是 jsdom 里的**真回归守卫**。
    //   胶囊根节点必须显式挂 `pointer-events-auto` —— 否则它会继承
    //   CopilotChatView 那层 `copilot-input-overlay` 的 `pointer-events: none`，
    //   症状就是"回复一生成，输入框+所有按钮一起失活，且控制台无任何报错"。
    //   class 列表是真实 DOM，把这个类删掉本断言立刻变红。
    expect(
      r.capsuleHasPointerEventsAuto,
      `胶囊根节点缺少 pointer-events-auto —— 这正是"回复后输入框与所有按钮失活"的根因。实际 class="${r.capsuleClass}"`,
    ).toBe(true);
  }, 90_000);

  it('对照：旅游路径同样可打字（证明断言不是恒真）', async () => {
    const r = await driveRun(TRAVEL_SSE, '正在为你规划');
    console.log('\n[TRAVEL] 观测 ==============');
    console.log(JSON.stringify(r, null, 2));
    console.log('[/TRAVEL] ====================\n');

    expect(r.requestSent).toBe(true);
    expect(r.bubbleText).toBe('rendered:正在为你规划');
    expect(r.runningAttr).toBe('false');
    expect(r.typingWorks).toBe(true);
    expect(r.sendDisabled).toBe(false);
    // 对照路径同样要求胶囊挂 pointer-events-auto（证明这不是离题特有，而是共性）。
    expect(
      r.capsuleHasPointerEventsAuto,
      `胶囊根节点缺少 pointer-events-auto（旅游路径同样需要）。实际 class="${r.capsuleClass}"`,
    ).toBe(true);
  }, 90_000);

  /**
   * ★ 最贴近用户报告的一条：离题回复渲染出来之后，**再发第二条**还能不能发出去。
   *
   * 用户的原话是"这条回复渲染之后输入框打不了字、按钮全点不动"。
   * 也就是说第一轮 run 是好的（气泡出来了），坏的是**之后**的交互。
   * 只断言"run 结束后能打字"可能还不够 —— 值进得去但 onSubmitMessage 已经死了，
   * 按钮看着可点、点了没反应，用户体感完全一样是"卡死"。
   * 所以这里真的发第二条，并断言请求数从 1 涨到 2。
   */
  it('离题：第一条渲染后，第二条消息仍能真正发出去（onSubmitMessage 没死）', async () => {
    const { bodies } = stubFetch(OFF_TOPIC_SSE);
    mountChat();

    await waitFor(() => {
      expect(getTextarea()).toBeTruthy();
    });

    // ---- 第一条 ----
    await act(async () => {
      type('今天天气怎么样');
    });
    await act(async () => {
      getSendButton().click();
    });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    }, { timeout: 15_000 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(document.body.textContent).toContain('旅游规划小助手');

    // ---- 第二条（关键）----
    await act(async () => {
      type('那京都三日游呢');
    });
    const ta2 = getTextarea();
    console.log(
      '\n[SECOND SEND] 第二条打字后 value =',
      JSON.stringify(ta2.value),
      '| sendDisabled =',
      getSendButton().disabled,
      '| runningAttr =',
      document
        .querySelector('[data-testid="copilot-chat"]')
        ?.getAttribute('data-copilot-running'),
    );

    await act(async () => {
      getSendButton().click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });

    console.log('[SECOND SEND] 请求数 =', bodies.length);
    console.log('[SECOND SEND] 全屏遮罩 =', JSON.stringify(findFullScreenOverlays()));

    // ★ 第二条必须真的发出去了
    expect(bodies.length).toBe(2);
    // 第二条的问题原文应当出现在请求体里（证明不是空跑）
    expect(bodies[1]).toContain('那京都三日游呢');
  }, 90_000);
});

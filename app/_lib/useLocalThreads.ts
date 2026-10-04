'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 本地会话历史（左栏）。
 *
 * ## 为什么降级：不用 `useThreads()`
 *
 * `@copilotkit/react-core/v2` 的 `useThreads()` 看着对路，但它**背后是 CopilotKit
 * Intelligence 平台**，不是本地 API：
 *
 * - `UseThreadsResult` 的注释写明 `threads` 来自 "/ agentId" 的平台拉取 + WebSocket 实时订阅，
 *   并且 `error` 这个通道里显式包含"缺 runtimeUrl"和"runtime 未声明 thread 端点"这两类**配置错误**；
 * - 我们是纯 self-managed 链路（只有 `selfManagedAgents`，**没有 runtime**），
 *   平台上也确实没有这些会话 —— hook 会直接落到配置错误分支，返回空列表 +
 *   `error`，而且还会往一个不存在的地址发探活请求。
 *
 * 换句话说：不是"调用姿势不对"，是这条路在当前架构下**没有服务端**。
 * 等服务端的线程持久化（尤其中文终端用户侧）落地、并且真的挂上 runtime 之后，
 * 再把这里换回 `useThreads({ agentId })` 即可 —— UI 契约保持一致：
 * `Thread = { id, title, updatedAt }`。
 *
 * ## 现在的语义
 *
 * - 会话是**客户端分桶**：每条会话绑定一个 `threadId`，切换时会清空 agent 的
 *   transcript（见 `app/page.tsx` 的 `handleSelectThread`）。别把它当成"历史可读回"。
 * - 列表用 localStorage 持久化，纯本地，刷新不丢。
 * - **SSR 安全**：初始 state 必须是服务端也能算出的确定值（`DEFAULT_THREAD`，
 *   id 与时间戳都是常量，不用 Date.now()、不用 randomUUID），否则 SSR 与 hydration
 *   两边算出的 HTML 不一致，React 会报 hydration mismatch。真实历史在挂载后的
 *   effect 里再灌进来。
 */

/** localStorage 键名。改版时换后缀即可让旧数据自然失效。 */
const STORAGE_KEY = 'planning-agent.threads.v1';

/** SSR + 首次 client render 都用这条确定的会话，保证两边 HTML 一致。 */
const DEFAULT_THREAD_ID = 'thread-default';

export interface ChatThread {
  id: string;
  /** 会话标题：默认「新建会话」，用户问出第一句话后换成首个问题的截断文本。 */
  title: string;
  /** epoch ms；0 表示"还没产生过时间信息"（默认会话），UI 侧据此不渲染时间。 */
  updatedAt: number;
}

const DEFAULT_THREAD: ChatThread = {
  id: DEFAULT_THREAD_ID,
  title: '新建会话',
  updatedAt: 0,
};

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** 生成一个会话 id。只在浏览器事件回调里调用，不参与 SSR。 */
function mintThreadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `thread-${crypto.randomUUID()}`;
  }
  // 退化路径（老浏览器 / 非安全上下文）：熵低一些，但足够区分会话。
  return `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 读本地历史。失败一律打日志——红线：不许静默吞异常。 */
function readStoredThreads(): ChatThread[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const threads: ChatThread[] = parsed.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null) return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      if (id === '') return [];
      return [
        {
          id,
          title: typeof record.title === 'string' ? record.title : '新建会话',
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
        },
      ];
    });
    return threads;
  } catch (error) {
    // localStorage 被禁用 / JSON 损坏：丢弃历史并继续，但必须留痕。
    console.warn('[threads] 读取本地会话失败，已回退到默认会话', error);
    return [];
  }
}

/** 写本地历史。配额超限等失败同样要留痕。 */
function writeStoredThreads(threads: ChatThread[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
  } catch (error) {
    console.warn('[threads] 写入本地会话失败（历史不会持久化）', error);
  }
}

export interface UseLocalThreadsResult {
  threads: ChatThread[];
  activeThreadId: string;
  /** 新建会话并切到它，返回新会话 id。 */
  createThread: () => string;
  selectThread: (threadId: string) => void;
  /** 用首个用户问题给会话起标题（只在标题仍是默认值时覆盖一次）。 */
  touchThread: (threadId: string, firstQuestion: string) => void;
}

export function useLocalThreads(): UseLocalThreadsResult {
  const [threads, setThreads] = useState<ChatThread[]>([DEFAULT_THREAD]);
  const [activeThreadId, setActiveThreadId] = useState<string>(DEFAULT_THREAD_ID);

  // 挂载后从 localStorage 灌历史（客户端专属，避免 SSR/hydration 不一致）。
  useEffect(() => {
    const stored = readStoredThreads();
    if (stored.length === 0) return;
    setThreads(stored);
    setActiveThreadId(stored[0]!.id);
  }, []);

  // 变更即落盘。
  useEffect(() => {
    // 首次 effect 还没读到 localStorage，此时写盘会把存储清掉 —— 跳过。
    if (threads.length === 1 && threads[0]!.id === DEFAULT_THREAD_ID && threads[0]!.updatedAt === 0) {
      return;
    }
    writeStoredThreads(threads);
  }, [threads]);

  const createThread = useCallback((): string => {
    const id = mintThreadId();
    const next: ChatThread = { id, title: '新建会话', updatedAt: Date.now() };
    setThreads((prev) => [next, ...prev]);
    setActiveThreadId(id);
    return id;
  }, []);

  const selectThread = useCallback((threadId: string): void => {
    setActiveThreadId(threadId);
  }, []);

  const touchThread = useCallback((threadId: string, firstQuestion: string): void => {
    const nextTitle = firstQuestion.trim().slice(0, 24) || '新建会话';
    setThreads((prev) => {
      const target = prev.find((t) => t.id === threadId);
      // 已经有真实标题就不再覆盖（用户后面对话里的问题不该反复改标题）。
      if (target === undefined || target.title !== '新建会话') return prev;
      return prev.map((t) => (t.id === threadId ? { ...t, title: nextTitle, updatedAt: Date.now() } : t));
    });
  }, []);

  return { threads, activeThreadId, createThread, selectThread, touchThread };
}

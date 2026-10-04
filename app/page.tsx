'use client';

/**
 * 应用主页面（三区明亮布局）。
 *
 * ┌──────────────┬─────────────────────────────────────────────┐
 * │ 左栏 240px   │ 顶部：本轮会话的用户问题 chips（hover 出全文） │
 * │ 会话历史     ├─────────────────────────────────────────────┤
 * │              │ 正文：<CopilotChat>（计划推演活动卡自然在正文上方）│
 * └──────────────┴─────────────────────────────────────────────┘
 *
 * 关于"思考模块"：`<CopilotChat>` 自带 `CopilotChatReasoningMessage`（可折叠的
 * "Thought for Ns"），我们的「计划推演」则以 `activityType: "plan"` 的活动卡片下发，
 * 服务端保证它**先于** assistant 正文文本到达。`CopilotChat` 严格按到达顺序渲染，
 * 所以二者都天然排在正文上方 —— 这里唯一要做的就是**别用 CSS（order / row-reverse /
 * absolute 定位）把活动卡片挤到正文下面**。
 */
import { useCallback, useEffect } from 'react';
import type { Message } from '@ag-ui/core';
import { CopilotChat, useAgent, UseAgentUpdate } from '@copilotkit/react-core/v2';
import type { CopilotChatLabels } from '@copilotkit/react-core/v2';
import ThreadSidebar from './_components/ThreadSidebar';
import QuestionHistoryChips from './_components/QuestionHistoryChips';
import DomainSelector from './_components/DomainSelector';
import RunOptionsPanel from './_components/RunOptionsPanel';
import { useLocalThreads } from './_lib/useLocalThreads';
import { DEFAULT_AGENT_ID } from './providers';

/**
 * `CopilotChatDefaultLabels` 的键名有一套自己的命名（不是 `inputPlaceholder` /
 * `initial`），这里按 `Partial<CopilotChatLabels>` 约束，拼错即编译报错。
 */
const CHAT_LABELS: Partial<CopilotChatLabels> = {
  chatInputPlaceholder: '给一个目标，让 Agent 拆解出可执行的计划…',
  welcomeMessageText: '给一个目标，我会先把它拆成可执行的计划，再逐步执行。',
  modalHeaderTitle: '规划型 Agent',
  chatDisclaimerText: '计划执行过程中可以随时打断、修改步骤。',
};

/**
 * 从一条 AG-UI 消息里取出纯文本。
 *
 * 消息的 `content` 可能是 string，也可能是 content-part 数组；
 * Messages union 里还有 toolMessage / systemMessage 等没有 `content` 的分支，
 * 所以这里做防御式读取而不是直接断言。
 */
function messageToText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** 取出 transcript 里所有用户发过的问题（按顺序，去重已在调用侧按索引 key 处理）。 */
function extractUserQuestions(messages: Message[]): string[] {
  return messages
    .filter((message) => message.role === 'user')
    .map(messageToText)
    .map((text) => text.trim())
    .filter((text) => text !== '');
}

export default function Page() {
  const { threads, activeThreadId, createThread, selectThread, touchThread } = useLocalThreads();

  /**
   * `useAgent` 默认不订阅任何更新 —— 不传 `updates` 拿到的 `agent` 不会随消息变化触发重渲染。
   * 这里显式订阅 `OnMessagesChanged`，头部的问题 chips 才会跟着增长。
   */
  const { agent } = useAgent({
    agentId: DEFAULT_AGENT_ID,
    updates: [UseAgentUpdate.OnMessagesChanged],
  });

  /**
   * 每渲染都重算：上面已经订阅了 OnMessagesChanged，所以这里的计算一定是新鲜的；
   * 放进 useMemo 反而会因为 `agent.messages` 可能被原地修改而拿到陈旧值。
   */
  const questions = extractUserQuestions(agent.messages);
  const firstQuestion = questions.length > 0 ? questions[0]! : '';

  // 用户的第一个问题成为会话标题（只在这一次，见 touchThread 内的守卫）。
  useEffect(() => {
    if (firstQuestion === '') return;
    touchThread(activeThreadId, firstQuestion);
  }, [activeThreadId, firstQuestion, touchThread]);

  /**
   * 切换会话：我们的 AG-UI 端点是**按 run 无状态**的，服务端不保存 transcript，
   * 所以会话切换 = 把本地 transcript 清干净。这是当前实现的能力边界，不是 bug。
   * `key={activeThreadId}` 让聊天视图整体重挂载，避免残留输入态/滚动态。
   */
  const handleSelectThread = useCallback(
    (threadId: string): void => {
      if (threadId === activeThreadId) return;
      agent.abortRun();
      agent.setMessages([]);
      agent.threadId = threadId;
      selectThread(threadId);
    },
    [activeThreadId, agent, selectThread],
  );

  /** 新建会话：先造 id，走同一套清理逻辑。 */
  const handleCreateThread = useCallback((): void => {
    const threadId = createThread();
    agent.abortRun();
    agent.setMessages([]);
    agent.threadId = threadId;
  }, [agent, createThread]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-[var(--color-page)]">
      <ThreadSidebar
        threads={threads}
        activeThreadId={activeThreadId}
        onCreateThread={handleCreateThread}
        onSelectThread={handleSelectThread}
      />

      <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-surface)]">
        {/*
         * 顶部工具条：左边是本轮的用户问题 chips（hover 出全文），
         * 右边是领域选择器 + 运行参数（故障注入/重排）。
         * 运行参数默认折叠，不占主视觉 —— 但**必须可达**：
         * 中断（HITL）路径只有注入 simulate=clarify 才会触发。
         */}
        <div className="flex items-start justify-between gap-3 px-[var(--spacing-gutter)] pt-[var(--spacing-gutter)]">
          <div className="min-w-0 flex-1">
            <QuestionHistoryChips questions={questions} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DomainSelector />
            <RunOptionsPanel />
          </div>
        </div>

        <div className="min-h-0 flex-1 px-[var(--spacing-gutter)] pb-[var(--spacing-gutter)] pt-[var(--spacing-gap)]">
          <div className="h-full overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
            <CopilotChat
              key={activeThreadId}
              agentId={DEFAULT_AGENT_ID}
              labels={CHAT_LABELS}
              className="h-full"
            />
          </div>
        </div>
      </main>
    </div>
  );
}

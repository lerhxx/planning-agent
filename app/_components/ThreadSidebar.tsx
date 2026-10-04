'use client';

import type { ChatThread } from '@/app/_lib/useLocalThreads';

/** 会话行的时间展示：`HH:mm`（当天）/ `M月D日`（更早）。0 视为「无时间信息」。 */
function formatThreadTime(updatedAt: number): string {
  if (updatedAt === 0) return '';
  const date = new Date(updatedAt);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export interface ThreadSidebarProps {
  threads: ChatThread[];
  activeThreadId: string;
  onCreateThread: () => void;
  onSelectThread: (threadId: string) => void;
}

/**
 * 左栏：会话历史。
 *
 * 配色遵守 `app/theme.tokens.css`：面板白底 `#fff`，右侧 1px 分隔线 `--color-border`，
 * 选中行用 `--color-accent-soft` 浅蓝底 + 左侧 `--color-accent` 竖条，
 * 「新建会话」主按钮黑底 `#17181c`（参考图里的主 CTA）。
 */
export function ThreadSidebar({
  threads,
  activeThreadId,
  onCreateThread,
  onSelectThread,
}: ThreadSidebarProps) {
  return (
    <aside
      className="flex h-full w-[240px] shrink-0 flex-col border-r bg-[var(--color-card)]"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="px-[var(--spacing-gutter)] pb-[var(--spacing-gap)] pt-[var(--spacing-gutter)]">
        <button
          type="button"
          onClick={onCreateThread}
          className="w-full cursor-pointer rounded-[var(--radius-pill)] bg-[var(--color-ink)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-ink-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          + 新建会话
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-[var(--spacing-gutter)]" aria-label="会话历史">
        <ul className="flex flex-col gap-1">
          {threads.map((thread) => {
            const active = thread.id === activeThreadId;
            const time = formatThreadTime(thread.updatedAt);
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  onClick={() => onSelectThread(thread.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`relative w-full cursor-pointer rounded-[var(--radius-control)] px-3 py-2 text-left transition-colors ${
                    active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-fill-soft)]'
                  }`}
                >
                  {active ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[var(--color-accent)]"
                    />
                  ) : null}
                  <span
                    className="block truncate text-sm"
                    style={{ color: active ? 'var(--color-text-strong)' : 'var(--color-text-secondary)' }}
                  >
                    {thread.title}
                  </span>
                  {time !== '' ? (
                    <span className="mt-0.5 block text-xs" style={{ color: 'var(--color-text-weak)' }}>
                      {time}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

export default ThreadSidebar;

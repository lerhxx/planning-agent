'use client';

/**
 * 路由级错误边界（Next.js App Router 约定）。
 *
 * 兜住**所有**逃出卡片级 `CardErrorBoundary` 的未捕获异常（例如 CopilotKit 自身在
 * 消息列表渲染期的异常）。没有它时，这类异常会让整页冻结、输入框与按钮全部失活且
 * 无法恢复；有了它，至少给用户一个"重试"出口，而不是卡死。
 *
 * ★ 它替换的是整段路由，因此触发时侧栏 / 聊天 / 输入框会一起换成错误页 —— 这是最后
 * 兜底，正常情况不应被命中（卡片级 `CardErrorBoundary` 已先一步兜住卡片异常）。
 * 若需要连根布局（html/body）级别的兜底，再补 `global-error.tsx`。
 */
import { useEffect } from 'react';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactNode {
  useEffect(() => {
    // 路由级未捕获异常的唯一可靠来源，原样打到 console 便于定位根因。
    console.error('[app] 路由级未捕获异常：', error);
  }, [error]);

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-[var(--color-page)] p-6 text-center">
      <div className="max-w-md rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-card)] p-6 shadow-[var(--shadow-card)]">
        <h1 className="mb-2 text-base font-semibold text-[var(--color-text-strong)]">
          页面出了点问题
        </h1>
        <p className="mb-4 break-words text-sm text-[var(--color-text-secondary)]">
          {error.message || '渲染过程中发生未捕获的异常。'}
        </p>
        <button
          type="button"
          onClick={reset}
          className="cursor-pointer rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-2 text-sm font-medium text-[var(--color-text-strong)] transition-colors hover:bg-[var(--color-fill-soft)]"
        >
          重试
        </button>
      </div>
    </div>
  );
}

'use client';

/**
 * 卡片级错误边界（生成式 UI 专用）。
 *
 * 为什么要它：本项目反复踩的一个"整页冻结"口子 —— 任何一张生成式卡片
 * （计划卡 / 澄清卡 / 领域组件卡）在渲染时抛异常，只要没有边界兜住，React 会
 * 把**整棵**聊天树（含输入框、发送、智能解析、上传按钮）一起卸载，表现为
 * "回复一出来，输入框和所有按钮全点不动"。
 *
 * 这里把异常**只**关在出错的卡片里：
 * - 兄弟节点（其它卡片、输入框、按钮）照常工作，页面不再冻结；
 * - 出错卡片降级成一个可"重试"的小错误块；
 * - 把真实异常 + `componentStack` 打到 console，方便定位根因（这是诊断这类的
 *   关键：没有边界时，异常会冒泡到根，连报错位置都很难看）。
 *
 * ★ 只兜"渲染期"异常（含子组件 hook 执行期的异常），不兜事件回调里的异常 ——
 * 后者由各组件自己的 try/catch 负责。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface CardErrorBoundaryProps {
  children: ReactNode;
  /** 出错的卡片名（如 PlanView / ClarifyOptions / 活动类型），用于 console 区分。 */
  label?: string;
}

interface CardErrorBoundaryState {
  error: Error | null;
  showStack: boolean;
}

export default class CardErrorBoundary extends Component<
  CardErrorBoundaryProps,
  CardErrorBoundaryState
> {
  state: CardErrorBoundaryState = { error: null, showStack: false };

  static getDerivedStateFromError(error: Error): Partial<CardErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 关键诊断信息：真实异常 + 触发它的组件栈。没有边界时这些信息会随整树卸载丢失。
    console.error(
      `[agui] 生成式卡片渲染失败${this.props.label ? `（${this.props.label}）` : ''}：`,
      error,
      info.componentStack,
    );
  }

  handleReset = (): void => {
    this.setState({ error: null, showStack: false });
  };

  handleToggleStack = (): void => {
    this.setState((previous) => ({ showStack: !previous.showStack }));
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }

    return (
      <div className="w-full rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-[var(--color-danger)]/10 px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-danger)]">
            卡片渲染失败
          </span>
          <span className="text-xs text-[var(--color-text-secondary)]">
            {error.message || '未知错误'}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={this.handleReset}
            className="cursor-pointer rounded-[var(--radius-control)] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-strong)] transition-colors hover:bg-[var(--color-fill-soft)]"
          >
            重试
          </button>
          <button
            type="button"
            onClick={this.handleToggleStack}
            className="cursor-pointer rounded-[var(--radius-control)] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-strong)] transition-colors hover:bg-[var(--color-fill-soft)]"
          >
            {this.state.showStack ? '隐藏堆栈' : '查看堆栈'}
          </button>
        </div>
        {this.state.showStack ? (
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-fill-soft)] p-2 text-[10px] leading-4 text-[var(--color-text-secondary)]">
            {error.stack}
          </pre>
        ) : null}
      </div>
    );
  }
}

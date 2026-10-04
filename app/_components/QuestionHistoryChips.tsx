'use client';

/**
 * 主区顶部：本轮会话里用户提过的所有问题，做成横向 chip。
 *
 * 交互（用户明确要求）：chip 显示**截断文本**，hover 时弹出浮层展示**完整问题**。
 *
 * 为什么不用原生 `title` 属性：它的样式、出现延迟、换行规则都由浏览器决定，
 * 完全不可控，而我们要的是跟页面同一套 token 的浅灰浮层卡。
 * 为什么不用 Radix Tooltip：项目里没有把 `@radix-ui/react-tooltip` 声明为直接依赖
 * （它只是 CopilotKit 的传递依赖），为了一个 tooltip 去新增运行时依赖不划算，
 * 这里用纯 CSS `group-hover` + `focus-within` 自己写，键盘可达性也一并覆盖。
 */

/** 超过这个长度才需要省略号 + tooltip；短问题的 chip 不会误弹出浮层。 */
const TRUNCATE_THRESHOLD = 18;
/** chip 上展示的最大字符数。 */
const CHIP_MAX_LENGTH = 14;

export interface QuestionHistoryChipsProps {
  questions: string[];
}

function truncate(text: string): string {
  return text.length > TRUNCATE_THRESHOLD ? `${text.slice(0, CHIP_MAX_LENGTH)}…` : text;
}

export function QuestionHistoryChips({ questions }: QuestionHistoryChipsProps) {
  if (questions.length === 0) return null;

  return (
    <div className="px-[var(--spacing-gutter)] pt-[var(--spacing-gutter)]">
      <div className="flex flex-wrap items-center gap-2">
        {questions.map((question, index) => {
          const needsTooltip = question.length > TRUNCATE_THRESHOLD;
          return (
            <div key={`${index}-${question}`} className="group relative">
              <button
                type="button"
                // 键盘可达：focus 时也展开浮层。
                className="max-w-[220px] cursor-default truncate rounded-[var(--radius-pill)] border px-3 py-1.5 text-xs transition-colors group-hover:bg-[var(--color-accent-soft)] group-focus-within:bg-[var(--color-accent-soft)]"
                style={{
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-secondary)',
                  background: 'var(--color-card)',
                }}
                aria-label={question}
              >
                {truncate(question)}
              </button>

              {needsTooltip ? (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute left-0 top-full z-30 mt-2 hidden w-max max-w-[360px] rounded-[var(--radius-control)] border px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap shadow-[var(--shadow-float)] group-hover:block group-focus-within:block"
                  style={{
                    borderColor: 'var(--color-border)',
                    background: 'var(--color-elevated)',
                    color: 'var(--color-text-strong)',
                  }}
                >
                  {question}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default QuestionHistoryChips;

'use client';

import { useState, type ReactNode } from 'react';
import type { ChoiceGroupFieldProps } from './schema';

/**
 * ChoiceGroupField —— 分组选择题卡（参考图 IMG_2232）。
 *
 * 视觉原语：一张大圆角白卡内按题分组（组间细分隔线），每行
 * 「emoji 图标 + 标签 + 灰色括号补充说明 + 最右圆圈指示器」；
 * 单选 = 圆圈（选中填充蓝色 + 白点），多选 = 圆角方框（选中填充蓝色 + 白勾），
 * 选中行整行浅蓝高亮。题干自动带「1. 2. 3.」序号，多选题标「（可多选）」。
 *
 * 纯展示 + 本地 state：无请求、无 run 依赖，结果经 `onConfirm` 回灌。
 */
export default function ChoiceGroupField(props: Partial<ChoiceGroupFieldProps>) {
  const {
    groups = [],
    initialSelections = {},
    showIndex = true,
    multiSuffix = '（可多选）',
    confirmLabel = '确认',
    skipLabel,
    requireAll = false,
    onConfirm,
    onSkip,
  } = props;

  /** 本地草稿：`groupId -> 已选 optionId 列表`（单选组长度恒 ≤ 1）。 */
  const [selections, setSelections] = useState<Record<string, string[]>>(initialSelections);

  const selectedOf = (groupId: string): string[] => selections[groupId] ?? [];

  const toggle = (groupId: string, multi: boolean, optionId: string): void => {
    setSelections((previous) => {
      const current = previous[groupId] ?? [];
      if (multi) {
        const next = current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId];
        return { ...previous, [groupId]: next };
      }
      // 单选：重复点同一个 = 取消（允许反悔），点别的 = 换选。
      return { ...previous, [groupId]: current[0] === optionId ? [] : [optionId] };
    });
  };

  const allAnswered = groups.every((group) => selectedOf(group.id).length > 0);
  const confirmDisabled = requireAll && !allAnswered;

  /** 最右侧指示器：单选圆圈（蓝底白点）/ 多选圆角方框（蓝底白勾）。 */
  const renderIndicator = (multi: boolean, selected: boolean): ReactNode => {
    if (multi) {
      return (
        <span
          aria-hidden="true"
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 transition ${
            selected
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-on-accent)]'
              : 'border-[var(--color-border-strong)] bg-[var(--color-card)]'
          }`}
        >
          {selected ? (
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true">
              <path
                d="M2.5 6.2 5 8.7l4.5-5.4"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>
      );
    }
    return (
      <span
        aria-hidden="true"
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition ${
          selected
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]'
            : 'border-[var(--color-border-strong)] bg-[var(--color-card)]'
        }`}
      >
        {selected ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
      </span>
    );
  };

  const renderGroup = (groupIndex: number): ReactNode => {
    const group = groups[groupIndex];
    const multi = group.multi;

    return (
      <section key={group.id} className={groupIndex > 0 ? 'mt-2 border-t border-[var(--color-divider)] pt-4' : ''}>
        <h3 className="px-1 text-[15px] font-semibold leading-6 text-[var(--color-text-strong)]">
          {showIndex ? `${groupIndex + 1}. ` : ''}
          {group.title}
          {multi ? <span>{multiSuffix}</span> : null}
        </h3>

        <div className="mt-1">
          {group.options.map((option) => {
            const selected = selectedOf(group.id).includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={selected}
                onClick={() => toggle(group.id, multi, option.id)}
                className={`flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-3 text-left transition ${
                  selected ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-fill-soft)]'
                }`}
              >
                {option.emoji ? (
                  <span className="w-8 shrink-0 text-center text-[22px] leading-none">
                    {option.emoji}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 text-[15px] leading-6 text-[var(--color-text-strong)]">
                  {option.label}
                  {option.hint ? (
                    <span className="ml-1 text-[13px] text-[var(--color-text-weak)]">
                      （{option.hint}）
                    </span>
                  ) : null}
                </span>
                {renderIndicator(multi, selected)}
              </button>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="w-full rounded-[var(--radius-card)] border border-[var(--color-divider)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)]">
      {groups.map((_, index) => renderGroup(index))}

      <div className="mt-4 flex items-center justify-end gap-2">
        {skipLabel ? (
          <button
            type="button"
            onClick={() => onSkip?.()}
            className="rounded-[var(--radius-pill)] bg-[var(--color-fill-soft)] px-5 py-2.5 text-sm text-[var(--color-text-strong)] transition hover:bg-[var(--color-fill-strong)]"
          >
            {skipLabel}
          </button>
        ) : null}
        <button
          type="button"
          disabled={confirmDisabled || groups.length === 0}
          onClick={() => onConfirm?.({ ...selections })}
          className="rounded-[var(--radius-pill)] bg-[var(--color-ink)] px-6 py-2.5 text-sm text-[var(--color-text-on-accent)] transition hover:bg-[var(--color-ink-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

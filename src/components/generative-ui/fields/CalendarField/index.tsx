'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { CalendarFieldProps, CalendarTab, CalendarValue } from './schema';

/* ------------------------------------------------------------------ *
 * 纯日期工具（本地 state 驱动，不碰任何 run / 内核模块）
 * ------------------------------------------------------------------ */

const pad2 = (value: number): string => String(value).padStart(2, '0');

const toDateKey = (year: number, month: number, day: number): string =>
  `${year}-${pad2(month)}-${pad2(day)}`;

/** `month` 用 1–12，交给 Date 构造时减 1。 */
const daysInMonth = (year: number, month: number): number => new Date(year, month, 0).getDate();

/** 当月 1 号是星期几：0 = 日（与参考图「日 一 二 …」表头一致）。 */
const firstWeekday = (year: number, month: number): number => new Date(year, month - 1, 1).getDay();

const todayParts = (): { year: number; month: number; key: string } => {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    key: toDateKey(now.getFullYear(), now.getMonth() + 1, now.getDate()),
  };
};

const formatMonthLabel = (year: number, month: number): string => `${year}年${month}月`;

const parseMonth = (value: string): { year: number; month: number } | null => {
  const matched = /^(\d{4})-(\d{2})$/.exec(value);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
};

interface DayCell {
  key: string;
  day: number;
  /** 是否属于当前展示月份（跨月补位日期为 false，渲染置灰不可点）。 */
  inMonth: boolean;
}

const WEEKDAY_HEADER = ['日', '一', '二', '三', '四', '五', '六'] as const;
const FLEX_DAY_CHOICES = [2, 3, 4, 5, 6, 7] as const;

/**
 * CalendarField —— 日历/日期选择卡（参考图 IMG_2231）。
 *
 * 视觉原语：分段切换（白色胶囊浮在浅灰轨道）+ 月历网格
 * （选中=蓝色实心圆白字；范围=浅蓝胶囊背景；跨月置灰）+ 底部「次要跳过 + 黑色主确认」。
 *
 * 纯展示 + 本地 state：无请求、无 run 依赖，结果经 `onConfirm` 回灌。
 */
export default function CalendarField(props: Partial<CalendarFieldProps>) {
  const {
    tabs = ['date', 'flexible'],
    defaultTab = 'date',
    calendarMode = 'single',
    initialMonth,
    initialDate,
    initialRange,
    initialDays = 3,
    confirmLabel = '确认',
    skipLabel = '暂不设置日期',
    showSkip = true,
    onConfirm,
    onSkip,
  } = props;

  const [tab, setTab] = useState<CalendarTab>(defaultTab);

  const initialView = useMemo(() => {
    const parsed = initialMonth ? parseMonth(initialMonth) : null;
    if (parsed) return parsed;
    const today = todayParts();
    return { year: today.year, month: today.month };
  }, [initialMonth]);
  const [view, setView] = useState(initialView);

  const [single, setSingle] = useState<string | null>(initialDate ?? null);
  const [range, setRange] = useState<{ start: string | null; end: string | null }>(
    initialRange ? { start: initialRange.start, end: initialRange.end } : { start: null, end: null },
  );
  const [days, setDays] = useState<number>(initialDays);

  /** 42 格（6 周）网格：上月补位 + 当月 + 下月补位。 */
  const cells = useMemo<DayCell[]>(() => {
    const lead = firstWeekday(view.year, view.month);
    const total = daysInMonth(view.year, view.month);
    const result: DayCell[] = [];

    const prevYear = view.month === 1 ? view.year - 1 : view.year;
    const prevMonth = view.month === 1 ? 12 : view.month - 1;
    const prevTotal = daysInMonth(prevYear, prevMonth);
    for (let offset = lead - 1; offset >= 0; offset -= 1) {
      const day = prevTotal - offset;
      result.push({ key: toDateKey(prevYear, prevMonth, day), day, inMonth: false });
    }

    for (let day = 1; day <= total; day += 1) {
      result.push({ key: toDateKey(view.year, view.month, day), day, inMonth: true });
    }

    const nextYear = view.month === 12 ? view.year + 1 : view.year;
    const nextMonth = view.month === 12 ? 1 : view.month + 1;
    let tail = (7 - (result.length % 7)) % 7;
    for (let day = 1; tail > 0; day += 1, tail -= 1) {
      result.push({ key: toDateKey(nextYear, nextMonth, day), day, inMonth: false });
    }
    return result;
  }, [view]);

  /** 「灵活的天数」的候选：保证 initialDays 也在候选里（哪怕超出常规 2–7）。 */
  const flexChoices = useMemo<number[]>(() => {
    const set = new Set<number>(FLEX_DAY_CHOICES);
    set.add(days);
    return [...set].sort((a, b) => a - b);
  }, [days]);

  const handleDayClick = (cell: DayCell): void => {
    if (!cell.inMonth) return;
    if (calendarMode === 'single') {
      setSingle(cell.key);
      return;
    }
    setRange((previous) => {
      // 无起点或区间已完整 → 重新起区间；早于起点 → 换起点；否则补终点。
      if (!previous.start || previous.end !== null) return { start: cell.key, end: null };
      if (cell.key < previous.start) return { start: cell.key, end: null };
      return { start: previous.start, end: cell.key };
    });
  };

  const shiftMonth = (delta: number): void => {
    setView((previous) => {
      const month = previous.month + delta;
      if (month < 1) return { year: previous.year - 1, month: 12 };
      if (month > 12) return { year: previous.year + 1, month: 1 };
      return { year: previous.year, month };
    });
  };

  const confirmValue = (): CalendarValue | null => {
    if (tab === 'flexible') return { mode: 'flexible', days };
    if (calendarMode === 'single') return single ? { mode: 'single', date: single } : null;
    if (range.start && range.end) return { mode: 'range', start: range.start, end: range.end };
    return null;
  };
  const value = confirmValue();

  const capsuleOf = (index: number, key: string): { inCapsule: boolean; leftEdge: boolean; rightEdge: boolean } => {
    if (!range.start || !range.end || key < range.start || key > range.end) {
      return { inCapsule: false, leftEdge: false, rightEdge: false };
    }
    const previous = index > 0 ? cells[index - 1] : undefined;
    const next = index < cells.length - 1 ? cells[index + 1] : undefined;
    const inside = (cell: DayCell | undefined): boolean =>
      cell !== undefined && cell.key >= range.start! && cell.key <= range.end!;
    return {
      inCapsule: true,
      leftEdge: index % 7 === 0 || !inside(previous),
      rightEdge: index % 7 === 6 || !inside(next),
    };
  };

  const renderDayCell = (cell: DayCell, index: number): ReactNode => {
    const column = index % 7;
    const isStart = range.start === cell.key;
    const isEnd = range.end === cell.key;
    const capsule = capsuleOf(index, cell.key);
    const isRangeComplete = range.start !== null && range.end !== null;

    // 端点圆：single 选中 / 范围终点 = 蓝色实心白字；范围起点 = 浅蓝圆（参考图 4 号、18 号）。
    const solidSelected = calendarMode === 'single' ? single === cell.key : isEnd;
    const softSelected = calendarMode === 'range' && isStart && !solidSelected;

    const cellBase =
      'relative flex h-10 w-full items-center justify-center select-none';
    const capsuleClass = capsule.inCapsule && isRangeComplete
      ? `absolute inset-y-0.5 left-0 right-0 bg-[var(--color-accent-soft)] ${capsule.leftEdge ? 'rounded-l-full' : ''} ${capsule.rightEdge ? 'rounded-r-full' : ''}`
      : null;

    let circleClass =
      'z-10 flex h-9 w-9 items-center justify-center rounded-full text-[15px] transition';
    if (!cell.inMonth) {
      circleClass += ' text-[var(--color-text-weak)]';
    } else if (solidSelected) {
      circleClass += ' bg-[var(--color-accent)] text-[var(--color-text-on-accent)]';
    } else if (softSelected) {
      circleClass += ' bg-[var(--color-accent-soft-strong)] text-[var(--color-accent)]';
    } else {
      circleClass +=
        ' text-[var(--color-text-strong)] hover:bg-[var(--color-fill-soft)] cursor-pointer';
    }

    return (
      <div key={cell.key} className={cellBase} style={{ gridColumnStart: column + 1 }}>
        {capsuleClass ? <span aria-hidden="true" className={capsuleClass} /> : null}
        <button
          type="button"
          disabled={!cell.inMonth}
          aria-pressed={solidSelected || softSelected}
          aria-label={cell.key}
          onClick={() => handleDayClick(cell)}
          className={circleClass}
        >
          {cell.day}
        </button>
      </div>
    );
  };

  const renderSegmented = (): ReactNode =>
    tabs.length > 1 ? (
      <div className="mx-5 mt-4 flex rounded-[var(--radius-pill)] bg-[var(--color-fill-soft)] p-1">
        {tabs.map((item) => {
          const active = item === tab;
          return (
            <button
              key={item}
              type="button"
              aria-pressed={active}
              onClick={() => setTab(item)}
              className={`flex-1 rounded-[var(--radius-pill)] py-2 text-sm transition ${
                active
                  ? 'bg-[var(--color-card)] font-medium text-[var(--color-text-strong)] shadow-[var(--shadow-segment)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-strong)]'
              }`}
            >
              {item === 'date' ? '具体日期' : '灵活的天数'}
            </button>
          );
        })}
      </div>
    ) : null;

  const renderDatePanel = (): ReactNode => (
    <>
      <div className="mt-2 flex items-center justify-between px-3">
        <button
          type="button"
          aria-label="上一月"
          onClick={() => shiftMonth(-1)}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition hover:bg-[var(--color-fill-soft)] hover:text-[var(--color-text-strong)]"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
            <path
              d="M10 3 5 8l5 5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="text-[16px] font-semibold text-[var(--color-text-strong)]">
          {formatMonthLabel(view.year, view.month)}
        </span>
        <button
          type="button"
          aria-label="下一月"
          onClick={() => shiftMonth(1)}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition hover:bg-[var(--color-fill-soft)] hover:text-[var(--color-text-strong)]"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
            <path
              d="M6 3l5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="mt-2 grid grid-cols-7 px-3">
        {WEEKDAY_HEADER.map((label) => (
          <span
            key={label}
            className="flex h-8 items-center justify-center text-[13px] text-[var(--color-text-weak)]"
          >
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 px-3">{cells.map(renderDayCell)}</div>
    </>
  );

  const renderFlexPanel = (): ReactNode => (
    <div className="px-5 py-4">
      <p className="text-sm text-[var(--color-text-secondary)]">大概玩几天？</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {flexChoices.map((count) => {
          const active = count === days;
          return (
            <button
              key={count}
              type="button"
              aria-pressed={active}
              onClick={() => setDays(count)}
              className={`rounded-[var(--radius-pill)] px-4 py-2 text-sm transition ${
                active
                  ? 'bg-[var(--color-accent)] text-[var(--color-text-on-accent)]'
                  : 'bg-[var(--color-fill-soft)] text-[var(--color-text-strong)] hover:bg-[var(--color-fill-strong)]'
              }`}
            >
              {count} 天
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="w-full rounded-[var(--radius-card)] border border-[var(--color-divider)] bg-[var(--color-card)] pb-4 pt-4 shadow-[var(--shadow-card)]">
      {renderSegmented()}
      {tab === 'date' ? renderDatePanel() : renderFlexPanel()}

      <div className="mt-3 flex items-center justify-end gap-2 px-5">
        {showSkip ? (
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
          disabled={value === null}
          onClick={() => {
            if (value) onConfirm?.(value);
          }}
          className="rounded-[var(--radius-pill)] bg-[var(--color-ink)] px-6 py-2.5 text-sm text-[var(--color-text-on-accent)] transition hover:bg-[var(--color-ink-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

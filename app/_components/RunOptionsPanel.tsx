'use client';

import { useState, type ReactNode } from 'react';
import { useShellConfig, type RunOptions } from '@/app/providers';

/**
 * 运行期开关（故障注入 / 重排行为），收在折叠区里，默认收起、不打扰主视觉。
 *
 * ★ 为什么必须有这块面板：中断（HITL）路径如果不主动注入 `simulate: 'clarify'`，
 * 在正常执行下**永远不会触发**，等于没人验证过
 * `interrupt → resolve → resume → 内核继续` 这条链。旧页面本来就有这些开关，
 * 全量替换时不补回来就是能力回退。
 *
 * 取值走 `/api/agui` 的 `forwardedProps`，只认 `simulate` / `replanMode` /
 * `requireConstraints` 三个键（未知键被忽略，不会 400）。
 */

const SIMULATE_OPTIONS: ReadonlyArray<{ value: RunOptions['simulate']; label: string }> = [
  { value: 'none', label: '正常执行' },
  { value: 'retryable', label: '可重试失败' },
  { value: 'fatal', label: '不可恢复失败' },
  { value: 'clarify', label: '触发澄清中断' },
];

const REPLAN_OPTIONS: ReadonlyArray<{ value: RunOptions['replanMode']; label: string }> = [
  { value: 'diverge', label: '换方案' },
  { value: 'stagnant', label: '原地打转' },
];

/** 三项都处在默认值 → 折叠按钮不显示红点。 */
function isDefault(options: RunOptions): boolean {
  return (
    options.simulate === 'none' && options.replanMode === 'diverge' && !options.requireConstraints
  );
}

export function RunOptionsPanel() {
  const { runOptions, setRunOptions } = useShellConfig();
  const [open, setOpen] = useState<boolean>(false);
  const dirty = !isDefault(runOptions);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-pill)] border px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-fill-soft)]"
        style={{
          borderColor: 'var(--color-border)',
          color: 'var(--color-text-secondary)',
          background: 'var(--color-card)',
        }}
      >
        运行参数
        {dirty ? (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--color-accent)' }}
          />
        ) : null}
        <span aria-hidden="true" className="text-[10px]">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open ? (
        <div
          className="absolute right-0 top-full z-40 mt-2 w-[320px] rounded-[var(--radius-control)] border p-4 shadow-[var(--shadow-float)]"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-elevated)',
          }}
        >
          <OptionRow label="故障注入">
            {SIMULATE_OPTIONS.map((option) => (
              <Chip
                key={option.value}
                active={runOptions.simulate === option.value}
                onClick={() => setRunOptions({ simulate: option.value })}
              >
                {option.label}
              </Chip>
            ))}
          </OptionRow>

          <OptionRow label="重排行为">
            {REPLAN_OPTIONS.map((option) => (
              <Chip
                key={option.value}
                active={runOptions.replanMode === option.value}
                onClick={() => setRunOptions({ replanMode: option.value })}
              >
                {option.label}
              </Chip>
            ))}
          </OptionRow>

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={runOptions.requireConstraints}
              onChange={(event) => setRunOptions({ requireConstraints: event.target.checked })}
              className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
            />
            <span style={{ color: 'var(--color-text-secondary)' }}>强制先澄清约束</span>
          </label>

          <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-text-weak)' }}>
            这些开关随下一次提问一起发给 <code>/api/agui</code>（forwardedProps），
            只影响新发起的那一轮，不改已经跑完的历史。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function OptionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 text-[11px]" style={{ color: 'var(--color-text-weak)' }}>
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="cursor-pointer rounded-[var(--radius-pill)] border px-2.5 py-1 text-xs transition-colors"
      style={{
        borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
        background: active ? 'var(--color-accent-soft)' : 'var(--color-card)',
        color: active ? 'var(--color-accent-strong)' : 'var(--color-text-secondary)',
      }}
    >
      {children}
    </button>
  );
}

export default RunOptionsPanel;

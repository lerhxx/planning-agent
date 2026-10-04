'use client';

import { useShellConfig } from '@/app/providers';
import { domainOptions } from '@/src/domains/ui';

/**
 * 领域选择器。
 *
 * ★ 传出去的必须是 `domainOptions[].id`（小写标识符），**不是** `.label`：
 * `/api/agui` 对 domainId 强校验，不在注册表里直接 400 `UNKNOWN_DOMAIN`，
 * 而 label 是中文展示名，传过去必挂。这里干脆不给 label 单独出口，
 * 从源头上杜绝"拿展示值当 id 发"。
 */
export function DomainSelector() {
  const { domainId, setDomainId } = useShellConfig();

  return (
    <div
      role="radiogroup"
      aria-label="领域"
      className="flex items-center gap-0.5 rounded-[var(--radius-pill)] bg-[var(--color-fill-soft)] p-0.5"
    >
      {domainOptions.map((option) => {
        const active = option.id === domainId;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setDomainId(option.id)}
            className={`cursor-pointer rounded-[var(--radius-pill)] px-3 py-1 text-xs transition-colors ${
              active
                ? 'bg-[var(--color-card)] text-[var(--color-text-strong)] shadow-[var(--shadow-segment)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-strong)]'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default DomainSelector;

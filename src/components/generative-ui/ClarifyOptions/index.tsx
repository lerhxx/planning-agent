'use client';

import { useState, type ReactNode } from 'react';
import type { ClarifyField } from '@/shared/plan/types';
import type { ComponentAction, ClarifyOptionsProps } from './schema';

/**
 * 兜底组件 2/3：澄清点选 / 澄清表单。
 *
 * ★ **容器固定为内联气泡**：不做模态，也不按字段数分流成别的容器 ——
 * 字段是流式逐条长出来的，容器若随字段数变化会整块闪。
 *
 * ★ **本地草稿 + 一次提交**：表单填完才回灌一次，
 * 否则多字段表单会变成"一个字段一次重发"。
 *
 * 交互通过 `onAction` 回灌，组件内不发请求。
 */
export default function ClarifyOptions(
  props: Partial<ClarifyOptionsProps> & {
    onAction?: (action: ComponentAction) => void;
  },
) {
  const options = props.options ?? [];
  const fields = props.fields ?? [];
  /** 本地草稿：string = 单值；string[] = 多选（提交时 JSON 编码）。 */
  const [draft, setDraft] = useState<Record<string, string | string[]>>({});

  const valueOf = (field: ClarifyField): string | string[] => draft[field.id] ?? field.default ?? '';

  const setValue = (fieldId: string, value: string | string[]): void => {
    setDraft((previous) => ({ ...previous, [fieldId]: value }));
  };

  const isBlank = (value: string | string[]): boolean =>
    Array.isArray(value) ? value.length === 0 : value.trim().length === 0;

  const missingRequired = fields.filter((field) => field.required && isBlank(valueOf(field)));

  const submit = (): void => {
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = valueOf(field);
      // 多选：JSON 数组编码成 string，让 `answers: Record<string,string>` 一行都不用改。
      values[field.id] = Array.isArray(value) ? JSON.stringify(value) : String(value).trim();
    }
    props.onAction?.({ type: 'submit_form', questionId: props.questionId, values });
  };

  const renderControl = (field: ClarifyField): ReactNode => {
    const value = valueOf(field);
    const base =
      'w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5 text-xs text-[var(--color-text-strong)] outline-none transition focus:border-[var(--color-accent)]';

    switch (field.kind) {
      case 'number':
        return (
          <input
            type="number"
            className={base}
            value={typeof value === 'string' ? value : ''}
            min={field.min}
            max={field.max}
            onChange={(event) => setValue(field.id, event.target.value)}
          />
        );
      case 'date':
        return (
          <input
            type="date"
            className={base}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => setValue(field.id, event.target.value)}
          />
        );
      case 'multi':
        return (
          <div className="flex flex-wrap gap-2">
            {field.options.length === 0 ? (
              <span className="text-[11px] text-[var(--color-text-weak)]">暂无候选项</span>
            ) : (
              field.options.map((option) => {
                const selected = Array.isArray(value) && value.includes(option.id);
                return (
                  <label
                    key={option.id}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-control)] border px-2 py-1 text-xs transition ${
                      selected
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]'
                        : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-fill-soft)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => {
                        const current = Array.isArray(value) ? value : [];
                        setValue(
                          field.id,
                          event.target.checked
                            ? [...current, option.id]
                            : current.filter((item) => item !== option.id),
                        );
                      }}
                    />
                    {option.label}
                  </label>
                );
              })
            )}
          </div>
        );
      // `select` 与 `image-ref` 同构：后者只是"候选来自本次输入的附件"，
      // 组件不认识"图片"，只按 options 渲染下拉。
      case 'select':
      case 'image-ref':
        return (
          <select
            className={base}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => setValue(field.id, event.target.value)}
          >
            <option value="">（未选择）</option>
            {field.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        );
      case 'text':
      default:
        return (
          <input
            type="text"
            className={base}
            value={typeof value === 'string' ? value : ''}
            maxLength={field.maxLength}
            pattern={field.pattern}
            onChange={(event) => setValue(field.id, event.target.value)}
          />
        );
    }
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-accent-soft-strong)] bg-[var(--color-accent-mist)] p-3 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent-strong)]">
          需要你决定
        </span>
      </div>
      <p className="mb-3 text-sm text-[var(--color-text-strong)]">
        {props.prompt ?? '请选择一种继续方式'}
      </p>

      {fields.length > 0 ? (
        <div className="space-y-3">
          {fields.map((field) => (
            <div key={field.id}>
              <label className="mb-1 block text-xs text-[var(--color-text-secondary)]">
                {field.label}
                {field.required ? (
                  <span className="ml-1 text-[var(--color-danger)]">*</span>
                ) : null}
              </label>
              {renderControl(field)}
              {field.description ? (
                <p className="mt-1 text-[11px] text-[var(--color-text-weak)]">
                  {field.description}
                </p>
              ) : null}
            </div>
          ))}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={missingRequired.length > 0}
              onClick={submit}
              className="rounded-[var(--radius-control)] bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-on-accent)] transition hover:bg-[var(--color-ink-hover)] disabled:opacity-40"
            >
              提交
            </button>
            {missingRequired.length > 0 ? (
              <span className="text-[11px] text-[var(--color-text-weak)]">
                还有 {missingRequired.length} 项必填未完成
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.length === 0 ? (
            <span className="text-[11px] text-[var(--color-text-weak)]">暂无候选项</span>
          ) : (
            options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() =>
                  props.onAction?.({
                    type: 'select_option',
                    questionId: props.questionId,
                    optionId: option.id,
                  })
                }
                className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-xs text-[var(--color-text-strong)] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-fill-soft)]"
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      )}

      {props.traceId ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-weak)]">traceId {props.traceId}</p>
      ) : null}
    </div>
  );
}

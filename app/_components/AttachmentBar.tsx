'use client';

import { useRef } from 'react';
import { useShellConfig } from '@/app/providers';
import { ATTACHMENT_MAX_COUNT } from '@/shared/plan/types';

/**
 * 附件工具条（聊天区上方，紧凑一行）。
 *
 * ★ 两条从旧页面继承下来的纪律，改动前先看懂：
 *
 * 1. **不在 UI 层过滤文件类型。** 用户给的每一个文件都原样交给 `useAttachments()`，
 *    由它统一决定"哪些走上传、哪些被忽略"，并且**把被忽略的点名说出来**（`notice`）——
 *    在这里偷偷 filter 掉非图片，用户拖一个 pdf 进来会看到界面毫无变化，
 *    那是静默丢失（本项目反复撞到的同一类病）。
 *    （`accept` 只是系统文件选择器的**默认筛选**，不阻止拖拽其它类型 —— 与这条不冲突。）
 *
 * 2. **失败必须可见。** `error` 用危险色、`notice` 用弱化色，两者都直接渲染到页面上。
 *
 * 位置说明：`<CopilotChat>` 自带的输入框不接受外部注入按钮，这里**没有**为了塞按钮
 * 而 eject 掉它的 UI（那样这次换壳的收益就没了），而是把工具条放在聊天区上方。
 */
export function AttachmentBar() {
  const { attachments, attachmentNotice, awaitingUploads } = useShellConfig();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // `attachments`（真正随提问发出去的）只含 ready 的，所以"本轮会带上几张"要说这个数，
  // 不能说 items.length —— 后者把还在传的和失败的也算进去了，会误导。
  const readyCount = attachments.attachments.length;
  const notReadyCount = attachments.items.length - readyCount;
  // 等待提示要说"正在传几张"（失败的那几张永远等不来，算进去会一直显示错误的数字）。
  const uploadingCount = attachments.items.filter((item) => item.status === 'uploading').length;

  return (
    <div className="px-[var(--spacing-gutter)] pt-[var(--spacing-gap)]">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(event) => {
            // 全量交给 hook，不在这里 filter；清空 value 以便同一个文件能再次选中。
            void attachments.add(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={attachments.uploading}
          className="cursor-pointer rounded-[var(--radius-pill)] border px-3 py-1 text-xs transition-colors hover:bg-[var(--color-fill-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-secondary)',
            background: 'var(--color-card)',
          }}
        >
          {attachments.uploading ? '上传中…' : '+ 加图'}
        </button>

        {/*
         * 计数文案：把三件事说清楚 —— 本轮会带上几张 / 发完不清空 / 有清空入口。
         * 原来的「N / 20」只给了个比值，用户既可能以为发完就清了，
         * 也可能不知道下一次提问还会带上，两种误解都会造成"我以为传了/没传"的错位。
         */}
        <span className="text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
          本轮提问会带上 {readyCount} 张图片，发完不自动清空（下次提问仍会带上，要移除点「清空」）
        </span>
        <span className="text-[11px]" style={{ color: 'var(--color-text-weak)' }}>
          最多 {ATTACHMENT_MAX_COUNT} 张 · PNG / JPEG / WebP / GIF
        </span>

        {attachments.items.length > 0 ? (
          <button
            type="button"
            onClick={attachments.clear}
            className="cursor-pointer text-[11px] underline underline-offset-2"
            style={{ color: 'var(--color-text-weak)' }}
          >
            清空
          </button>
        ) : null}
      </div>

      {/*
       * ★ 在途/未就绪的醒目提示（不是弱化色的 notice）。
       * 一旦有图片没传完，"发送会不会漏掉它们"是用户**最需要知道**的事，
       * 弱化色会被当成装饰性说明一扫而过 —— 那等于没说。
       * 行为由 `providers.tsx` 的 `waitForPendingUploads` 保证：发送会先等，
       * 等不到也会在 `attachmentNotice` 里明确报数，绝不静默少发。
       */}
      {awaitingUploads ? (
        <p
          className="mt-2 rounded-[var(--radius-control)] border px-2.5 py-1.5 text-[11px]"
          role="status"
          aria-live="polite"
          style={{
            borderColor: 'var(--color-accent-soft-strong)',
            background: 'var(--color-accent-mist)',
            color: 'var(--color-accent-strong)',
          }}
        >
          正在等 {uploadingCount} 张图片上传完成，传完后会随这次提问一起发出，请稍候…
        </p>
      ) : notReadyCount > 0 ? (
        <p
          className="mt-2 rounded-[var(--radius-control)] border px-2.5 py-1.5 text-[11px]"
          role="status"
          style={{
            borderColor: 'var(--color-accent-soft-strong)',
            background: 'var(--color-accent-mist)',
            color: 'var(--color-accent-strong)',
          }}
        >
          还有 {notReadyCount} 张尚未就绪（上传中或上传失败），现在发送会先等它们传完；
          等不到也不会悄悄少发，会在下面明确告诉你本轮少了几张。
        </p>
      ) : null}

      {/* 本轮的实际结果回执：真少了才出现。发完不自动清空，用户下次提问前都看得见。 */}
      {attachmentNotice.length > 0 ? (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-danger)' }} role="alert">
          {attachmentNotice}
        </p>
      ) : null}

      {/* 已选文件：缩略 + 状态 + 删除 */}
      {attachments.items.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {attachments.items.map((item) => (
            <li key={item.id}>
              <span
                className="flex items-center gap-1.5 rounded-[var(--radius-control)] border px-2 py-1 text-[11px]"
                style={{
                  borderColor:
                    item.status === 'error' ? 'var(--color-danger)' : 'var(--color-border)',
                  color:
                    item.status === 'error'
                      ? 'var(--color-danger)'
                      : item.status === 'uploading'
                        ? 'var(--color-text-weak)'
                        : 'var(--color-text-secondary)',
                  background: 'var(--color-card)',
                }}
              >
                <span className="max-w-[160px] truncate">{item.name}</span>
                {item.status === 'uploading' ? <span>上传中…</span> : null}
                {item.status === 'error' ? <span>失败：{item.error}</span> : null}
                <button
                  type="button"
                  onClick={() => attachments.remove(item.id)}
                  aria-label={`移除 ${item.name}`}
                  className="cursor-pointer"
                  style={{ color: 'var(--color-text-weak)' }}
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* 硬失败：超限 / 上传失败 / 一个图片都没剩下 */}
      {attachments.error ? (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-danger)' }} role="alert">
          {attachments.error}
        </p>
      ) : null}

      {/* 非阻塞提示："已忽略 N 个非图片文件…" —— 不阻断，但必须被看见 */}
      {attachments.notice.length > 0 && attachments.error.length === 0 ? (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
          {attachments.notice}
        </p>
      ) : null}
    </div>
  );
}

export default AttachmentBar;

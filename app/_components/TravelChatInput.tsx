'use client';

/**
 * 聊天输入框（compose bar）—— 按"行程规划"场景重做的胶囊。
 *
 * 设计约束（动这里之前先读）：
 *
 * 1. **这是 `<CopilotChat>` 的 `input` 插槽组件，不是独立输入框。**
 *    `<CopilotChat input={TravelChatInput} />` 会把 `value` / `onChange` / `onSubmitMessage`
 *    / `containerRef` 等通过 props 注入；真正的文本态由 `<CopilotChat>` 内部持有。
 *    我们**只**用 `props.onChange(text)` 把文字写回内部输入态 —— 这是"智能解析"填充的
 *    唯一通道（不要自作主张去改 `value` 或 eject 掉 SDK 输入框，那会把换壳收益赔回去）。
 *
 * 2. **`containerRef` 必须挂到胶囊根节点。**
 *    `<CopilotChatView>` 读它算滚动留白；不挂 → 最后一条消息被输入框盖住。
 *
 * 3. **不要覆盖 `args.textArea` 的 className。** SDK 自带 textarea 有自己的样式与
 *    自适应高度逻辑，外套一层即可，别塞 className 进去。
 *
 * 4. **上传从这里走，不再在 AttachmentBar 里放文件控件。**
 *    附件草稿（`useAttachments`）是"外壳级"的，run 时由 `providers.tsx` 中间件读走；
 *    这里只负责把选中的文件交给 `attachments.add`，UI 层不预先过滤类型
 *    （被忽略的非图片由 hook 用 `notice` 点名，避免静默丢失）。
 *
 * 5. **样式走设计令牌（CSS 变量），不要 `cpk:` 前缀。** `cpk:` 是 SDK 内部命名空间，
 *    我们的壳层一律用 `app/theme.tokens.css` 里的 `--color-*` / `--radius-*` 令牌。
 */

import { useRef } from 'react';
import { CopilotChatInput, type CopilotChatInputProps } from '@copilotkit/react-core/v2';
import { useShellConfig } from '@/app/providers';

/**
 * 点击"智能解析"时填入输入框的提示语。
 *
 * 它**只填字、不发送**：用户填完可以再看一眼、改一改再发。这是有意的设计 ——
 * "自动识别并整理行程"是个偏重的动作，不该在用户还没确认文案时就触发。
 */
export const SMART_PARSE_TEXT = '贴上行程文字或上传图片，帮你识别并整理 行程';

/** 上传控件接受的图片类型（系统文件选择器的默认筛选；不阻止拖拽其它类型，那由 hook 裁决）。 */
const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif';

/** 一个朴素的上传图标（不引第三方图标库，避免又多一个 bundle 依赖）。 */
function UploadIcon(): React.ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

/**
 * 自定义聊天输入框：顶部一行文本区，底部一行「左 智能解析 / 右 上传 + 发送」，
 * 胶囊下方是 disclaimer。
 */
export function TravelChatInput(props: CopilotChatInputProps): React.ReactNode {
  const { attachments } = useShellConfig();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 智能解析用外壳注入的 onChange 把提示语写回内部输入态；缺 onChange 时按钮禁用。
  const { onChange } = props;

  return (
    <CopilotChatInput {...props}>
      {(args) => (
        <div
          ref={args.containerRef}
          className="flex flex-col rounded-[var(--radius-card)] border px-3 py-2 shadow-[var(--shadow-float)]"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-card)' }}
        >
          {/* 第一行：文本输入区（SDK 自带 textarea，不覆盖其 className）。 */}
          <div className="min-w-0 flex-1 py-1">{args.textArea}</div>

          {/* 第二行：左「智能解析」工具按钮；右「上传图片 + 发送」。 */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => onChange?.(SMART_PARSE_TEXT)}
              disabled={!onChange}
              title={
                onChange
                  ? '把输入框内容替换为智能解析提示语（仅填字，不自动发送）'
                  : '当前输入不支持填充文本'
              }
              className="cursor-pointer rounded-[var(--radius-pill)] border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--color-fill-soft)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                borderColor: 'var(--color-accent-soft-strong)',
                color: 'var(--color-accent-strong)',
                background: 'var(--color-card)',
              }}
            >
              智能解析
            </button>

            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_IMAGE_TYPES}
                hidden
                onChange={(event) => {
                  // 全量交给 hook，不在这里 filter；清空 value 以便同一文件能再次选中。
                  void attachments.add(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={attachments.uploading}
                aria-label="上传图片"
                title="上传行程图片（PNG / JPEG / WebP / GIF）"
                className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] border text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-fill-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ borderColor: 'var(--color-border)', background: 'var(--color-card)' }}
              >
                {attachments.uploading ? (
                  <span className="text-[11px]">上传中…</span>
                ) : (
                  <UploadIcon />
                )}
              </button>

              {/* SDK 自带发送按钮（已绑定 data-testid="copilot-send-button" 与 disabled 逻辑）。 */}
              {args.sendButton}
            </div>
          </div>

          {/* 胶囊下方的免责声明（文案来自 CopilotChat 的 labels，缺省回落 SDK 默认）。 */}
          {args.disclaimer}
        </div>
      )}
    </CopilotChatInput>
  );
}

export default TravelChatInput;

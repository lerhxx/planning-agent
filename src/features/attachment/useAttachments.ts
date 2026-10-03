'use client';

/**
 * 附件草稿态（客户端）。
 *
 * 四条约定：
 * - **重名共存**：系统不改用户数据，同名文件各占一条（K2）；
 * - **数量上限**：超过 `ATTACHMENT_MAX_COUNT` 显式报错，不静默裁剪；
 * - **只透传**：本 hook 不解析附件的任何语义，只维护 id / name / 状态；
 * - 上传完成前用本地临时 id，完成后替换成服务端 assetId（K1）。
 *
 * 位于 `src/features/**`（L-B）：不得出现任何领域词。
 */
import { useCallback, useMemo, useState } from 'react';
import { ATTACHMENT_MAX_COUNT, type Attachment } from '@/shared/plan/types';
import { makeTempAttachmentId, uploadAssets } from './uploadAssets';

export type AttachmentDraftStatus = 'uploading' | 'ready' | 'error';

export interface AttachmentDraft extends Attachment {
  status: AttachmentDraftStatus;
  /** 单条失败原因（显式展示，不静默丢弃）。 */
  error?: string;
}

export interface UseAttachments {
  items: AttachmentDraft[];
  /** 已就绪、可直接随 `/api/run` 透传的描述符。 */
  attachments: Attachment[];
  error: string;
  uploading: boolean;
  add: (files: readonly File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
}

export function useAttachments(): UseAttachments {
  const [items, setItems] = useState<AttachmentDraft[]>([]);
  const [error, setError] = useState<string>('');

  const add = useCallback(async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    setError('');

    const drafts: AttachmentDraft[] = files.map((file) => ({
      id: makeTempAttachmentId(),
      kind: 'image',
      name: file.name,
      mimeType: file.type.length > 0 ? file.type : undefined,
      byteSize: file.size,
      status: 'uploading',
    }));

    // 重名共存：不去重、不改名，全量插入。上限在下一行统一判。
    const merged = [...items, ...drafts];
    if (merged.length > ATTACHMENT_MAX_COUNT) {
      setError(
        `一次最多上传 ${ATTACHMENT_MAX_COUNT} 个附件，现在有 ${merged.length} 个，请先删掉一些再发。`,
      );
      return;
    }
    setItems(merged);

    const { assets, error: uploadError } = await uploadAssets(files);
    if (uploadError.length > 0) {
      // 失败的三条留在列表里并标红，让用户自己删 —— 不静默替他决定。
      const failedIds = new Set(drafts.map((draft) => draft.id));
      setItems((previous) =>
        previous.map((item) =>
          failedIds.has(item.id) ? { ...item, status: 'error', error: uploadError } : item,
        ),
      );
      setError(uploadError);
      return;
    }

    const replacements = new Map<string, Attachment>();
    drafts.forEach((draft, index) => {
      const asset = assets[index];
      if (asset) replacements.set(draft.id, asset);
    });
    setItems((previous) =>
      previous.map((item) => {
        const asset = replacements.get(item.id);
        return asset ? { ...asset, status: 'ready' } : item;
      }),
    );
  }, [items]);

  const remove = useCallback((id: string): void => {
    setItems((previous) => previous.filter((item) => item.id !== id));
    setError('');
  }, []);

  const clear = useCallback((): void => {
    setItems([]);
    setError('');
  }, []);

  const attachments = useMemo<Attachment[]>(
    () =>
      items
        .filter((item) => item.status === 'ready')
        .map(({ id, kind, name, mimeType, byteSize, ref }) => ({
          id,
          kind,
          name,
          mimeType,
          byteSize,
          ref,
        })),
    [items],
  );

  const uploading = items.some((item) => item.status === 'uploading');

  return { items, attachments, error, uploading, add, remove, clear };
}

'use client';

/**
 * 附件草稿态（客户端）。
 *
 * 五条约定：
 * - **重名共存**：系统不改用户数据，同名文件各占一条（K2）；
 * - **数量上限**：超过 `ATTACHMENT_MAX_COUNT` 显式报错，不静默裁剪；
 * - **只透传**：本 hook 不解析附件的任何语义，只维护 id / name / 状态；
 * - 上传完成前用本地临时 id，完成后替换成服务端 assetId（K1）；
 * - ★ **不静默丢东西**：非图片文件被"忽略"时必须**说出来**（`notice`），
 *   一个都没剩下时升级成 `error`。静默丢弃是本项目反复撞到的同一类病。
 *
 * 位于 `src/features/**`（L-B）：不得出现任何领域词。
 */
import { useCallback, useMemo, useState } from 'react';
import { ATTACHMENT_MAX_COUNT, type Attachment } from '@/shared/plan/types';
import { makeTempAttachmentId, describeIgnoredFiles, partitionFiles, uploadAssets } from './uploadAssets';

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
  /** 硬失败（上传失败 / 超限）：必须被看见。 */
  error: string;
  /** 非阻塞提示（例如"已忽略 N 个非图片文件"）：不阻断，但**必须被看见**。 */
  notice: string;
  uploading: boolean;
  add: (files: readonly File[]) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
}

export function useAttachments(): UseAttachments {
  const [items, setItems] = useState<AttachmentDraft[]>([]);
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');

  const add = useCallback(async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    setError('');
    setNotice('');

    // ★ 先分区，再决定：被忽略的那批**必须**被说出来，不能悄悄没了。
    const { accepted, ignored } = partitionFiles(files);
    const ignoredText = describeIgnoredFiles(ignored);
    if (ignoredText.length > 0) setNotice(ignoredText);

    // 一个图片都没剩下：没有任何后续动作发生，所以升级成 error ——
    // 否则用户拖了个 pdf 进来，界面毫无变化。
    if (accepted.length === 0) {
      if (ignoredText.length > 0) setError(ignoredText);
      return;
    }

    const drafts: AttachmentDraft[] = accepted.map((file) => ({
      id: makeTempAttachmentId(),
      kind: 'image',
      name: file.name,
      mimeType: file.type || undefined,
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

    const { assets, error: uploadError } = await uploadAssets(accepted);
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
    setNotice('');
  }, []);

  const clear = useCallback((): void => {
    setItems([]);
    setError('');
    setNotice('');
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

  return { items, attachments, error, notice, uploading, add, remove, clear };
}

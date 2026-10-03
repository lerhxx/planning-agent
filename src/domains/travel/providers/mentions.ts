/**
 * 领域段 ③ · 子模块 ⑤：`mentions.ts` —— `@+图片名` 的**三态解析**（纯函数）。
 *
 * 边界（设计 §5.2）：
 * - **做**：把文本里的 `@xxx` 提及解析成三态（matched / ambiguous / unresolved），并给出关联到的 assetId 与说明文本；
 * - **不做**：图片识别（→ `vision.ts`）、澄清载荷构造（需要新的契约类型，下一批再补）、行程编排。
 *
 * 依赖：`mentions.ts` **只依赖 `shared/plan`**（设计 §5.3）—— 它处理的是"文本 ↔ assetId"，
 * 不认识任何数据源。
 *
 * ★ 三态不是过度设计，是**反静默**要求（PRD §3.4 v0.2 改判）：
 * - `ambiguous`：同名多命中时**全关联**，绝不静默挑第一个 —— 静默挑第一个 = 把用户的说明挂到错图 = 事实伪造；
 * - `unresolved`：0 命中时**不关联任何图**，交给调用方走澄清（用户看得见），绝不静默丢弃、也绝不阻断整轮。
 *
 * ⚠️ 本文件只做**解析**。把三态翻译成 `ClarifyField[]` 需要 `zClarifyField` / `image-ref` 字段类型，
 * 等契约 landed 后在同一文件内补齐（设计 §9 / T03 第二批）。
 */
import type { Attachment } from '@/shared/plan/types';

/** 提及解析只需要附件的这两个字段（从契约类型 `Attachment` 派生，不手写第二份）。 */
export type MentionableAsset = Pick<Attachment, 'id' | 'name'>;

/** 提及的三态。 */
export type MentionState = 'matched' | 'ambiguous' | 'unresolved';

export interface ImageMention {
  /** 原文本里的 token（**不含**前导 `@`）。 */
  token: string;
  state: MentionState;
  /**
   * 命中的 assetId：
   * - `matched` → 恰好 1 个；
   * - `ambiguous` → **全部**命中（按入参顺序）；
   * - `unresolved` → 空数组（**不猜**，一个都不挂）。
   */
  assetIds: string[];
  /** 命中个数（= `assetIds.length`，外露是为了让断言读起来更直白）。 */
  hitCount: number;
  /** 该提及之后、下一个提及之前的说明文本（trim 过，且 `@@` 已反转义为 `@`）。 */
  note: string;
}

export interface ParsedImageMentions {
  /** 按出现顺序排列的全部提及。 */
  mentions: ImageMention[];
  /** 三态计数。 */
  counts: Readonly<Record<MentionState, number>>;
  /** 出现歧义的 token（去重、保序）—— UI 用它提示"该名称命中 N 张"。 */
  ambiguousTokens: string[];
  /** 0 命中的 token（去重、保序）—— 澄清载荷的输入。 */
  unresolvedTokens: string[];
  /** 没有任何合法提及（含"只有 `@@` 转义"的情况）→ true，调用方据此跳过澄清。 */
  empty: boolean;
  /** 全部被关联到的 assetId（去重、按首次出现顺序）。 */
  matchedAssetIds: string[];
}

/**
 * token 允许的字符集：中文 + 字母 + 数字 + `. _ -`。
 *
 * ⚠️ PRD §3.4 的表格里 `.` 同时出现在「字符集」与「终止符」两栏（字面冲突）。
 * 本实现的取舍：**`.` 属于 token，但匹配时逐级去掉扩展名回退**。
 * 两种读法在 `@外滩.jpg` / `@IMG_001.jpg` 上结果**完全一致**（都命中）；
 * 差别只在多段点号名（如 `my.photo.jpg`），本实现按"最长优先、逐级回退"处理，
 * 回退仍无命中则落到 `unresolved`（走澄清，不静默）。
 */
const TOKEN_CHAR_PATTERN = /[0-9A-Za-z\u4e00-\u9fff._-]/;

/** 去掉最后一段扩展名：`外滩.jpg → 外滩`；没有点号则原样返回。 */
function stripExtension(name: string): string {
  return name.replace(/\.[^.]*$/, '');
}

/**
 * 一个 token 的匹配候选，按**最长优先**排列：`IMG_001.jpg → ['IMG_001.jpg', 'IMG_001']`。
 *
 * 与 PRD「先按完整文件名精确匹配，未命中再按去掉扩展名匹配」是同一个口径的推广。
 */
function candidateLevels(token: string): string[] {
  const levels: string[] = [token];
  let current = token;
  for (;;) {
    const next = stripExtension(current);
    if (next === current) break;
    levels.push(next);
    current = next;
  }
  return levels;
}

/**
 * 匹配一个 token。**纯函数**。
 *
 * 逐级回退：先在该级上按**完整文件名**精确匹配，未命中再按**去扩展名**匹配；
 * 命中即停（不再往更短的级回退），因此结果是确定的。
 */
function matchAssets(token: string, assets: readonly MentionableAsset[]): string[] {
  for (const level of candidateLevels(token)) {
    const byName = assets.filter((asset) => asset.name === level).map((asset) => asset.id);
    if (byName.length > 0) return [...new Set(byName)];
    const byStem = assets
      .filter((asset) => stripExtension(asset.name) === level)
      .map((asset) => asset.id);
    if (byStem.length > 0) return [...new Set(byStem)];
  }
  return [];
}

interface RawMention {
  token: string;
  /** `@` 在原文本中的下标。 */
  at: number;
  /** token 结束处的下标（= 说明文本的起点）。 */
  noteStart: number;
}

/**
 * 扫出文本里全部合法的 `@` 提及。**纯函数**。
 *
 * - `@@` 视为字面 `@`，不成提及；
 * - `@` 后紧跟空白 / 标点 / 到串尾 → 不成提及（PRD：「`@` 紧跟非空白字符」）；
 * - 终止符 = 不在字符集内的一切（空白、中英文标点）与下一个 `@`。
 */
function scanMentions(text: string): RawMention[] {
  const raw: RawMention[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '@') {
      index += 1;
      continue;
    }
    // `@@` 转义：字面 `@`，不成提及。
    if (text[index + 1] === '@') {
      index += 2;
      continue;
    }
    const start = index + 1;
    if (start >= text.length || !TOKEN_CHAR_PATTERN.test(text[start])) {
      index += 1;
      continue;
    }
    let end = start;
    while (end < text.length && TOKEN_CHAR_PATTERN.test(text[end])) {
      end += 1;
    }
    raw.push({ token: text.slice(start, end), at: index, noteStart: end });
    index = end;
  }
  return raw;
}

/** 解析文本里的 `@+图片名` 提及。**纯函数**：同样的 (text, assets) → 同样的三态结果。 */
export function parseImageMentions(
  text: string,
  assets: readonly MentionableAsset[],
): ParsedImageMentions {
  const source = text ?? '';
  const pool = assets ?? [];
  const raw = scanMentions(source);

  const mentions: ImageMention[] = raw.map((entry, position) => {
    // 说明文本 = 本提及之后到下一个提及之前（没有下一个就到串尾）。
    const next = raw[position + 1];
    const sliceEnd = next ? next.at : source.length;
    const note = source.slice(entry.noteStart, sliceEnd).replace(/@@/g, '@').trim();
    const assetIds = matchAssets(entry.token, pool);
    const state: MentionState =
      assetIds.length === 0 ? 'unresolved' : assetIds.length === 1 ? 'matched' : 'ambiguous';
    return { token: entry.token, state, assetIds, hitCount: assetIds.length, note };
  });

  const counts: Record<MentionState, number> = { matched: 0, ambiguous: 0, unresolved: 0 };
  for (const mention of mentions) counts[mention.state] += 1;

  const matchedAssetIds: string[] = [];
  for (const mention of mentions) {
    for (const id of mention.assetIds) {
      if (!matchedAssetIds.includes(id)) matchedAssetIds.push(id);
    }
  }

  return {
    mentions,
    counts,
    ambiguousTokens: [...new Set(mentions.filter((m) => m.state === 'ambiguous').map((m) => m.token))],
    unresolvedTokens: [
      ...new Set(mentions.filter((m) => m.state === 'unresolved').map((m) => m.token)),
    ],
    empty: mentions.length === 0,
    matchedAssetIds,
  };
}

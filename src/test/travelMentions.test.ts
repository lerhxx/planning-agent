/**
 * `providers/mentions.ts` 单测 —— `@+图片名` 三态解析（PRD §3.4 / 设计 §9 T03）。
 *
 * 必覆盖：同名 2 张 / `@` 不存在 / 标点截断 / `@@` 转义。
 *
 * ★ 每条断言都锁**语义**（state / assetIds / hitCount / counts / token），
 * **不锁任何文案字面量** —— M2 的教训是断言绑死文案会在改文案时假红。
 */
import { describe, expect, it } from 'vitest';
import {
  parseImageMentions,
  type MentionableAsset,
  type ParsedImageMentions,
} from '@/src/domains/travel/providers/mentions';

const ASSETS: readonly MentionableAsset[] = [
  { id: 'asset-1', name: '外滩.jpg' },
  { id: 'asset-2', name: '豫园.jpg' },
  { id: 'asset-3', name: 'IMG_001.jpg' },
  { id: 'asset-4', name: 'IMG_001.jpg' }, // ★ 与 asset-3 同名：重名共存，系统不替用户改名
];

function stateOf(parsed: ParsedImageMentions, token: string): string | undefined {
  return parsed.mentions.find((m) => m.token === token)?.state;
}

describe('parseImageMentions · 三态', () => {
  it('matched：唯一命中 → 关联到该 assetId，说明文本被切出来', () => {
    const parsed = parseImageMentions('帮我规划三日游 @外滩.jpg 想拍夜景，@豫园.jpg 想拍园林', ASSETS);

    expect(parsed.mentions.map((m) => m.token)).toEqual(['外滩.jpg', '豫园.jpg']);
    expect(stateOf(parsed, '外滩.jpg')).toBe('matched');
    expect(parsed.mentions[0].assetIds).toEqual(['asset-1']);
    expect(parsed.mentions[0].hitCount).toBe(1);
    // ★ 说明文本归属于它**前面**那个提及，且不越到下一个提及。
    expect(parsed.mentions[0].note).toBe('想拍夜景，');
    expect(parsed.mentions[1].note).toBe('想拍园林');
    expect(parsed.counts).toEqual({ matched: 2, ambiguous: 0, unresolved: 0 });
    expect(parsed.empty).toBe(false);
  });

  it('★ 同名 2 张 → ambiguous：全部关联，绝不静默挑第一个', () => {
    const parsed = parseImageMentions('@IMG_001.jpg 这张在哪', ASSETS);

    expect(stateOf(parsed, 'IMG_001.jpg')).toBe('ambiguous');
    // ★ 全关联：两张都挂上，而不是挑第一个（挑第一个 = 把用户说明挂到错图 = 事实伪造）。
    expect(parsed.mentions[0].assetIds).toEqual(['asset-3', 'asset-4']);
    expect(parsed.mentions[0].hitCount).toBe(2);
    expect(parsed.ambiguousTokens).toEqual(['IMG_001.jpg']);
    expect(parsed.counts).toEqual({ matched: 0, ambiguous: 1, unresolved: 0 });
    expect(parsed.empty).toBe(false);
  });

  it('★ `@` 不存在（0 命中）→ unresolved：不关联任何图，也不阻断整轮', () => {
    const parsed = parseImageMentions('@不存在的图.jpg 这是什么', ASSETS);

    expect(stateOf(parsed, '不存在的图.jpg')).toBe('unresolved');
    expect(parsed.mentions[0].assetIds).toEqual([]);
    expect(parsed.mentions[0].hitCount).toBe(0);
    expect(parsed.unresolvedTokens).toEqual(['不存在的图.jpg']);
    expect(parsed.counts).toEqual({ matched: 0, ambiguous: 0, unresolved: 1 });
    // ★ 三态里 unresolved 不是"解析失败"：文本本身照样被解析出来，交给调用方走澄清。
    expect(parsed.mentions[0].note).toBe('这是什么');
  });

  it('去扩展名匹配：@外滩 命中 外滩.jpg（PRD「未命中再按去掉扩展名匹配」）', () => {
    const parsed = parseImageMentions('@外滩 想拍夜景', ASSETS);
    expect(stateOf(parsed, '外滩')).toBe('matched');
    expect(parsed.mentions[0].assetIds).toEqual(['asset-1']);
  });
});

describe('parseImageMentions · 边界', () => {
  it('★ 标点截断：中文标点 / 英文标点都能终止 token', () => {
    const cn = parseImageMentions('@外滩.jpg，想拍夜景', ASSETS);
    expect(cn.mentions.map((m) => m.token)).toEqual(['外滩.jpg']);
    expect(cn.mentions[0].assetIds).toEqual(['asset-1']);

    const en = parseImageMentions('@豫园.jpg, morning', ASSETS);
    expect(en.mentions[0].token).toBe('豫园.jpg');
    expect(en.mentions[0].assetIds).toEqual(['asset-2']);

    const stop = parseImageMentions('@外滩.jpg。晚上去', ASSETS);
    expect(stop.mentions[0].token).toBe('外滩.jpg');
  });

  it('★ `@@` 转义 → 不成提及，且说明文本里反转义为单个 @', () => {
    const parsed = parseImageMentions('邮箱是 @@someone 请联系', ASSETS);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.empty).toBe(true);
    expect(parsed.counts).toEqual({ matched: 0, ambiguous: 0, unresolved: 0 });

    // 转义之后紧跟一个真提及：note 里的 @@ 只还原成 @，不影响提及本身。
    const mixed = parseImageMentions('@外滩.jpg 联系 @@admin 安排', ASSETS);
    expect(mixed.mentions.map((m) => m.token)).toEqual(['外滩.jpg']);
    expect(mixed.mentions[0].note).toBe('联系 @admin 安排');
  });

  it('`@` 后紧跟空白 / 到串尾 → 不成提及（起始要求紧跟非空白字符）', () => {
    expect(parseImageMentions('@ 外滩', ASSETS).empty).toBe(true);
    expect(parseImageMentions('收尾 @', ASSETS).empty).toBe(true);
    expect(parseImageMentions('完全没有提及', ASSETS).empty).toBe(true);
  });

  it('一次解析出三种状态：计数与去重列表都对得上', () => {
    const parsed = parseImageMentions(
      '@外滩.jpg 夜景 @IMG_001.jpg 重名 @没这张.jpg 待确认',
      ASSETS,
    );
    expect(parsed.counts).toEqual({ matched: 1, ambiguous: 1, unresolved: 1 });
    expect(parsed.ambiguousTokens).toEqual(['IMG_001.jpg']);
    expect(parsed.unresolvedTokens).toEqual(['没这张.jpg']);
    expect(parsed.matchedAssetIds).toEqual(['asset-1', 'asset-3', 'asset-4']);
    expect(parsed.empty).toBe(false);
  });

  it('附件列表为空 → 全部 unresolved（不静默丢弃，也不崩）', () => {
    const parsed = parseImageMentions('@外滩.jpg 想拍夜景', []);
    expect(parsed.counts).toEqual({ matched: 0, ambiguous: 0, unresolved: 1 });
    expect(parsed.mentions[0].assetIds).toEqual([]);
    expect(parsed.matchedAssetIds).toEqual([]);
  });

  it('纯函数：同样的入参两次解析结果一致', () => {
    const text = '@外滩.jpg 夜景 @IMG_001.jpg 重名';
    expect(parseImageMentions(text, ASSETS)).toEqual(parseImageMentions(text, ASSETS));
  });
});

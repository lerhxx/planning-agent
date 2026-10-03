/**
 * `markdown.ts` 单测 —— md → blocks 纯函数（设计 §6.2，零新增依赖）。
 *
 * ★ 断言只锁**语义**（块类型 / 层级 / 是否有序 / span 文本内容 / 链接是否被降级），
 * 不锁任何文案字面量（M2 教训：断言绑死文案，改文案时会出现假红）。
 */
import { describe, expect, it } from 'vitest';
import { markdownToBlocks, markdownToSpans, type MdBlock, type MdSpan } from '@/src/domains/travel/markdown';

function textOf(spans: readonly MdSpan[]): string {
  return spans.map((span) => span.text).join('');
}

function kinds(blocks: readonly MdBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

describe('markdown · 块级', () => {
  it('空输入与非 markdown 文本 → 空 / 单段落', () => {
    expect(markdownToBlocks('')).toEqual([]);
    expect(markdownToBlocks('   \n  \n')).toEqual([]);

    const blocks = markdownToBlocks('这是一句普通的话');
    expect(kinds(blocks)).toEqual(['paragraph']);
    expect(textOf(blocks[0].kind === 'paragraph' ? blocks[0].spans : [])).toBe('这是一句普通的话');
  });

  it('一/二/三级标题 → heading，层级正确（4 级及以上降级为段落，不丢内容）', () => {
    const blocks = markdownToBlocks('# 总述\n## 第 1 天\n### 贴士\n#### 四级标题');
    expect(kinds(blocks)).toEqual(['heading', 'heading', 'heading', 'paragraph']);
    expect(blocks.map((b) => (b.kind === 'heading' ? b.level : null))).toEqual([1, 2, 3, null]);
    expect(textOf(blocks[3].kind === 'paragraph' ? blocks[3].spans : [])).toContain('四级标题');
  });

  it('无序列表 / 有序列表 → list，ordered 语义正确', () => {
    const ul = markdownToBlocks('- 外滩\n- 豫园');
    expect(kinds(ul)).toEqual(['list']);
    expect(ul[0].kind === 'list' && ul[0].ordered).toBe(false);
    expect(ul[0].kind === 'list' && ul[0].items.map((item) => textOf(item))).toEqual(['外滩', '豫园']);

    const ol = markdownToBlocks('1. 上午出发\n2. 下午返程');
    expect(ol[0].kind === 'list' && ol[0].ordered).toBe(true);
    expect(ol[0].kind === 'list' && ol[0].items.map((item) => textOf(item))).toEqual([
      '上午出发',
      '下午返程',
    ]);
  });

  it('有序与无序相邻 → 拆成两个 list（不混成一份）', () => {
    const blocks = markdownToBlocks('- 备选\n1. 首选');
    expect(kinds(blocks)).toEqual(['list', 'list']);
    expect(blocks[0].kind === 'list' && blocks[0].ordered).toBe(false);
    expect(blocks[1].kind === 'list' && blocks[1].ordered).toBe(true);
  });

  it('引用 → quote；连续引用行合并为一段', () => {
    const blocks = markdownToBlocks('> 出行前复核价格\n> 以现场为准');
    expect(kinds(blocks)).toEqual(['quote']);
    expect(textOf(blocks[0].kind === 'quote' ? blocks[0].spans : [])).toBe('出行前复核价格 以现场为准');
  });

  it('空行分隔出多个段落；软换行按空格合并', () => {
    const blocks = markdownToBlocks('第一段第一行\n第一段第二行\n\n第二段');
    expect(kinds(blocks)).toEqual(['paragraph', 'paragraph']);
    expect(textOf(blocks[0].kind === 'paragraph' ? blocks[0].spans : [])).toBe(
      '第一段第一行 第一段第二行',
    );
  });

  it('纯函数：同样的输入两次解析结果一致', () => {
    const md = '## 贴士\n- **早场**人少\n> 记得预约';
    expect(markdownToBlocks(md)).toEqual(markdownToBlocks(md));
  });
});

describe('markdown · 行内', () => {
  it('**bold** / `code` / [text](url) → 三类 span', () => {
    const spans = markdownToSpans('请提前**预约**并带好`身份证`，见[官网](https://example.com)');
    expect(spans.filter((s) => s.bold === true).map((s) => s.text)).toEqual(['预约']);
    expect(spans.filter((s) => s.code === true).map((s) => s.text)).toEqual(['身份证']);
    expect(spans.filter((s) => typeof s.href === 'string').map((s) => s.text)).toEqual(['官网']);
    expect(textOf(spans)).toBe('请提前预约并带好身份证，见官网');
  });

  it('★ 协议白名单：javascript: 链接降级为纯文本（文字保留，链接丢弃）', () => {
    const spans = markdownToSpans('点[这里](javascript:alert(1))看看');
    expect(textOf(spans)).toBe('点这里看看');
    expect(spans.some((s) => typeof s.href === 'string')).toBe(false);
  });

  it('未闭合的标记当普通文本，不静默吞字', () => {
    const spans = markdownToSpans('价格 **未闭合 与 `未闭合');
    expect(textOf(spans)).toBe('价格 **未闭合 与 `未闭合');
    expect(spans.some((s) => s.bold === true || s.code === true)).toBe(false);
  });

  it('★ 不认识领域的数字：¥ 与评分都只是叙述文本，不会被解析成结构化事实', () => {
    const blocks = markdownToBlocks('人均 ¥220，评分 4.6 分');
    const spans = blocks[0].kind === 'paragraph' ? blocks[0].spans : [];
    expect(textOf(spans)).toBe('人均 ¥220，评分 4.6 分');
    // 全部 span 都是纯文本：没有任何结构化字段承载这些数值。
    expect(spans.every((s) => s.bold !== true && s.code !== true && s.href === undefined)).toBe(true);
  });
});

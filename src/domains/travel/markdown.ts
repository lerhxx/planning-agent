/**
 * `markdown.ts` —— markdown → blocks 的**纯函数**（零新增依赖，设计 §6.2）。
 *
 * ★ 分工原则（PRD §3.6，可被测试）：
 * **卡片 = 结构化数据，markdown = 叙述**。凡是要参与约束计算、成本重算或溯源的数据
 * （价格 / 评分 / 地址 / 时长 / `origin`）**必须**落在卡片的结构化字段里；
 * 本文件产出的 blocks 只承载叙述，**不得**被用来承载事实。
 *
 * 因此本文件刻意**不解析**任何领域的数字：它不认识 `¥`、`4.7 分`、`地址`，
 * 只把它们当普通文本 —— 那正是"markdown 不得承载事实"这条约束的实现方式。
 *
 * ★ 渲染侧纪律：**禁止原样注入 HTML**（`dangerouslySetInnerHTML` 一律不用）。
 * 本文件输出的 `href` 也做了协议白名单，挡掉 `javascript:` 之类的链接。
 */
/**
 * blocks 的**唯一真源是 zod schema**（红线 1：禁止手写第二份类型）。
 *
 * 之所以在这里定义而不是在组件 schema 里：md → blocks 的形状只有一个生产者（本文件），
 * `ItineraryCard` 的 props schema 必须 re-export 同一份，否则"传了但被 strip"会静默发生。
 */
import { z } from 'zod';

export const zMdSpan = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  code: z.boolean().optional(),
  href: z.string().optional(),
});
export type MdSpan = z.infer<typeof zMdSpan>;

export const zMdBlock = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    spans: z.array(zMdSpan),
  }),
  z.object({ kind: z.literal('paragraph'), spans: z.array(zMdSpan) }),
  z.object({ kind: z.literal('list'), ordered: z.boolean(), items: z.array(z.array(zMdSpan)) }),
  z.object({ kind: z.literal('quote'), spans: z.array(zMdSpan) }),
]);
export type MdBlock = z.infer<typeof zMdBlock>;

/**
 * 行内三件套：`**bold**` / `` `code` `` / `[text](url)`。
 *
 * 链接的 url 取「非空白的最长串，再以最后一个 `)` 收尾」——
 * 这样 `[a](javascript:alert(1))` 能被整体吃掉，不会把多余的 `)` 漏成正文。
 */
const INLINE_PATTERN = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^\s]+)\)/g;

/** 只允许这些链接协议；其余一律降级为"纯文本 + 无链接"（不丢字，但不可点）。 */
const SAFE_HREF_PATTERN = /^(?:https?:\/\/|mailto:|\/|#)/i;

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const UL_PATTERN = /^\s*[-*+]\s+(.*)$/;
const OL_PATTERN = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_PATTERN = /^\s*>\s?(.*)$/;

/** 解析一行内的行内标记。**纯函数**。 */
export function markdownToSpans(line: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(INLINE_PATTERN)) {
    const at = match.index ?? 0;
    if (at > lastIndex) {
      const plain = line.slice(lastIndex, at);
      if (plain.length > 0) spans.push({ text: plain });
    }
    const [full, bold, code, linkText, href] = match;
    if (bold !== undefined) {
      spans.push({ text: bold, bold: true });
    } else if (code !== undefined) {
      spans.push({ text: code, code: true });
    } else if (linkText !== undefined) {
      // 协议不在白名单里 → 保留文字、丢掉链接（绝不把 javascript: 传下去）。
      const safe = SAFE_HREF_PATTERN.test(href ?? '');
      spans.push(safe ? { text: linkText, href } : { text: linkText });
    }
    lastIndex = at + full.length;
  }

  if (lastIndex < line.length) {
    const tail = line.slice(lastIndex);
    if (tail.length > 0) spans.push({ text: tail });
  }
  return spans;
}

/** 一个 block 内的多行合并成一行（软换行按空格合并，与 markdown 语义一致）。**纯函数**。 */
function joinLines(lines: readonly string[]): string {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0).join(' ');
}

/**
 * markdown → blocks。**纯函数**：同样的输入 → 同样的 blocks，可单测。
 *
 * 支持：`# / ## / ###`（4 级及以上按段落处理）、`- * +` 与 `1. ` 列表、`> ` 引用、段落；
 * 行内 `**bold**` / `` `code` `` / `[text](url)`。**其余语法一律当普通文本**（不静默吞内容）。
 */
export function markdownToBlocks(md: string): MdBlock[] {
  const lines = (md ?? '').split(/\r?\n/);
  const blocks: MdBlock[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: MdSpan[][] } | null = null;
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const spans = markdownToSpans(joinLines(paragraph));
    if (spans.length > 0) blocks.push({ kind: 'paragraph', spans });
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    if (list.items.length > 0) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    }
    list = null;
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    const spans = markdownToSpans(joinLines(quote));
    if (spans.length > 0) blocks.push({ kind: 'quote', spans });
    quote = [];
  };
  /** 三者互斥：切到新的块类型前先把旧的收尾。 */
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushAll();
      continue;
    }

    const heading = HEADING_PATTERN.exec(trimmed);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const spans = markdownToSpans(heading[2].trim());
      if (level <= 3) {
        blocks.push({ kind: 'heading', level: level as 1 | 2 | 3, spans });
      } else {
        // 4 级及以上不在子集内：降级为段落，**不丢内容**（宁可降级也不静默丢弃）。
        if (spans.length > 0) blocks.push({ kind: 'paragraph', spans });
      }
      continue;
    }

    const quoteMatch = QUOTE_PATTERN.exec(line);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const ulMatch = UL_PATTERN.exec(line);
    const olMatch = ulMatch ? null : OL_PATTERN.exec(line);
    const itemMatch = ulMatch ?? olMatch;
    if (itemMatch) {
      flushParagraph();
      flushQuote();
      const ordered = olMatch !== null;
      // 有序 / 无序切换 → 视为两个列表（否则会混成一份，顺序语义就丢了）。
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(markdownToSpans(itemMatch[1].trim()));
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }

  flushAll();
  return blocks;
}

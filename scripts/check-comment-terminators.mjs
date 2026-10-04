#!/usr/bin/env node
/**
 * 守卫：块注释里不得出现「星号紧跟斜杠」这个 CSS / JS 注释终止序列。
 *
 * ★ 为什么必须存在这个脚本（本项目已踩三次，脚本自身第一版也踩了）
 *   - `app/theme.tokens.css` 注释里把通配符连写成 `--color-* → bg-*` 紧接 `/text-*`
 *     的形式，其中的「星号紧跟斜杠」把注释提前闭合 → CSS 解析失败 → 整个
 *     App Router 编译挂掉，`GET /` 与 `/api/*` 全部 500；
 *   - `app/providers.tsx` 注释里用通配符写了 `src/domains/` 下的 `meta.ts` 路径，
 *     同一个模子，全站 500。
 *   两个特征让它极难人工拦截，只能靠机器：
 *     1. 报错行号是 `@import` 展开后的行号（真实第 8 行，报的是 1217 行）；
 *     2. 表现形式是全站 500，看起来完全像"后端挂了"，没人会往注释里想。
 *
 * ★ 判定口径（宁可漏、不可误报 —— 有噪音的检查下次就会被跳过，等于没有）
 *   只命中「本该是注释内容、却被终止序列截断」的情况，**不是**文件里所有该序列：
 *     - `/*` 是**开**注释，不是终止序列 —— `next.config.ts` 的 `@mastra/*` 必须放过；
 *     - 字符串 / 模板字符串里的字面量必须放过；
 *     - 单行注释 `/* x *\/ code` 后面跟代码是合法写法，必须放过。
 *   三条命中信号（都是"注释被截断"的强特征）：
 *     S1 多行块注释的闭合点之后，同一行还有中文内容（说明注释被中途掐断，后面是散文）；
 *     S2 多行块注释闭合后，紧邻的下一行仍以 `*` 开头且含中文（注释续行掉到了代码里）；
 *     S3 在代码态直接遇到终止序列（必然是语法错误）。
 *   另有 S4：块注释到文件结束仍未闭合。
 *
 * 用法：node scripts/check-comment-terminators.mjs [路径...]（缺省扫整个仓库）
 * 退出码：0 = 干净；1 = 有命中。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
// 显式 import 而不是依赖全局：本仓库的 eslint 配置没给脚本文件开 node 全局（会报 no-undef）。
import process from 'node:process';
import console from 'node:console';

/** 参与扫描的扩展名（注释语法一致的那些）。 */
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.css',
]);

/** 永不进入的目录（第三方 / 构建产物）。 */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  '.git',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
]);

/** 终止序列：星号紧跟斜杠。写成拼接是为了让本脚本自己不触发自身检查。 */
const TERMINATOR = '*' + '/';

/**
 * 是否含中文（汉字 / 中文标点 / 全角字符）—— 注释散文的强特征。
 * 用码点判断而不是正则：正则字面量里写全角空格会被 eslint 的
 * no-irregular-whitespace 判为错误，写成转义又要叠多层转义，可读性差。
 *
 * @param {string} text 待判断文本
 * @returns {boolean} 含中文则为 true
 */
function containsCjk(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) return true; // 汉字
    if (code >= 0x3000 && code <= 0x303f) return true; // 中文标点（含全角空格）
    if (code >= 0xff00 && code <= 0xffef) return true; // 全角字符
  }
  return false;
}

const FIX_HINT = '注释内的该终止序列会提前闭合注释，请改写成不含它的写法（写通配符时星号后留空格）';

/**
 * 从 `from` 起取当前行的剩余内容（不含换行符）。
 * @param {string} source 文件全文
 * @param {number} from 起始下标
 * @returns {string} 行内剩余文本
 */
function restOfLine(source, from) {
  let end = from;
  while (end < source.length && source[end] !== '\n') {
    end += 1;
  }
  return source.slice(from, end);
}

/**
 * 从 `from` 起跳过当前行剩余内容与空行，取下一个非空行的原文。
 * @param {string} source 文件全文
 * @param {number} from 起始下标
 * @returns {string} 下一个非空行；没有则返回空串
 */
function nextNonEmptyLine(source, from) {
  let cursor = from;
  while (cursor < source.length && source[cursor] !== '\n') {
    cursor += 1;
  }
  cursor += 1;
  while (cursor < source.length) {
    let end = cursor;
    while (end < source.length && source[end] !== '\n') {
      end += 1;
    }
    const line = source.slice(cursor, end).trim();
    if (line.length > 0) {
      return line;
    }
    cursor = end + 1;
  }
  return '';
}

/**
 * 扫描单个文件。
 * @param {string} source 文件全文
 * @param {string} displayPath 用于输出的文件路径
 * @returns {Array<{line: number, col: number, text: string, signal: string}>} 命中列表
 */
function scanSource(source, displayPath) {
  const hits = [];
  const length = source.length;
  let index = 0;
  let line = 1;
  let col = 1;

  /** 前进一个字符并维护行列号。 */
  const bump = () => {
    if (source[index] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    index += 1;
  };

  // 状态：code / line / block / string / template
  let state = 'code';
  /** 字符串引号（' " `），模板字符串里的 ${} 用栈回到 code。 */
  let quote = '';
  const templateStack = [];
  /** 当前块注释的起始位置。 */
  let blockStart = null;

  const report = (atLine, atCol, text, signal) => {
    hits.push({ line: atLine, col: atCol, text, signal });
  };

  while (index < length) {
    const ch = source[index];
    const next = source[index + 1] ?? '';

    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
      }
      bump();
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        const closeLine = line;
        const closeCol = col;
        index += 2;
        col += 2;
        const rest = restOfLine(source, index);
        const trimmed = rest.trim();
        const isMultiLine = blockStart !== null && blockStart.line !== closeLine;

        if (isMultiLine && trimmed.length > 0 && containsCjk(trimmed)) {
          // S1：闭合点后面还跟着中文散文 → 注释是被中途掐断的。
          report(
            closeLine,
            closeCol,
            `注释在第 ${blockStart.line} 行开启，却在第 ${closeLine} 行被提前闭合，其后仍有中文内容：${trimmed.slice(0, 60)}`,
            'S1',
          );
        } else {
          const following = nextNonEmptyLine(source, index);
          if (
            isMultiLine &&
            following.startsWith('*') &&
            !following.startsWith('*/') &&
            containsCjk(following)
          ) {
            // S2：闭合后紧邻行仍是注释续行 → 真正的结尾还在后面。
            report(
              closeLine,
              closeCol,
              `注释在第 ${blockStart.line} 行开启，第 ${closeLine} 行闭合后紧邻行仍是注释续行：${following.slice(0, 60)}`,
              'S2',
            );
          }
        }
        state = 'code';
        blockStart = null;
        continue;
      }
      bump();
      continue;
    }

    if (state === 'string' || state === 'template') {
      if (ch === '\\') {
        index += 2;
        col += 2;
        continue;
      }
      if (state === 'template' && ch === '$' && next === '{') {
        templateStack.push('template');
        state = 'code';
        index += 2;
        col += 2;
        continue;
      }
      if (ch === quote) {
        // 字符串结束一律回到代码态：若处在 `${}` 内，右花括号会切回 template。
        state = 'code';
        quote = '';
        bump();
        continue;
      }
      bump();
      continue;
    }

    // ---- 代码态 ----
    if (ch === '/' && next === '/') {
      state = 'line';
      index += 2;
      col += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block';
      blockStart = { line, col };
      index += 2;
      col += 2;
      continue;
    }
    if (ch === '*' && next === '/') {
      // S3：代码态直接出现终止序列，必然是语法错误（多半是注释被提前闭合后的残留）。
      report(line, col, `代码里出现游离的注释终止序列 ${TERMINATOR}（多半是上一个注释被提前闭合的残留）`, 'S3');
      index += 2;
      col += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      state = ch === '`' ? 'template' : 'string';
      bump();
      continue;
    }
    if (ch === '}' && templateStack.length > 0) {
      templateStack.pop();
      state = 'template';
      quote = '`';
      bump();
      continue;
    }
    bump();
  }

  if (state === 'block') {
    // S4：块注释到文件结束仍未闭合。
    report(blockStart ? blockStart.line : line, blockStart ? blockStart.col : 1, '块注释到文件结束仍未闭合', 'S4');
  }

  return hits.map((hit) => ({ ...hit, displayPath }));
}

/**
 * 递归收集待扫描文件。
 * @param {string} root 根目录
 * @param {string[]} collected 累积结果
 * @returns {string[]} 文件绝对路径列表
 */
function collectFiles(root, collected) {
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry);
    let info;
    try {
      info = statSync(absolute);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry)) {
        collectFiles(absolute, collected);
      }
      continue;
    }
    if (SCANNED_EXTENSIONS.has(extname(entry))) {
      collected.push(absolute);
    }
  }
  return collected;
}

const targets = process.argv.slice(2);
/**
 * 显式传入的目标可能是文件也可能是目录，**必须分别处理**。
 * 早期版本把参数一律当文件：传目录时 readFileSync 抛错被 catch 吞掉，最终
 * 「扫描 0 个文件却 EXIT=0」—— 门禁永远绿，看输出还以为扫过了。
 * 一个假绿的门禁比没有门禁更危险，因为它会让人从此停止手动检查。
 */
const files =
  targets.length > 0
    ? targets.flatMap((target) => {
        const absolute = resolve(process.cwd(), target);
        try {
          return statSync(absolute).isDirectory() ? collectFiles(absolute, []) : [absolute];
        } catch {
          // 目标不存在或不可读：保留进列表，由下面的「读取失败」分支统一报出来，
          // 不在这里静默丢弃。
          return [absolute];
        }
      })
    : collectFiles(process.cwd(), []);

let scanned = 0;
const readFailures = [];
const allHits = [];
for (const file of files) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    readFailures.push(file);
    continue;
  }
  scanned += 1;
  const displayPath = relative(process.cwd(), file).split(sep).join('/');
  allHits.push(...scanSource(source, displayPath));
}

// 读不了就是守卫失效，必须吵出来 —— 静默跳过等于这一批文件从未被检查。
if (readFailures.length > 0) {
  console.error('✗ 以下目标读取失败，守卫未覆盖（按失败处理）：');
  for (const file of readFailures) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

// 扫到 0 个文件同样判失败：正常用法不可能扫到 0，0 只可能是用法错了、
// 路径错了或扩展名不匹配。若在此放行，门禁会永远绿。
if (scanned === 0) {
  console.error(
    `✗ 守卫未扫描到任何文件（目标：${targets.length > 0 ? targets.join(' ') : '(默认全仓)'}）`,
  );
  process.exit(1);
}

if (allHits.length === 0) {
  console.log(`✓ 未发现「注释被提前闭合」的问题（扫描 ${scanned} 个文件）`);
  process.exit(0);
}

console.error(`✗ 发现 ${allHits.length} 处注释终止序列问题（扫描 ${scanned} 个文件）：`);
for (const hit of allHits) {
  console.error(`  ${hit.displayPath}:${hit.line}:${hit.col}  [${hit.signal}] ${hit.text}`);
}
console.error(`—— ${FIX_HINT} ——`);
process.exit(1);

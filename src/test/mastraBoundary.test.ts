/**
 * ★ 架构边界守卫（红线 5 / 6 / 8 / 13 的自动化落点）。
 *
 * ★★ 为什么本文件住在 `src/test/` 而不是 `src/core/runtime/mastra/` 旁边：
 *   `src/test/v2IndependentVerify.test.ts` 里有一条**既有**的领域词守卫，
 *   它扫描 `src/core/**` 下**所有** `.ts`（**含测试文件**、**不剥注释**），
 *   词表是 `['travel','旅游','行程','航班','酒店','景点']`。
 *   守卫文件本身必须含有这个词表才能工作，所以**放在被扫描目录里必然把那条守卫打红**
 *   —— 这是实测踩到的真实回归，不是假设。
 *   把本文件放到扫描范围外（`src/test/`）之后：
 *   ① 既有守卫恢复绿色；
 *   ② 本守卫**仍然完整地守着 `src/core/**`**，因为它是用 `node:fs` 从磁盘按路径扫的，
 *      **测试文件放哪不影响它扫什么**。
 *   这与既有守卫自己的位置选择是同一套理由。
 *
 * ★★ 为什么必须用 `node:fs` 自己遍历、而**不能**用 bash `grep`：
 *   `CLAUDE.md:73-81` 记录了一个已经坑过多次的事实 ——
 *   bash `grep` 在本环境会**静默返回 0 条**，而 0 恰好就是这些守卫的**通过值**。
 *   用 bash grep 写的守卫会**假通过**，而且看不出来
 *   （你只会看到一行 `0`，和真的干净一模一样）。
 *   主理人已在本次任务中现场踩过一次：`grep -rhoE "^\s*(it|test)\(" …` 返回 0。
 *
 * ★★ 扫描只做一次（`beforeAll`），三条断言共用。
 *   这不是性能优化，是**正确性要求**：全仓递归读盘在满载并行下会超过默认 5s
 *   （`v2IndependentVerify.test.ts:118` 已经踩过并留下同一结论），
 *   首版把扫描放在每个 `it` 里，结果全量跑时 5 条用例全部 `Test timed out in 5000ms`。
 *
 * ★★ 三个必须做对的设计点（每一个都是第一版真实踩出来的）：
 *
 *   1. **只扫代码，不扫注释。** 注释里写"不要写死 `qwen-max`"是在**帮助**后人，
 *      却会让裸 substring 扫描报错。守卫一旦误报，人就会开始忽略它 ——
 *      那比没有守卫更危险。
 *   2. **拉丁词不能用裸 substring。** 首版把 `"poi"` 当子串匹配，
 *      结果 `executor.ts` 里的 **"JSON Pointer"**（RFC 6901 的标准术语）被判违规。
 *      改成"后面不能跟小写字母"后，`POI_CARD` / `zPoiSearch` 仍能命中，`Pointer` 不再误报。
 *   3. **守卫文件要排除自己。** 词表和正则就写在本文档里，不排除就是自证失败。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const SHARED = join(ROOT, 'shared');
const MASTRA_DIR = join(SRC, 'core', 'runtime', 'mastra');
/** 本文件自身：包含全部词表与正则，扫描时必须排除。 */
const SELF = 'src/test/mastraBoundary.test.ts';

/** 领域词表：内核与 shared 里出现任何一个都算破红线 8。 */
const DOMAIN_WORDS = ['travel', 'poi', '景点', '餐厅', '酒店', '行程'];

/** 常见国产模型名：除 models.ts 外出现即说明有人硬编码（红线 6）。 */
const MODEL_WORDS = ['qwen', 'doubao', 'deepseek', 'glm', 'moonshot', 'ernie'];

/** 递归收集目录下的 .ts / .tsx 文件。 */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** 归一化成 posix 风格，便于跨平台比较。 */
function posix(path: string): string {
  return relative(ROOT, path).split(sep).join('/');
}

/**
 * 剥掉注释，只留代码。
 *
 * 行注释的 `//` 前面要求不是 `:`，是为了不误伤 `https://…` 里的双斜杠。
 * ★ 已知局限：字符串字面量里若出现双斜杠，该行后半段会被误当作注释剥掉。
 *   对本守卫而言可以接受 —— 本仓的模型名都是裸标识符，不受影响。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 扫出来的一条记录：相对路径 + 剥完注释的代码。 */
interface Scanned {
  rel: string;
  code: string;
}

function scanDir(dir: string): Scanned[] {
  return walk(dir)
    .map((file) => ({ rel: posix(file), code: stripComments(readFileSync(file, 'utf8')) }))
    .filter((item) => item.rel !== SELF);
}

/** 拉丁词匹配：后面不能跟小写字母（见文件头设计点 2）。 */
function hitsLatinWord(text: string, word: string): boolean {
  return new RegExp(`${word}(?![a-z])`, 'i').test(text);
}

/** 中文没有词边界，直接子串匹配。 */
function hitsCJKWord(text: string, word: string): boolean {
  return text.includes(word);
}

// ★ 扫一次，全部断言共用。60s 是实测满载并行下的余量，不是随口写的数字。
let SRC_SCAN: Scanned[] = [];
let KERNEL_SCAN: Scanned[] = [];

beforeAll(() => {
  SRC_SCAN = scanDir(SRC);
  KERNEL_SCAN = [
    ...SRC_SCAN.filter((item) => item.rel.startsWith('src/core/')),
    ...scanDir(SHARED),
  ];
}, 60_000);

describe('架构边界守卫（内核不认识领域、也不认识框架）', () => {
  it('扫描器本身是有效的：真的找到了源文件（否则"0 命中"是假通过）', () => {
    expect(SRC_SCAN.length).toBeGreaterThan(20);
    expect(KERNEL_SCAN.length).toBeGreaterThan(10);
    expect(SRC_SCAN.some((item) => item.rel.startsWith('src/core/'))).toBe(true);
  });

  it('剥注释不会把整个文件剥空（否则守卫会假通过）', () => {
    const sample = stripComments(readFileSync(join(MASTRA_DIR, 'models.ts'), 'utf8'));
    // 代码部分必须还在
    expect(sample.length).toBeGreaterThan(200);
    expect(sample).toContain('MissingModelConfigError');
    expect(sample).toContain('MASTRA_TEXT');
    // 注释里的中文说明应当被剥掉
    expect(sample).not.toContain('唯一声明处');
  });

  it('红线 5：@mastra/* 只允许出现在 src/core/runtime/mastra/ 内', () => {
    const offenders = SRC_SCAN.filter(
      (item) => !item.rel.startsWith('src/core/runtime/mastra/') && item.code.includes('@mastra/'),
    ).map((item) => item.rel);
    expect(offenders).toEqual([]);
  });

  it('红线 13：内核编排层不得 import 具体 runtime 实现', () => {
    const kernelDirs = [
      'src/core/run/',
      'src/core/execution/',
      'src/core/compiler/',
      'src/core/replan/',
      'src/core/planning/',
      'src/core/goal/',
      'src/core/degrade/',
    ];
    const offenders = SRC_SCAN.filter(
      (item) =>
        kernelDirs.some((dir) => item.rel.startsWith(dir)) &&
        (item.code.includes('runtime/mastra') || item.code.includes('runtime/factory')),
    ).map((item) => item.rel);
    expect(offenders).toEqual([]);
  });

  it('红线 8：src/core 与 shared 的代码里不出现任何领域词', () => {
    const offenders: string[] = [];
    for (const item of KERNEL_SCAN) {
      for (const word of DOMAIN_WORDS) {
        const hit = /[a-z]/.test(word)
          ? hitsLatinWord(item.code, word)
          : hitsCJKWord(item.code, word);
        if (hit) offenders.push(`${item.rel} 命中领域词 "${word}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('红线 6：除 models.ts 外，src 的代码里不出现任何模型名字面量', () => {
    const allowed = 'src/core/runtime/mastra/models.ts';
    const offenders: string[] = [];
    for (const item of SRC_SCAN) {
      if (item.rel === allowed) continue;
      for (const word of MODEL_WORDS) {
        if (hitsLatinWord(item.code, word)) {
          offenders.push(`${item.rel} 命中模型名 "${word}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('models.ts 自身也不写死模型名（全部来自环境变量）', () => {
    const code = stripComments(readFileSync(join(MASTRA_DIR, 'models.ts'), 'utf8'));
    for (const word of MODEL_WORDS) {
      expect(code, `models.ts 不应出现模型名 "${word}"`).not.toMatch(
        new RegExp(`${word}(?![a-z])`, 'i'),
      );
    }
  });

  it('密钥只用服务端环境变量，不得带 NEXT_PUBLIC_ 前缀', () => {
    const offenders: string[] = [];
    for (const item of [...SRC_SCAN, ...scanDir(SHARED)]) {
      /*
       * ★ 用 `+` 而不是 `*`：字符类后面紧跟星号再跟斜杠，会拼出本仓
       *   注释守卫（`scripts/check-comment-terminators.mjs`）专门拦的那串序列。
       *   语义上无损 —— 裸 `NEXT_PUBLIC_` 后面什么都不跟不是真实用法。
       */
      if (/NEXT_PUBLIC_[A-Z0-9_]+/.test(item.code)) offenders.push(item.rel);
    }
    expect(offenders).toEqual([]);
  });
});

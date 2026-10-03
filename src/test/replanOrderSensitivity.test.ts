/**
 * ★ 刻画测试（characterization test）—— 钉住 `subtreeDelta` 对**步骤顺序**的敏感度现状。
 *
 * ## 为什么单独放一个文件
 *
 * M2 的硬指标是 `git diff --numstat m1-core-only -- src/core shared | wc -l` = 0。
 * `src/core/replan/gates.test.ts` 位于 `src/core/**`，往那里**加任何一行（包括测试）都会让这条非零**，
 * M2 的证据当场作废。因此本文件放在 `src/test/`：只 `import` 内核的纯函数来读，不改动内核，diff 仍是 0。
 *
 * ## 为什么叫"刻画"而不是"期望"
 *
 * 这里断言的是**当前实际值**，不是"我们期望它怎样"。
 *
 * 架构上的已知风险（见 `techDocs/v2/03-架构设计-v2.md` §6.1）：
 * `stepSignature` 只由 `type + title` 组成，**不含顺序、不含 `id`**。
 * 那么在"时序型领域"（工序链：拆改 → 水电 → 防水 → 泥木 → 油漆）里，
 * **交换两步的顺序是实质变更**，但签名集合不变 → `subtreeDelta` 得 0 →
 * `isStagnant(0)` 为真 → 被判 `NO_CONVERGENCE` 强制转人工。
 *
 * 若风险为真，本文件现在记录的就是"度量对顺序不敏感"这一事实；
 * 若哪天有人改了 `stepSignature` 口径（例如把顺序或 `dependsOn` 计入签名），
 * **本文件会红** —— 那是**提醒信号**：请同步评估 M3 时序领域（装修）的收敛判定，并回到 §6.1 更新结论。
 *
 * 三个用例：① 交换顺序（本风险）②③ 改标题 / 增删一步（基线对照，证明度量本身是活的、不是恒 0）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GATE_CONFIG, isStagnant, subtreeDelta } from '@/src/core/replan/gates';

/** `subtreeDelta` 只吃 `Pick<Step, 'type' | 'title'>`，这里刻意用最小形状，不依赖 fixtures。 */
type Sig = { type: string; title: string };

describe('subtreeDelta · 顺序敏感度（刻画测试，钉现状）', () => {
  it('① 交换两步顺序 → 当前实际 delta = 0（★ 时序领域的已知风险）', () => {
    // replaced：先做 A 再做 B；generated：先做 B 再做 A。type 与 title 完全相同，只有顺序变了。
    const replaced: Sig[] = [
      { type: 'task', title: '水电改造' },
      { type: 'task', title: '防水施工' },
    ];
    const generated: Sig[] = [
      { type: 'task', title: '防水施工' },
      { type: 'task', title: '水电改造' },
    ];

    // 实际值：签名集合相同 → 交集 2 / 并集 2 → 1 - 2/2 = 0。
    expect(subtreeDelta(replaced, generated)).toBe(0);

    // 后果（同样是刻画，不是期望）：delta = 0 < minDelta(0.15) → 判定为原地打转，强制转人工。
    expect(DEFAULT_GATE_CONFIG.minDelta).toBe(0.15);
    expect(isStagnant(0)).toBe(true);
  });

  it('② 基线对照：改标题 → delta = 1（度量本身是活的，不是恒 0）', () => {
    const replaced: Sig[] = [{ type: 'task', title: '水电改造' }];
    const generated: Sig[] = [{ type: 'task', title: '水电改造 · 重排 2' }];

    // 交集 0 / 并集 2 → 1 - 0/2 = 1。
    expect(subtreeDelta(replaced, generated)).toBe(1);
    expect(isStagnant(1)).toBe(false);
  });

  it('③ 基线对照：增删一步 → delta = 0.5（证明它对数量变化敏感）', () => {
    const replaced: Sig[] = [{ type: 'task', title: '水电改造' }];
    const generated: Sig[] = [
      { type: 'task', title: '水电改造' },
      { type: 'task', title: '防水施工' },
    ];

    // 交集 1 / 并集 2 → 1 - 1/2 = 0.5。
    expect(subtreeDelta(replaced, generated)).toBe(0.5);
    expect(isStagnant(0.5)).toBe(false);
  });
});

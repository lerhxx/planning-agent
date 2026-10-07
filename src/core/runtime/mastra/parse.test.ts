/**
 * ★ `parse.ts` 的**窄归一化**回归：`intent.producesFacts` 的数组写法。
 *
 * ★★ 真实故障（浏览器控制台原文）：
 *   `steps.0.intent.producesFacts: Invalid input: expected boolean, received array`
 *   模型把这个字段读成了"这一步会产出这些"，回了一个**数组**；
 *   而 `zStepIntent.producesFacts` 是 `z.boolean().default(false)`（`shared/plan/types.ts`），
 *   于是 `parsePlanDraft` 抛 `PROVIDER_VALIDATION_FAILED`，
 *   整轮计划**直接作废**（用户侧表现为 `MastraOutputError('PLAN_GENERATION_FAILED')`）。
 *
 * ★★ 本文件要锁住的**不是**"数组能过"，而是归一化的**边界**：
 *   - 只接数组（映射唯一），其它类型一律放行给 schema 报错；
 *   - 每次归一化都 `console.warn` 出声（本仓主张"不可静默"）；
 *   - **不修改入参**（模型返回值可能还被别处持有）；
 *   - `intent: null` 的纯推理步骤完全不受影响。
 *   一旦哪天有人"顺手多兼容一点"（比如把 `'true'` 也猜成布尔），
 *   第 4 组用例会立刻红。
 *
 * ★ 本文件位于 `src/core/**`：禁止出现任何领域词（红线 8，扫描器**不剥注释**）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zRunContext, type RunContext } from '@/shared/run/types';
import { normalizeProducesFacts, parsePlanDraft } from '@/src/core/runtime/mastra/parse';

/** 造一个最小可用的 RunContext。 */
const CTX: RunContext = zRunContext.parse({
  runId: 'run-parse-test',
  traceId: 'trace-parse-test',
  goalId: 'goal-parse-test',
  domainId: 'generic',
  revision: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  deadlineAt: '2026-01-01T00:01:00.000Z',
  budgetRemainingCNY: 2,
  signals: [],
  attachments: [],
  meta: {},
});

/** 一个合法的计划草稿；`intentFlag` 用来替换 `producesFacts` 的值。 */
function makeDraft(intentFlag: unknown): unknown {
  return {
    summary: '两步计划',
    steps: [
      {
        id: 's-1',
        type: 'retrieve',
        title: '取回素材',
        dependsOn: [],
        intent: { toolName: 'fetch-materials', input: {}, producesFacts: intentFlag },
      },
      {
        id: 's-2',
        type: 'compose',
        title: '汇总产出',
        dependsOn: ['s-1'],
        intent: null,
      },
    ],
  };
}

/** 只取归一化结果里第一个步骤的 `producesFacts`（类型断言集中在这一处）。 */
function firstFlag(normalized: unknown): unknown {
  return (normalized as { steps: Array<{ intent: { producesFacts: unknown } | null }> }).steps[0]
    .intent?.producesFacts;
}

describe('normalizeProducesFacts：只接数组，且必须出声', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('① 非空数组 → true，并 warn（步骤下标 + 原值类型 + 结果）', () => {
    const raw = makeDraft(['a', 'b']);
    const out = normalizeProducesFacts(raw);

    expect(firstFlag(out)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('steps[0].intent.producesFacts');
    expect(message).toContain('数组');
    expect(message).toContain('true');
  });

  it('② 空数组 → false，并 warn', () => {
    const out = normalizeProducesFacts(makeDraft([]));

    expect(firstFlag(out)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('false');
  });

  it('③ 已经是布尔值 → 原样透传，且一步都不许 warn', () => {
    for (const flag of [true, false]) {
      const out = normalizeProducesFacts(makeDraft(flag));
      expect(firstFlag(out)).toBe(flag);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('④ 字符串 / 数字 / 对象一律**不归一化**，仍由 schema 报错', () => {
    // 归一化必须保持"窄"：越猜越不可预测，猜错的那次不会有人知道。
    for (const flag of ['true', 1, { a: 1 }]) {
      const out = normalizeProducesFacts(makeDraft(flag));
      expect(firstFlag(out)).toStrictEqual(flag);
      expect(warn).not.toHaveBeenCalled();

      // 同一个值必须仍然过不了 schema —— 证明归一化不是万能橡皮擦。
      const parsed = parsePlanDraft(makeDraft(flag), CTX);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.outcome.error?.code).toBe('PROVIDER_VALIDATION_FAILED');
      }
    }
  });

  it('⑤ 省略该字段（走 schema 的 .default(false)）不受影响，也不 warn', () => {
    const out = normalizeProducesFacts(makeDraft(undefined));
    expect(warn).not.toHaveBeenCalled();
    // undefined 不该被塞进结果里；`.default(false)` 由 schema 负责。
    expect(firstFlag(out)).toBeUndefined();
  });

  it('⑥ 不修改入参（模型返回值可能还被别处持有）', () => {
    const raw = makeDraft(['a']) as { steps: Array<{ intent: { producesFacts: unknown } }> };
    normalizeProducesFacts(raw);

    expect(raw.steps[0].intent.producesFacts).toStrictEqual(['a']);
  });

  it('⑦ 没有需要归一化时返回原引用（调用方可靠 === 判断有没有被动过）', () => {
    const raw = makeDraft(true);
    expect(normalizeProducesFacts(raw)).toBe(raw);
  });

  it('⑧ 非对象 / steps 不是数组的入参原样返回，不炸', () => {
    for (const raw of [null, undefined, 42, 'text', [], { summary: 'x' }]) {
      expect(normalizeProducesFacts(raw)).toBe(raw);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('⑨ 多步骤各自独立：下标要打准，且 intent: null 的步骤不受影响', () => {
    const raw = {
      summary: '四步',
      steps: [
        { type: 'a', title: 'A', intent: null },
        { type: 'b', title: 'B', intent: { toolName: 't', input: {}, producesFacts: ['x'] } },
        { type: 'c', title: 'C', intent: null },
        { type: 'd', title: 'D', intent: { toolName: 't', input: {}, producesFacts: [] } },
      ],
    };
    const out = normalizeProducesFacts(raw) as {
      steps: Array<{ intent: { producesFacts: unknown } | null }>;
    };

    expect(out.steps[0].intent).toBeNull();
    expect(out.steps[2].intent).toBeNull();
    expect(out.steps[1].intent?.producesFacts).toBe(true);
    expect(out.steps[3].intent?.producesFacts).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('steps[1]');
    expect(String(warn.mock.calls[1]?.[0])).toContain('steps[3]');
  });

  it('⑩ warn 里不得出现模型的原始内容（可能很长且含用户输入）', () => {
    const secret = 'x'.repeat(200);
    normalizeProducesFacts(makeDraft([secret]));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(secret);
  });
});

describe('parsePlanDraft：归一化接在 schema 之前', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('① 数组写法不再让整轮计划作废', () => {
    const parsed = parsePlanDraft(makeDraft(['a', 'b']), CTX);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.steps[0].intent?.producesFacts).toBe(true);
      // 第二步是纯推理步骤：intent 为 null，不受归一化影响。
      expect(parsed.draft.steps[1].intent).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('② 空数组同样通过，且被归一化为 false', () => {
    const parsed = parsePlanDraft(makeDraft([]), CTX);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.steps[0].intent?.producesFacts).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('③ 合法布尔值路径完全不变，且不产生噪音日志', () => {
    const parsed = parsePlanDraft(makeDraft(true), CTX);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.draft.steps[0].intent?.producesFacts).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('④ 字符串仍然失败：归一化不负责猜', () => {
    const parsed = parsePlanDraft(makeDraft('true'), CTX);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.outcome.error?.code).toBe('PROVIDER_VALIDATION_FAILED');
      expect(parsed.outcome.error?.message).toContain('producesFacts');
    }
  });

  it('⑤ 其它字段的非法值不受 producesFacts 归一化影响', () => {
    const parsed = parsePlanDraft(
      { summary: 'x', steps: [{ type: '', title: '空 type' }] },
      CTX,
    );

    expect(parsed.ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

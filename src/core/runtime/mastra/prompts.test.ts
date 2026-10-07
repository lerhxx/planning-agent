/**
 * ★ 规划 / 重规划 prompt 的**步骤 id 契约**与 **`producesFacts` 契约**回归。
 *
 * ★★ 为什么会有这个文件：真模型路径上出现过两次确定性失败，**根因是同一个**——
 *   输出形状里给了字段名、却没给类型与含义：
 *   ① `StepDraft.id` 漏写。`id` 在 schema 里是可选字段（`shared/plan/types.ts` 的
 *      `zStepDraft`），不写内核就按数组下标回落成 `s-1` / `s-2` / …。
 *      模型因此不知道"id 是自己要写的"，产出空 `dependsOn` 或引用自己没声明过的 id，
 *      草案在依赖检查阶段被整包拒掉。同一段里还留着一句写残了的说明，
 *      等于没告诉模型 `dependsOn` 到底该写什么。
 *   ② `intent.producesFacts` 漏了类型。模型读成"这一步会产出这些"，回了一个**数组**，
 *      而 schema 要求 `boolean`，于是 `parsePlanDraft` 抛校验失败，**整轮计划作废**。
 *   所以：渲染输出形状时，**每个字段都必须带类型**，这是硬契约不是修辞。
 *
 * ★★ fixture 一律走 `zPlanRequest` / `zReplanRequest` 的 `parse`，**不手搓字面量**：
 *   这样 schema 一旦改（加必填字段、改枚举、收紧约束），本文件会**响亮地**抛错，
 *   而不是悄悄拿一份过期 fixture 通过 —— 后者会让守卫失真，比没有守卫更危险。
 *
 * ★★ 断言挑的是"稳定短语"而不是整句：prompt 文案本来就该允许润色，
 *   但契约的关键短语（`id?: string`、`本方案内`、`不得留空数组`、`producesFacts: boolean`）
 *   被改掉就一定意味着契约被削弱了，那时测试必须红。
 *
 * 本文件位于 `src/core/**`：禁止出现任何领域词（红线 8，扫描器**不剥注释**）。
 */
import { describe, expect, it } from 'vitest';
import { zPlanRequest, zReplanRequest } from '@/src/core/runtime/adapter';
import { planSystemPrompt, replanSystemPrompt } from '@/src/core/runtime/mastra/prompts';

/* ------------------------------------------------------------------ *
 * fixture：全部由 zod 现成 schema 校验后产出
 * ------------------------------------------------------------------ */

const GOAL = {
  id: 'g-1',
  runId: 'run-1',
  raw: '把一个目标拆解成有序、可执行的步骤',
  summary: '把一个目标拆解成有序、可执行的步骤',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** 通用步骤类型描述：只描述"做什么"，不携带任何具体业务语义。 */
const STEP_TYPES = [
  {
    type: 'retrieve',
    label: '取回素材',
    description: '取回后续步骤需要的素材',
    maxAttempts: 2,
  },
  {
    type: 'compose',
    label: '汇总产出',
    description: '把上游步骤的产出汇总成最终产出',
    maxAttempts: 2,
  },
];

const PLAN_REQUEST = zPlanRequest.parse({
  goal: GOAL,
  stepTypes: STEP_TYPES,
  templates: [
    {
      id: 'tpl-1',
      description: '先取素材再汇总',
      steps: [
        { id: 's-1', type: 'retrieve', title: '取回素材' },
        { id: 's-2', type: 'compose', title: '汇总产出', dependsOn: ['s-1'] },
      ],
    },
  ],
  signals: ['文本输入'],
  revision: 1,
});

const RETAINED_STEP = {
  id: 's-1',
  domainId: 'generic',
  type: 'retrieve',
  order: 0,
  title: '取回素材',
  origin: { kind: 'planner', revision: 1 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const IMPACTED_STEP = {
  id: 's-2',
  domainId: 'generic',
  type: 'compose',
  order: 1,
  title: '汇总产出',
  dependsOn: ['s-1'],
  origin: { kind: 'planner', revision: 1 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const REPLAN_REQUEST = zReplanRequest.parse({
  goal: GOAL,
  revision: 2,
  trigger: 'PROVIDER_VALIDATION_FAILED',
  failedStepIds: ['s-2'],
  impactedStepIds: ['s-2'],
  retainedSteps: [RETAINED_STEP],
  impactedSteps: [IMPACTED_STEP],
  stepTypes: STEP_TYPES,
  templates: [],
});

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

/** 从"## 输出结构"截到契约段之前，用于比较两个 prompt 的形状是否同源。 */
function outputShapeSection(text: string): string {
  const start = text.indexOf('## 输出结构');
  const end = text.indexOf('## 步骤 id 与 dependsOn 的契约');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end).trim();
}

const CASES = [
  { name: 'planSystemPrompt', render: (): string => planSystemPrompt(PLAN_REQUEST) },
  { name: 'replanSystemPrompt', render: (): string => replanSystemPrompt(REPLAN_REQUEST) },
];

describe.each(CASES)('$name：StepDraft 的 id 与 dependsOn 契约', ({ render }) => {
  const text = render();

  it('① 输出形状里声明了可选的步骤 id', () => {
    expect(text).toMatch(/id\??:\s*string/);
    expect(text).toContain('StepDraft = { id?: string');
  });

  it('② 写明了 dependsOn 只能引用本方案内已声明的步骤 id', () => {
    expect(text).toContain('本方案内');
    expect(text).toContain('`dependsOn`');
  });

  it('③ 说明了不写 id 时的回落后果（顺序生成的 id 无法被可靠引用）', () => {
    expect(text).toContain('s-1');
  });

  it('④ 禁止消费上游产出时把 dependsOn 留成空数组', () => {
    expect(text).toContain('不得留空数组');
  });

  it('⑤ 不再包含旧的残句', () => {
    expect(text).not.toContain('数组下标顺序');
  });
});

/*
 * ★★ `producesFacts` 契约回归（与上面同源的第二个坑）。
 *   真模型把这个字段填成了**数组**（读成"这一步会产出这些"），
 *   而 schema 要求 boolean，于是整轮计划在解析阶段被拒。
 *   根因与 `id` 那次完全一样：输出形状里**有字段名、没类型**。
 */
describe.each(CASES)('$name：intent.producesFacts 的类型与含义契约', ({ render }) => {
  const text = render();

  it('① 输出形状里写明了 producesFacts 是 boolean', () => {
    expect(text).toMatch(/producesFacts:\s*boolean/);
    expect(text).toContain(
      'intent: { toolName: string, input: object, producesFacts: boolean } | null',
    );
  });

  it('② 不再出现无类型的裸字段名写法', () => {
    expect(text).not.toContain('intent: { toolName, input, producesFacts }');
  });

  it('③ 有独立的契约段落，并写明它是布尔值而非数组/字符串', () => {
    expect(text).toContain('## intent.producesFacts 的契约');
    expect(text).toContain('布尔值');
    expect(text).toMatch(/不是数组、不是字符串、不是数字/);
  });

  it('④ 说清了 true 的语义：产出被视为事实，因而必须带来源引用', () => {
    expect(text).toContain('事实');
    expect(text).toContain('来源引用');
  });

  it('⑤ 给了不确定时的出路：填 false，或把 intent 整体设为 null', () => {
    expect(text).toMatch(/不确定就填\s*`false`/);
    expect(text).toContain('`intent` 整体设为 `null`');
  });
});

describe('两个 prompt 的输出形状必须同源', () => {
  it('重规划 prompt 不得只留一行、漏掉 StepDraft 的展开', () => {
    const planShape = outputShapeSection(planSystemPrompt(PLAN_REQUEST));
    const replanShape = outputShapeSection(replanSystemPrompt(REPLAN_REQUEST));
    expect(replanShape).toBe(planShape);
    expect(replanShape.split('\n').length).toBeGreaterThan(2);
  });

  it('producesFacts 契约段必须同源：两处不一致同样是真实的故障源', () => {
    const section = (text: string): string => {
      const start = text.indexOf('## intent.producesFacts 的契约');
      expect(start).toBeGreaterThanOrEqual(0);
      return text.slice(start).trim();
    };
    expect(section(replanSystemPrompt(REPLAN_REQUEST))).toBe(section(planSystemPrompt(PLAN_REQUEST)));
  });
});

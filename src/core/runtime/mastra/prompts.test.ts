/**
 * ★ 规划 / 重规划 prompt 的**步骤 id 契约**、**`producesFacts` 契约**与
 * **可用工具清单**回归。
 *
 * ★★ 为什么会有这个文件：真模型路径上出现过三次确定性失败，**根因是同一个**——
 *   输出形状里给了字段名、却没给类型与含义；或契约引用了一个从未渲染的章节：
 *   ① `StepDraft.id` 漏写。`id` 在 schema 里是可选字段（`shared/plan/types.ts` 的
 *      `zStepDraft`），不写内核就按数组下标回落成 `s-1` / `s-2` / …。
 *      模型因此不知道"id 是自己要写的"，产出空 `dependsOn` 或引用自己没声明过的 id，
 *      草案在依赖检查阶段被整包拒掉。同一段里还留着一句写残了的说明，
 *      等于没告诉模型 `dependsOn` 到底该写什么。
 *   ② `intent.producesFacts` 漏了类型。模型读成"这一步会产出这些"，回了一个**数组**，
 *      而 schema 要求 `boolean`，于是 `parsePlanDraft` 抛校验失败，**整轮计划作废**。
 *   ③ ★★ "可用工具"清单**从未被渲染**，而 `commonRules()` 却要求模型只能用它列出的
 *      toolName。模型只能猜工具名，猜错就撞上`工具未在当前领域注册`，
 *      步骤全失败、耗尽重排次数，错误信息与真实病因完全无关。
 *   共同形态：**prompt 声称提供了某项信息，实际没提供**。
 *   所以：渲染输出形状时每个字段都必须带类型；契约引用的每一节都必须真的渲染出来。
 *
 * ★★ fixture 一律走 `zPlanRequest` / `zReplanRequest` 的 `parse`，**不手搓字面量**：
 *   这样 schema 一旦改（加必填字段、改枚举、收紧约束），本文件会**响亮地**抛错，
 *   而不是悄悄拿一份过期 fixture 通过 —— 后者会让守卫失真，比没有守卫更危险。
 *   （第 ③ 次修复正是靠这条纪律暴露了 `tools` 是必填字段：手搓字面量的写法会漏掉它。）
 *
 * ★★ 断言挑的是"稳定短语"而不是整句：prompt 文案本来就该允许润色，
 *   但契约的关键短语（`id?: string`、`本方案内`、`不得留空数组`、`producesFacts: boolean`、
 *   `name="…"`）被改掉就一定意味着契约被削弱了，那时测试必须红。
 *
 * 本文件位于 `src/core/**`：禁止出现任何领域词（红线 8，扫描器**不剥注释**）。
 */
import { describe, expect, it } from 'vitest';
import { zPlanRequest, zReplanRequest } from '@/src/core/runtime/adapter';
import type { PlanRequest, ReplanRequest } from '@/src/core/runtime/adapter';
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

/**
 * 领域注册过的工具清单（给模型看的）。刻意用**不像类型名**的名字 ——
 * 模型看到的就是这些字符串，它写`intent.toolName` 时只可能照抄。
 */
const TOOLS = [
  { name: 'unit.fetch', description: '按关键词取回素材', maxAttempts: 2 },
  { name: 'unit.publish', description: '把素材发布成最终产物', maxAttempts: 3 },
];

const PLAN_REQUEST = zPlanRequest.parse({
  goal: GOAL,
  stepTypes: STEP_TYPES,
  tools: TOOLS,
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
  tools: TOOLS,
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

  it('★ 可用工具清单段必须同源：重排换了工具名，它更需要知道有哪些合法名字', () => {
    const section = (text: string): string => {
      const start = text.indexOf('## 可用工具');
      expect(start).toBeGreaterThanOrEqual(0);
      const end = text.indexOf('## ', start + 1);
      return text.slice(start, end === -1 ? undefined : end).trim();
    };
    const planSection = section(planSystemPrompt(PLAN_REQUEST));
    expect(planSection).toBe(section(replanSystemPrompt(REPLAN_REQUEST)));
    // 清单不许是空的：空清单会被渲染成"所有 intent 必须为 null"
    expect(planSection).not.toBe('## 可用工具\n- （无）');
  });
});

/* ------------------------------------------------------------------ *
 * ★★ 第六个 bug：prompt 声称有"可用工具"清单，实际从未渲染
 * ------------------------------------------------------------------ */

/*
 * 故障现象（真模型路径）：四个步骤全部失败，报`工具未在当前领域注册`，
 * 耗尽 5 次重排后以 MAX_REPLANS 收场。
 *
 * 根因：`commonRules()` 一直写着"只能使用下方『可用工具』里列出的 toolName"，
 * 而这个章节**从来没有被渲染过**，`PlanRequest` / `ReplanRequest` 里也没有 `tools` 字段。
 * 模型于是只能凭语义猜工具名（把领域概念自行拼成"名.动作"的形状），
 * 猜错就撞上执行期的 `工具未在当前领域注册`。
 *
 * 为什么 Mock 一直是绿的：它回放领域模板，模板里的 `toolName` 本来就对，
 * **根本不需要模型知道有哪些工具**。缺口因此从未暴露 —— 与前五次同源。
 */
describe.each(CASES)('$name：可用工具清单必须真的渲染出来', ({ render }) => {
  const text = render();

  it('① 存在"可用工具"章节', () => {
    expect(text).toContain('## 可用工具');
  });

  it('② 清单里有注册的真实工具名（模型只能照抄这些名字）', () => {
    for (const tool of TOOLS) {
      expect(text).toContain(`name="${tool.name}"`);
    }
  });

  it('③ 每条都带用途说明与重试上限（模型要据此判断值不值得重试）', () => {
    expect(text).toContain('说明="按关键词取回素材"');
    expect(text).toMatch(/最多尝试\s*\d+\s*次/);
    // ★ 两个工具的上限刻意不同（2 与 3）：若渲染写死成同一个数，这条会变红。
    expect(text).toContain('最多尝试 2 次');
    expect(text).toContain('最多尝试 3 次');
  });

  it('④ 硬性约束确实指向这一节，且要求逐字照抄', () => {
    expect(text).toContain('"可用工具"里列出的 toolName');
    expect(text).toMatch(/逐字相同/);
  });

  it('⑤ 不再有"清单为空就放弃工具"的误导（清单非空时不得出现该指令）', () => {
    // 反向断言：非空清单下出现"必须设为 null"就是错的指令
    expect(text).not.toContain('当前领域没有注册任何工具');
  });
});

describe('工具清单为空时（领域没注册工具）', () => {
  /** 空清单：字段留着（走 schema 校验），值是空数组。 */
  const emptyPlan = zPlanRequest.parse({ ...PLAN_REQUEST, tools: [] });
  const emptyReplan = zReplanRequest.parse({ ...REPLAN_REQUEST, tools: [] });
  const CASES_EMPTY = [
    { name: 'planSystemPrompt', render: (): string => planSystemPrompt(emptyPlan) },
    { name: 'replanSystemPrompt', render: (): string => replanSystemPrompt(emptyReplan) },
  ];

  it.each(CASES_EMPTY)('$name：显式说明没有可用工具，并要求把 intent 设为 null', ({ render }) => {
    const text = render();
    // 章节本身必须在（模型得知道"没有"也是一个明确答案）
    expect(text).toContain('## 可用工具');
    expect(text).toContain('当前领域没有注册任何工具');
    // 关键：光说"没有"不够，必须给出处置指令，否则模型会去猜名字
    expect(text).toMatch(/intent 都必须设为\s*null/);
    // 此时列一个具体工具名就是错的
    expect(text).not.toContain('name="unit.fetch"');
  });
});

/*
 * ★ 缺省（`tools` 为 `undefined`）必须与"确实为空"**可区分**。
 * 该字段是 optional（权威来源是注册表，runtime 会覆盖它），
 * 所以"忘了传"这种状态是真实可达的——而它恰恰是本次故障的形态。
 * 若两者渲染成同一段空清单，"漏传"就会静默退化成"这个领域没有工具"，
 * 模型于是放弃全部工具调用，且没有任何迹象表明真正的原因是漏传。
 */
describe('工具清单缺省时（tools 为 undefined）', () => {
  /** 绕过 zod 的default，手搓一个"没带tools"的请求（这正是要模拟的形态）。 */
  const missingPlan = { ...PLAN_REQUEST, tools: undefined } as unknown as PlanRequest;
  const missingReplan = { ...REPLAN_REQUEST, tools: undefined } as unknown as ReplanRequest;
  const CASES_MISSING = [
    { name: 'planSystemPrompt', render: (): string => planSystemPrompt(missingPlan) },
    { name: 'replanSystemPrompt', render: (): string => replanSystemPrompt(missingReplan) },
  ];

  it.each(CASES_MISSING)('$name：说清是"没拿到清单"，而不是"这个领域没有工具"', ({ render }) => {
    const text = render();
    expect(text).toContain('## 可用工具');
    // 必须与"确实为空"那句话不同，否则两种故障态无法区分
    expect(text).toContain('本次请求未携带工具清单');
    expect(text).not.toContain('当前领域没有注册任何工具');
    // 仍然要给出处置指令：不得写 intent
    expect(text).toMatch(/intent 一律设为\s*null/);
    // 一个具体工具名都不许出现
    expect(text).not.toContain('name="unit.fetch"');
  });
});

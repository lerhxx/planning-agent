/**
 * 规划 / 重规划的 system prompt —— **纯字符串，无领域词**（红线 8）。
 *
 * ★ 设计原则：prompt 只描述"**如何**规划"，不描述"规划什么"。
 *   可用的步骤类型、工具、模板全部由调用方从领域包取出后**注入**，
 *   所以同一份 prompt 对任何领域都成立 —— 内核不认识任何领域语义。
 *
 * ★ 反幻觉（红线 16）：prompt 明确告诉模型"事实只能来自工具返回"，
 *   但**真正的闸门不在这里** —— `src/core/execution/observer.ts:41-52` 的
 *   `SOURCE_MISSING` 硬检查才是强制点。prompt 只是让模型少犯错，
 *   闸门负责"模型仍然编了"的情况。两者不可互相替代。
 *
 * ★ 步骤 id 契约：见下方 `idContract()`（`StepDraft.id` 在 schema 里是**可选**的，
 *   省略时内核按数组下标回落成 `s-1` / `s-2` / …，模型不写就无从引用）。
 *   旧版 prompt 只渲染了形状、没渲染 `id`，模型就不知道"id 是自己要写的"，
 *   于是产出空 `dependsOn` 或引用未声明的 id，草案在编译前的依赖检查阶段被整包拒掉。
 *
 * ★ `producesFacts` 契约：见下方 `producesFactsContract()`。这一段是**同类的第二次犯病**：
 *   同一个 `intent` 形状里，字段**名字**被渲染了但**类型与含义**没渲染，
 *   模型于是把 `producesFacts` 理解成"这一步会产出这些"，回了一个**数组**；
 *   而 `zStepIntent.producesFacts` 是 `z.boolean()`（`shared/plan/types.ts`），
 *   于是 `parsePlanDraft` 抛 `PROVIDER_VALIDATION_FAILED`，**整轮计划直接作废**。
 *   少写类型，模型就会自己发明类型 —— 渲染形状时**每个字段都必须带类型**。
 *
 * 结论：`renderOutputShape()` / `idContract()` / `producesFactsContract()` 三段
 * 都是**硬契约，不是修辞**：少任何一条，模型都会稳定地掉回同一个坑。
 *
 * ★ 工具清单：见下方 `renderTools()`。这是**同一个 bug 家族的第六个成员**：
 *   `commonRules()` 一直写着"只能使用下方『可用工具』里列出的 toolName"，
 *   而这个"可用工具"章节**从来没有被渲染过**，`PlanRequest` 里也没有 `tools` 字段——
 *   契约声称提供了某项信息，实际没提供，模型于是只能凭语义猜工具名
 *   （把一个领域概念自行拼成"名.动作"的形状），猜错就撞上 `工具未在当前领域注册`，
 *   四个步骤全失败、耗尽重排次数。Mock 因为回放模板从不需要这个清单，一直是绿的。
 *
 * ★★ 工具入参：同一家族的**第七个成员**，比第六个更深一层：
 *   清单曾经只给工具名，**不给 `intent.input` 的结构**，于是模型只能照着
 *   description 里的自然语言标签去填枚举字段 —— 而真实契约只认机器取值。
 *   工具名对了、入参错了，执行期照样拒收，且抛出的错误与"入参不合法"完全对不上。
 *   现在 `renderTools()` 连入参约束一起渲染（推导见 `adapter.ts` 的 `toolInputJsonSchema`：
 *   从领域**真实**的 zod schema 现场导出，不是手抄的枚举表）。
 */
import type { PlanRequest, ReplanRequest, ToolInputSchema } from '@/src/core/runtime/adapter';

/** 通用约束段：两个 prompt 共用。 */
function commonRules(): string {
  return [
    '## 硬性约束',
    '1. 只能使用下方"可用步骤类型"里列出的 type，不得自造。',
    // ★ 这一条现在**有**对应的章节了（`renderTools()` 在两个 prompt 里都渲染）。
    //   措辞与渲染保持一致：章节标题是"可用工具"，字段名是 `toolName`。
    '2. 只能使用下方"可用工具"里列出的 toolName：必须与清单里的 name 逐字相同，',
    '   不得改写大小写、不得替换分隔符、不得拼接或省略任何字符。',
    '3. "可用工具"清单为空（或显示为"（无）"）时，所有步骤的 intent 都必须设为 null：',
    '   此时不存在任何你可以调用的工具。',
    '4. dependsOn 只能引用同一个方案中出现过的步骤 id；不得引用不存在的 id。',
    '5. 不得输出任何未在上文出现的具体事实数值（价格、评分、耗时、距离等）。',
    '   事实只能由工具在执行阶段返回；你只负责编排顺序与依赖。',
    '6. 除非确有把握，纯推理步骤（intent 为 null）优于编造工具调用。',
    '7. 输出必须严格符合给定的 JSON 结构，不要包裹在解释性文字或代码块里。',
  ].join('\n');
}

/**
 * 输出形状。**规划与重规划共用同一份**，两处不一致是真实的故障源
 * （历史上重规划只留了一行 `{ "summary": string, "steps": StepDraft[] }`，
 * 没展开 `StepDraft`，模型拿到的契约就是残缺的）。
 *
 * ★ `id` 必须出现在这里：`zStepDraft.id` 是可选字段，不渲染模型就不知道它能写。
 *
 * ★★ `intent` 的三个字段**都要带类型**（本轮修复点）：此前这一行只写了
 *   `intent: { toolName, input, producesFacts } | null` —— 有名字、没类型。
 *   模型于是把 `producesFacts` 当成"这一步会产出这些"，回了一个数组，
 *   而 schema 要求 `boolean`，整轮计划在解析阶段被拒。
 *   只写 `estimate?: { durationMs, costCNY, confidence }` 是同一个毛病的残留，
 *   一并补上类型。
 */
function renderOutputShape(): string {
  return [
    '## 输出结构',
    '{ "summary": string, "steps": StepDraft[] }',
    'StepDraft = { id?: string, type: string, title: string, description?: string, dependsOn: string[],',
    '              parallelGroup?: string,',
    '              intent: { toolName: string, input: object, producesFacts: boolean } | null,',
    '              estimate?: { durationMs: number, costCNY: number, confidence: number } }',
  ].join('\n');
}

/**
 * 步骤 id 与 `dependsOn` 的契约（硬约束，逐条对齐内核的依赖检查）。
 *
 * ★ 三条一条都不能省：
 *   ① 显式写 `id`（否则回落到按顺序生成的 id，无法在前向引用里稳定指向）；
 *   ② `dependsOn` 只写本方案内已声明的 `id`，不写下标 / 标题 / 类型名；
 *   ③ 消费上游产出的步骤必须把上游写进 `dependsOn`，空数组等于"凭空产出"。
 */
function idContract(): string {
  return [
    '## 步骤 id 与 dependsOn 的契约',
    '1. 每个步骤都请显式给出 `id`：只用小写字母、数字和短横线，且在本方案内唯一。',
    '2. 不写 `id` 的步骤，内核会按顺序自动生成 `s-1`、`s-2`…；',
    '   那样你就无法在 `dependsOn` 里可靠引用它 —— 所以请显式写。',
    '3. `dependsOn` 只能写**本方案内你已经声明过的步骤 `id`**：',
    '   不得写数组下标、不得写步骤标题、不得写步骤类型名。',
    '4. 若某步骤需要消费前面步骤的产出，**必须**把这些步骤的 id 写进 `dependsOn`，不得留空数组。',
  ].join('\n');
}

/**
 * `intent.producesFacts` 的契约（硬约束；规划与重规划共用，与 `idContract()` 同级）。
 *
 * ★ 为什么必须显式写：真模型路径上出现过一次确定性失败 —— 模型把 `producesFacts`
 *   填成**数组**（读成"这一步会产出这些"），而 `zStepIntent.producesFacts` 是
 *   `z.boolean()`，于是 `parsePlanDraft` 抛校验失败，**整轮计划作废**。
 *   prompt 只给了字段名、没给类型和含义，模型就自己发明了类型。
 *
 * ★ 三条一条都不能省：
 *   ① 它是**布尔值**，不是数组、不是字符串、不是数字；
 *   ② 语义是"这一步的产出**算不算事实**"（算事实就必须带来源引用），
 *      而不是"这一步会产出什么"——后者是数组的读法，正是这次翻车的根因；
 *   ③ 拿不准就填 `false`：填错成数组会让整轮计划直接作废，而 `false` 只是少标一次。
 *
 * ★ 真正的闸门不在 prompt（红线 16）：`src/core/execution/observer.ts` 里
 *   `SOURCE_MISSING` 的硬检查才是强制点。这里只是把模型的默认猜测掰到正确一侧。
 */
function producesFactsContract(): string {
  return [
    '## intent.producesFacts 的契约',
    '1. `producesFacts` 的类型是**布尔值**（`true` / `false`）：',
    '   不是数组、不是字符串、不是数字。它只回答"是/否"，不回答"是什么"。',
    '2. 只有当这一步工具的产出会被当作**事实**（因而必须携带来源引用）时才填 `true`；',
    '   纯推理步骤填 `false`，或者把 `intent` 整体设为 `null`。',
    '3. 不确定就填 `false`：漏标 `true` 只是少一次来源校验，',
    '   填成数组则会让整轮计划**直接作废**。',
  ].join('\n');
}

/** 把领域声明的步骤类型渲染成 prompt 片段。 */
function renderStepTypes(request: PlanRequest | ReplanRequest): string {
  const lines = request.stepTypes.map(
    (descriptor) =>
      `- type="${descriptor.type}" | 含义="${descriptor.label}" | 说明="${descriptor.description}" | 最多尝试 ${descriptor.maxAttempts} 次`,
  );
  return ['## 可用步骤类型', ...(lines.length > 0 ? lines : ['- （无）'])].join('\n');
}

/**
 * ★ 把领域**真实注册**的工具清单渲染成 prompt 片段（规划与重规划共用）。
 *
 * ## 为什么这是硬契约而不是可选项
 *
 * `commonRules()` 要求"只能使用本节列出的 toolName"，而模型写 `toolName` 时
 * 除了这里**没有任何其它途径**知道有哪些工具。没有这一节，它只能猜——
 * 猜错的后果不是一次校验失败，而是每一次工具调用都返回 `工具未在当前领域注册`，
 * 步骤重试到上限全失败，最后以「重排耗尽」收场：用户看到的错误与真实病因完全无关。
 *
 * ## 两种"没有工具"必须可区分
 *
 * ① 清单为空数组 = 领域确实没注册工具；
 * ② 清单为 `undefined` = **调用方没传**（字段是 optional，权威来源是注册表）。
 * ② 恰恰是本次故障的形态，若也渲染成空清单，模型就会读成"这个领域没有工具"、
 * 放弃全部工具调用，而且**没有任何迹象**表明真正原因是漏传。
 * 所以两种情况给两句不同的话，各自都带处置指令。
 *
 * ## 顺序
 *
 * 清单顺序由 `adapter.ts` 的 `ToolBrief[]` 决定，内核那边已按注册名字典序排好
 * （见 `domainRegistry.ts` 的 `getTools`）—— prompt 不重排，避免同一份注册表
 * 在两次渲染间给出不同顺序。
 *
 * ## ★ 为什么连`inputSchema` 一起渲染（这是"同一个 bug 家族的第七个成员"）
 *
 * 清单此前只给`name` / `description` / `maxAttempts`，模型看不到 `intent.input`
 * 的结构 —— 只能照着 description **猜字段的取值**。而 description 写的是
 * 人类可读的标签，模型就把标签填进了只认机器取值的枚举字段，于是执行期拒收、
 * 步骤全失败、耗尽重排次数，用户看到的报错与真实病因完全无关。
 *
 * 与前六个成员同源：**契约声称提供了某项信息，实际没提供**。
 * 补上之后，"工具名"和"入参取值"两类猜测同时消失。
 *
 * ## 渲染形态与取舍（只保留模型必需的约束）
 *
 * 每个字段一行 `字段名: 类型 | 必填/可选 |枚举 / 范围`，理由：
 *
 * - **枚举逐字列出**：这是本次修复的核心，模型必须一眼看到全部合法取值；
 * - **必填 vs 可选**：靠 JSON Schema 的 `required`（以 input 视角导出，
 *   带默认值的字段不算必填）—— 不分这个，模型会以为每个字段都得填；
 * - **数值范围**：`limit` 这类字段模型爱自己发挥数字，越界同样是静默拒收；
 * - **不渲染** `default` / `description` /嵌套结构：`default` 对模型是无用的
 *   （它不需要知道"不填会变成什么"，只需要知道"可以不填"）；
 *   嵌套结构本仓工具入参里不存在，真出现了也应该由领域去接，而不是让
 *   内核 prompt 渲染器替它决定怎么讲。**这一条是取舍，不是遗漏。**
 */
function renderTools(request: PlanRequest | ReplanRequest): string {
  const tools = request.tools;
  if (!tools) {
    return [
      '## 可用工具',
      '- （本次请求未携带工具清单。你无法得知有哪些工具可用，',
      '   因此不得写出任何 intent：所有步骤的 intent 一律设为 null。）',
    ].join('\n');
  }
  if (tools.length === 0) {
    return [
      '## 可用工具',
      '- （无）—— 当前领域没有注册任何工具，因此**所有步骤的 intent 都必须设为 null**。',
    ].join('\n');
  }
  const lines = tools.flatMap((tool) => [
    `- name="${tool.name}" | 说明="${tool.description}" | 最多尝试 ${tool.maxAttempts} 次`,
    ...renderToolInput(tool.inputSchema),
  ]);
  return ['## 可用工具', ...lines].join('\n');
}

/**
 * 把单个工具的入参约束渲染成若干行（无字段时返回空数组，清单只剩工具名那几行）。
 *
 * ★ 独立成函数而不是内联在 `renderTools` 里：这段是本文件里唯一**读 schema**
 *   的地方，单独隔离才能在 schema 变复杂时定点处理，而不是去翻一个混在一起的 map。
 */
function renderToolInput(input: ToolInputSchema | undefined): string[] {
  const fields = Object.entries(input?.fields ?? {});
  if (fields.length === 0) return [];
  const required = new Set(input?.required ?? []);

  const rows = fields.map(([name, field]) => {
    const parts = [`类型=${field.type === '' ? '任意' : field.type}`];
    parts.push(required.has(name) ? '必填' : '可选');
    if (field.enum.length > 0) {
      parts.push(`只能取${field.enum.map((value) => `"${value}"`).join(' / ')}`);
    }
    const bounds = Object.entries(field.bounds).map(([key, value]) => `${key}=${value}`);
    if (bounds.length > 0) parts.push(`范围 ${bounds.join(' ')}`);
    return `    · ${name}: ${parts.join('，')}`;
  });

  return ['  入参 intent.input 必须是对象，且只能使用下列字段与取值：', ...rows];
}

/** 规划 prompt。 */
export function planSystemPrompt(request: PlanRequest): string {
  const templates = request.templates.map(
    (template) =>
      `- 模板 id="${template.id}"：${template.description}（含 ${template.steps.length} 个步骤）`,
  );

  return [
    '你是一个规划器。用户给出一个目标，你把它拆解成有序、可执行的步骤。',
    '',
    `## 目标\n${request.goal.summary || '(用户未提供文字描述)'}`,
    '',
    `## 输入信号\n${request.signals.length > 0 ? request.signals.join('、') : '(无)'}`,
    '',
    renderStepTypes(request),
    '',
    renderTools(request),
    '',
    ['## 可用模板', ...(templates.length > 0 ? templates : ['- （无）'])].join('\n'),
    '',
    commonRules(),
    '',
    renderOutputShape(),
    '',
    idContract(),
    '',
    producesFactsContract(),
  ].join('\n');
}

/** 重规划 prompt。 */
export function replanSystemPrompt(request: ReplanRequest): string {
  /*
   * ★ 失败原因必须渲染出来，否则精确报错只到内核为止、模型看不到。
   *   重排是"让模型换掉失败的那几步"的唯一机会，而模型此刻**无法凭空知道**
   *   上次错在哪个字段、应该填什么值 —— 不给它失败原因，它只能换个写法再撞一次，
   *   于是 `MAX_REPLANS` 收场。这里渲染的是 `step.error.message`：
   *   工具层已保证它只含"字段名 + 合法取值"（入参校验失败时），
   *   而内核自己的兜底文案也全是常量，不含用户原文。
   */
  const impacted = request.impactedSteps.map((step) => {
    const reason = step.error?.message ? ` | 上次失败原因="${step.error.message}"` : '';
    return `- id="${step.id}" type="${step.type}" title="${step.title}"${reason}`;
  });
  const retained = request.retainedSteps.map((step) => `- id="${step.id}" title="${step.title}"`);

  return [
    '你是一个重规划器。已有方案的一部分步骤失败或需要替换，你要为**受影响的那部分**产出新步骤。',
    '',
    `## 目标\n${request.goal.summary || '(用户未提供文字描述)'}`,
    `## 触发原因\n${request.trigger}`,
    '',
    ['## 需要被替换的步骤', ...(impacted.length > 0 ? impacted : ['- （无）'])].join('\n'),
    '',
    ['## 必须保留的步骤（不得删除、不得改 id）', ...(retained.length > 0 ? retained : ['- （无）'])].join('\n'),
    '',
    renderStepTypes(request),
    '',
    // ★ 重排同样要看到真实工具清单：这一步换掉的就是"调工具的那几步"，
    //   拿不到清单就等于让它凭空重发一个同样不存在的工具名。
    renderTools(request),
    '',
    commonRules(),
    '',
    '## 本次特有的硬性约束',
    '1. **只输出需要替换的新步骤**，不要重复输出"必须保留的步骤"。',
    '2. 新步骤不得复用"必须保留的步骤"的 id。',
    '3. 不得引用"必须保留的步骤"以外的、已不存在的旧步骤 id。',
    '4. 新方案必须与原方案**实质不同**：仅改标题、仅调顺序都算原地打转，',
    '   会被内核的收敛判定拦下并转人工。这里请真正改变步骤的类型或意图。',
    '',
    renderOutputShape(),
    '',
    idContract(),
    // ★ 下面第 5 条是重规划对 idContract 的补充说明（解释"本方案内"的例外）。
    //   producesFactsContract() 放在**最后**，是为了让该契约段落在两个 prompt 里
    //   都是同一段末尾文本 —— `prompts.test.ts` 断言两处逐字同源。
    '5. 重规划时，"本方案内已声明的步骤"包含两类：上方"必须保留的步骤"的 id，',
    '   以及你本次新声明的步骤 id —— 两者都可以写进 `dependsOn`。',
    '',
    producesFactsContract(),
  ].join('\n');
}

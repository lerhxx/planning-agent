# 04 · Domain Pack 开发指南

> 对应 commit `dc9248c`（tag `m1-core-only`）。
> 读者假定：9 年经验前端、没看过本仓库代码。照着本文你能**从零写出一个领域包，且不改内核一行**。
> 契约字段的完整字段表在 `techDocs/02`；本文只在示例里用到字段，需要时指向它。
> 提示：`src/domains/demo/` 是**验证装置，不是产品领域**（其文件头有注释说明），它的作用只是证明内核闭环能跑通。你写真实领域时照它的"形状"复制即可，但不要依赖它的 fixture 数据。

---

## 1. 什么是 Domain Pack

内核是**领域无关**的基座：它提供注册表、路由匹配、Planner/Executor/Scheduler/Observer/Replanner、状态机、流式协议、重规划三重闸门、通用降级组件。它**不认识任何业务名词**。

领域包（Domain Pack）是内核唯一的"扩展点"：把某个具体领域的全部知识塞进一个对象，内核只按契约消费它。新增一个领域 = 在 `src/domains/<id>/` 放一组文件 + 在两个桶文件各加一行，**内核零改动**。

### 职责边界表

| 能力 | 内核提供 | 领域包负责 |
|---|---|---|
| 注册与完整性守卫 | ✅ `registerDomainPack` + 缺段即失败 | 提供 8 段完整对象 |
| 目标路由到领域 | ✅ 读 `meta.matcher` / `requiredSignals` | 提供关键词、信号权重 |
| 是否允许产出"事实" | ✅ 读 `capabilities.providers` | 声明 `providers` 能力开关 |
| 计划生成 / 执行 / 重规划 | ✅ 通用引擎 | 提供 `stepTypes` 白名单与模板 |
| 步骤合法性闸门 | ✅ 调 `validateStep` / `createValidator`，**只读 `ok` 与 `severity`** | 写出领域校验规则 |
| 事实数据来源（反幻觉） | ❌ 内核**不**持有任何数据 | ✅ Provider 是唯一事实源 |
| 生成式 UI 渲染 | ✅ 渲染管线 + 通用降级组件 | 提供组件、`toProps`、降级链 |
| 提示词与世界观 | ✅ 强制注入 `antiHallucination` | 提供 `worldview`/`constraints`/`planning` |

**铁律回顾**：`src/core/**` 与 `shared/**`（仓库根目录的 `shared/`）禁止出现任何领域词；内核只消费 `validate()` 的 `ok` 与 `severity`，**绝不**读 `.code`/`.message`/`.suggestion`/`.evidence`；事实只能来自 Provider，模型不得编造。

---

## 2. 8 段契约逐段说明

契约类型真源在 `shared/domain/types.ts`（zod 4），`DomainPack` 接口要求以下 7 段必填、`lifecycle` 可选：

```
meta · tools · providers · ui · prompts · planning · evaluation  （缺一段注册即失败）
lifecycle  （可选）
```

### ① meta —— 领域元数据与路由匹配
- **必须提供**：`id`（正则 `/^[a-z][a-z0-9-]{1,31}$/`）、`displayName`、`version`（semver）、`schemaVersion: 1`、`description`、`matcher`、`capabilities`。
- **内核怎么用**：路由模型读 `matcher.keywords/patterns/negativeKeywords/scoreBySignals` 选领域；`requiredSignals`（image/text/geo/link/file）做输入门槛；`capabilities.providers=false` 时**禁止模型产出事实，只能给观点**。
- **最小示例**：
  ```ts
  export const fitMeta: DomainMeta = {
    id: 'fit',
    displayName: '健身训练周计划',
    version: '0.1.0',
    schemaVersion: 1,
    description: '把体能目标拆成一周训练排期',
    matcher: { keywords: ['健身', '训练', '增肌'], patterns: [], negativeKeywords: [], scoreBySignals: { text: 1 } },
    requiredSignals: ['text'],
    capabilities: { vision: false, geo: false, providers: true, timeSequence: false },
  };
  ```
- **常见错误**：`id` 含大写或下划线（正则不过）；漏掉 `capabilities`；`schemaVersion` 写成 `2`（当前只接受字面量 `1`）。

### ② tools —— 工具集
- **必须提供**：`ToolSet`（`Record<name, ToolSpec>`）。每个工具必带 `inputSchema`（zod）、`producesFacts`、`stepType`，并在 `execute` 里返回 `ToolResult`。
- **内核怎么用**：Planner 据 `stepType` 反推 `step.type`；`producesFacts=true` 的工具其返回**必须填 `sourceRefs`**（否则违反反幻觉）；Executor 在运行时调用 `execute`。
- **最小示例**（见 `src/domains/demo/tools.ts`）：
  ```ts
  'fit.assess': {
    name: 'fit.assess',
    description: '取回用户体能评估数据（事实，必带来源）',
    inputSchema: zAssessInput,
    producesFacts: true,
    idempotent: true,
    timeoutMs: 5_000,
    retryable: true,
    stepType: 'assess',
    async execute(input, ctx) {
      const providers = createFitProviders().create(ctx);
      const r = await providers['fit.metrics'].search(input, ctx);
      return { ok: r.ok, data: r.data, sourceRefs: [r.source], isEstimate: r.isEstimate, durationMs: 0 };
    },
  },
  ```
- **常见错误**：`producesFacts=true` 却不返回 `sourceRefs`；工具里**直接硬编码事实**而不走 Provider（红线：模型/工具不得编造）；引用 `@mastra/*`（工具实现交给 RuntimeAdapter）。

### ③ providers —— 事实数据的唯一来源（反幻觉强制点）
- **必须提供**：`DomainProviders`：`namespace` + `create(ctx): Record<id, ProviderAdapter>`；可额外实现 `createValidator(ctx)` 返回 `ValidatingProvider`。
- **内核怎么用**：`createProviders(domainId, ctx)` 供工具取数；`createValidator` 结果进入校验闸门——**内核只消费 `ok` 与 `violations[].severity`**，`code/message/suggestion/evidence` 对内核不可见（类型上是 `unknown`，语义上禁止解析）。
- **最小示例**（校验型 Provider，见 `src/domains/demo/providers.ts`）：
  ```ts
  createValidator(_ctx): ValidatingProvider {
    return {
      id: 'fit.validator',
      validate(plan) {
        const violations = [];
        const total = plan.steps.reduce(/* 累加数值硬约束 */ 0, 0);
        if (total > 300) violations.push({ severity: 'error', message: '周总训练时长超过 300 分钟上限' });
        return { ok: !violations.some(v => v.severity === 'error'), violations };
      },
    };
  },
  ```
- **常见错误**：Provider 返回不带 `source`（每条事实必须可溯源）；校验型 Provider 把领域语义透传给内核（内核去读 `.code` 之类就破了"内核通用"）；`create` 不是函数。

### ④ ui —— 组件集 + 降级链 + stepRenderers
- **必须提供**：`DomainUIContribution`：`components`（每个含 `name`/`schema`(zod)/`requiredProps`/`modelCallable`/`lazy`）、`degradeChain`（四个兜底组件名）、`stepRenderers`（按 `step.type` 映射到组件 + 纯函数 `toProps`）。
- **内核怎么用**：渲染时用 `stepRenderers[type].toProps(result, step)` 把工具结果转成组件 props；`schema` 校验失败即降级到 `degradeChain.rawPayload`；`requiredProps` 未补齐则渲染骨架不报错。
- **最小示例**（见 `src/domains/demo/ui.ts`）：
  ```ts
  stepRenderers: {
    assess: { component: 'TrainingPlan', toProps(result, step) {
      const p = zAssessPayload.safeParse(result ?? {});
      return p.success ? { title: step.title, items: p.data.items } : { title: step.title, items: [] };
    } },
  },
  ```
- **常见错误**：`toProps` 不是纯函数（带副作用/随机）→ 无法重放与单测；组件未配 `schema` 或漏注册 → 校验失败直接降级；服务端代码 `import` 组件文件（会把 React 代码拖进服务端包体，见 §4）。

### ⑤ prompts —— 提示词片段
- **必须提供**：`DomainPrompts`：`worldview` / `constraints` / **`antiHallucination`（内核强制注入，缺则注册失败）** / `planning`。
- **内核怎么用**：组装给 Planner 的系统提示；`antiHallucination` 是硬插槽，内核一定会注入。
- **常见错误**：`antiHallucination` 写空串（zod `min(1)` 会令 prompts 段校验失败）；把事实编进提示词而不是让模型去问 Provider。

### ⑥ planning —— stepTypes 白名单 + 模板 + validateStep
- **必须提供**：`DomainPlanningContribution`：`stepTypes`（≥1 个）、`templates`（`StepDraft[]`）、`validateStep(step, ctx)`。
- **内核怎么用**：`stepTypes` 交给 Runtime 当白名单（`isAllowedStepType`）；`templates` 当规划素材；调 `validateStep` 后**只读 `ok` 与 `severity`**。
- **最小示例**（见 `src/domains/demo/planning.ts`）：
  ```ts
  stepTypes: [{ type: 'assess', label: '体能评估', description: '...', maxAttempts: 2 }],
  templates: [{ id: 'fit.basic', description: '评估→计划→排期→复盘', steps: [
    { id: 's-1', type: 'assess', title: '评估体能', dependsOn: [], intent: { toolName: 'fit.assess', input: {}, producesFacts: true } },
    // s-2 plan dependsOn ['s-1'] … 形成严格 DAG
  ] }],
  validateStep(step, _ctx) {
    const violations = [];
    if (!stepTypes.some(d => d.type === step.type)) violations.push({ severity: 'error', message: `未知步骤类型：${step.type}` });
    return { ok: !violations.some(v => v.severity === 'error'), violations };
  },
  ```
- **常见错误**：`stepTypes` 为空（zod `min(1)` 失败）；漏 `validateStep`（注册守卫会报"必须提供 validateStep"）；模板 `steps` 不是合法的 `StepDraft`。

### ⑦ evaluation —— 评测钩子
- **必须提供**：`DomainEvaluationContribution`：`cases`、`metricIds`，可选 `score(caseId, actual)`。
- **内核怎么用**：供 benchmark 与回归。不影响注册。
- **常见错误**：无（段本身宽松，但留空会让回归无据可依）。

### ⑧ lifecycle（可选）
- `init?` / `dispose?`：建连接池 / 预热缓存 / 释放资源。`pack.ts` 里直接写即可（见 demo `pack.ts`）。

---

## 3. 端到端分步清单（从空目录到跑通）

约定领域 id 为 `fit`（你的假想领域，见 §8）。下列每步都标注"验证这一步做对了"。

**步骤 1 · 建目录骨架**
```
src/domains/fit/{pack,meta,providers,tools,planning,prompts,evaluation,ui,register,register-ui}.ts
src/domains/fit/components/<Name>/{index.tsx,schema.ts}
```
验证：`find src/domains/fit -type f | sort` 列出全部文件；目录命名全小写中划线。

**步骤 2 · 写 `meta.ts` + `register.ts`**
`register.ts` 调用 `registerDomainPack(fitPack)`（此时 `fitPack` 可先引用占位，下一步逐步补全），失败时抛错。
验证：`npm run typecheck` 在 pack 组装完前会报缺段，这是预期；可先写最小可注册桩（见 §8）以便尽早验证。

**步骤 3 · 写 `tools.ts`**
每个工具带 zod `inputSchema`；`producesFacts=true` 的 `execute` 必须返回 `sourceRefs`。
验证：对该工具写一个 vitest，断言 `execute` 返回 `ok && sourceRefs.length > 0`（仅事实类工具）。

**步骤 4 · 写 `providers.ts`**
含 `createFitProviders()`：fixture 数据 + `search`/`detail` 带 `source`；并写 `createValidator`（数值/依赖硬约束）。
验证：vitest 调 `providers.create(ctx)['fit.metrics'].search(...)`，断言 `result.source` 存在；调 `validate(plan)` 构造一个超限 plan，断言 `ok === false` 且有一条 `severity:'error'`。

**步骤 5 · 写 `planning.ts`**
`stepTypes`（≥1）、`templates`（`steps` 为 `StepDraft[]`）、`validateStep`。
验证：vitest 传一个 `type` 不在白名单的 step，`validateStep` 返回 `ok === false`。

**步骤 6 · 写 `prompts.ts`**
四字段齐备，`antiHallucination` 非空。
验证：`npm run typecheck`（zod `min(1)` 会在缺字段时报错）。

**步骤 7 · 写 `evaluation.ts`**
`cases` + `metricIds`，必要时 `score`。
验证：无强制，留至少一个 smoke case。

**步骤 8 · 写 `ui.ts` + `components/*/schema.ts`**
`components` 每项带 `schema`（zod）、`requiredProps`；`stepRenderers` 的 `toProps` 必须是纯函数。
验证：vitest 对 `toProps` 做"同入参→同出参"断言，并测 `safeParse` 失败时的降级返回值。

**步骤 9 · 写 `register-ui.ts`**（`'use client'`）
`registerFitUIComponents()` 调 `registerDomainComponents('fit', [{ name, schema, requiredProps, modelCallable, lazy, load: () => import('./components/...') }])`。
验证：`npm run lint` 确认 `'use client'` 文件未被服务端引用。

**步骤 10 · 写 `pack.ts`**
组装 `fitPack: DomainPack`，`lifecycle` 可选。
验证：`npm run typecheck` 全绿（8 段类型对齐）。

**步骤 11 · 接线两个桶文件**（见 §4）。
验证：见 §4 末尾命令。

**步骤 12 · 跑通验证**
```
npm run typecheck && npm run lint && npm test
# 端到端跑一个 run（需先 npm run build && npm start）
curl -N -X POST http://localhost:3000/api/run \
  -H 'Content-Type: application/json' \
  -d '{"goal":"帮我制定一周增肌训练计划，周总时长不超过 300 分钟","domainId":"fit","simulate":"none"}'
```
验证：SSE 流里出现 `plan` 事件且该领域 step.type 命中白名单；`npm test` 中闭环用例通过。

---

## 4. 注册与接线：两个桶文件各加一行

新增领域只改**两个桶文件**，引用点数量不变（这是"反向剥离"的落点）。

**服务端桶 `src/domains/index.ts`** 加一行（并被 `app/api/run/route.ts` 通过 `@/src/domains` 引用）：
```ts
import { registerFitDomain } from './fit/register';
export function registerAllDomains(): string[] {
  return [registerDemoDomain(), registerFitDomain()];
}
```

**客户端桶 `src/domains/ui.ts`**（`'use client'`，被 `app/page.tsx` 通过 `@/src/domains/ui` 引用）加两行：
```ts
import { registerFitUIComponents } from './fit/register-ui';
import { fitDomainId } from './fit/register';
export function registerAllUI(): void {
  registerCoreUIComponents();
  registerDemoUIComponents();
  registerFitUIComponents();   // 新增
}
export const defaultDomainId = fitDomainId;  // 或保留 demo，取决于默认领域
```

**为什么必须拆成两个**：`registerAllUI` 触及 `'use client'` 的 React 组件（懒加载入口 `load: () => import(...)`）。若把它并回 `src/domains/index.ts`，服务端 `route.ts` 间接 import 该桶文件时，会把组件代码拖进**服务端模块图**，破坏"服务端不携带组件代码"的纪律，并可能触发 RSC 边界错误。因此：服务端只认 `index.ts`（`registerAllDomains`），客户端只认 `ui.ts`（`registerAllUI`），两者不可合并。

验证接线：`npm run build` 通过；`grep -rn "registerFit" src/domains/index.ts src/domains/ui.ts` 各命中新增行；`npm test` 闭环用例仍绿。

---

## 5. 领域包内的纪律

1. **进度硬限**：依赖重规划的"三重闸门"（次数 ≤5 / 单轮成本 ≤¥2 / 单轮时长 ≤25s）由内核管，领域包不要在工具里自行重试到天荒地老；`maxAttempts` 默认 2。
2. **禁硬编码模型名**：领域包不持有任何 LLM 调用，模型名只在 RuntimeAdapter；工具里只写 IO 与 zod 校验。
3. **事实必须带 SourceRef**：凡 `producesFacts=true` 的工具返回，必须把 Provider 给的 `source` 放进 `sourceRefs`；UI 必须展示 `isEstimate` 与 `disclaimer`。
4. **UI 组件必须配 zod schema 并注册**：`schema.ts` 导出 `z<Name>Props`，`register-ui.ts` 用 `load: () => import(...)` 注册；漏注册会在渲染时降级到 `RawPayloadCard`。
5. **服务端不 import 组件代码**：组件与 `load` 只在 `register-ui.ts`（`'use client'`）里出现；`pack.ts`/`register.ts`/`providers.ts`/`tools.ts`/`planning.ts` 等纯逻辑文件不得 `import` `.tsx`。
6. **不得引用其他领域包**，也不得在 `core/` 里 `import domains/`。

---

## 6. 反模式清单

| # | ❌ 坏做法 | ✅ 好做法 | 后果 |
|---|---|---|---|
| 1 | 工具里硬编码数值/条目当事实 | 工具只调 Provider，返回带 `sourceRefs` | 违反反幻觉，模型编造 |
| 2 | 校验型 Provider 把 `.code` 透传给内核 | 内核只认 `ok` + `severity` | 内核沾染领域语义，破坏通用性 |
| 3 | 把 `registerAllUI` 合并进 `index.ts` | 两个桶文件分开 | 组件被拖进服务端包体，RSC 报错 |
| 4 | `producesFacts=true` 但不填 `sourceRefs` | 事实必有 SourceRef | 注册/渲染阶段溯源失败 |
| 5 | `toProps` 内含随机/副作用 | `toProps` 为纯函数 | 无法重放、单测不稳 |
| 6 | 组件未配 zod `schema` 或未注册 | 每个组件配 `schema` 并 `registerDomainComponents` | 校验失败直接降级，白屏风险 |
| 7 | `prompts.antiHallucination` 写空 | 写明确"无来源不输出" | prompts 段注册失败 |
| 8 | 领域包 `import` 其他领域包 | 领域包彼此零依赖 | 牵一发动全身，剥离失败 |
| 9 | 在 `src/core`、`shared/` 写领域词 | 领域词只存在于 `src/domains/<id>` | 内核不再领域无关，自检红 |
| 10 | 漏写某段（如忘 `evaluation`） | 7 段必填齐全 + `lifecycle` 可选 | `registerDomainPack` 返回 `missing`，注册失败 |

---

## 7. 验收：怎么证明"内核零改动"

1. **核心证据（必须 0）**：
   ```bash
   git diff --numstat m1-core-only..HEAD -- src/core shared | wc -l
   ```
   > 路径是仓库根的 `shared/`，**不是** `src/shared`（`shared` 在仓库根，不在 `src/` 下）。命令的正确形态就是 `-- src/core shared`。**为什么这个笔误危险**：自检命令 `grep -rnE "<领域词>" src/core src/shared` 一旦把 `shared` 误写成 `src/shared`，grep 只会在 stderr 悄悄报个错，却仍然把 `src/core` 的结果正常返回——表面是 `0` 通过，实际整段 `shared/` 的"内核无领域词"检查被**静默跳过**，架构守卫就此失效。所以永远写成 `shared`。当前 HEAD 即 `dc9248c`，新增领域后应仍为 0。

2. **内核无领域词（必须 0）**：
   ```bash
   grep -rnE "fit|健身|训练" src/core shared | wc -l   # → 0
   ```

3. **内核不读领域语义（必须 0）**：
   ```bash
   grep -rn "\.code\|\.evidence\|\.suggestion\|\.message" src/core | wc -l   # → 0
   ```

4. **反向剥离检查**：删掉你的领域包，内核仍能构建通过——证明它是"可插拔"而非"已耦合"。
   ```bash
   rm -rf src/domains/fit && npm run build   # → 通过
   git checkout -- src/domains/fit           # 恢复
   ```
   等价地，`rm -rf` 后 `npm test` 的闭环用例（若仅依赖 demo）仍应通过。

5. **完整自检**（提交前五项全绿）：`npm run typecheck && npm run lint && npm test` + 上述 1–4。

---

## 8. 假想领域完整走查：`fit`（健身训练周计划）

选 `fit` 是因为它与 demo 形状**不同**：demo 是"两路并行采集 + 汇总"、无数值硬约束；`fit` 是**严格顺序 DAG**（评估→计划→排期→复盘，无 `parallelGroup`）+ **数值硬约束**（周总时长 ≤ 上限、单节 ≤ 90 分钟），更贴近"带硬依赖 DAG 或数值硬约束"的领域。

> 以下为骨架，类型对齐 `shared/domain/types.ts`，文件名与 demo 完全一致。

**meta.ts**
```ts
export const fitMeta: DomainMeta = {
  id: 'fit', displayName: '健身训练周计划', version: '0.1.0', schemaVersion: 1,
  description: '把体能目标拆成一周训练排期，带时长硬约束',
  matcher: { keywords: ['健身','训练','增肌'], patterns: [], negativeKeywords: [], scoreBySignals: { text: 1 } },
  requiredSignals: ['text'],
  capabilities: { vision: false, geo: false, providers: true, timeSequence: true },
};
```

**providers.ts（含校验型 Provider 兜数值硬约束）**
```ts
export function createFitProviders(): DomainProviders {
  return {
    namespace: 'fit.metrics',
    create(_ctx) {
      const metrics: ProviderAdapter = {
        id: 'fit.metrics',
        async search(q, _c) {
          return { ok: true, data: [{ id: 'm1', label: '静息心率', value: '62', source: { providerId: 'fit.metrics', namespace: 'fit.metrics', uri: 'fit://metrics/m1', label: '体能评估', retrievedAt: new Date().toISOString(), isEstimate: true } }], source: { providerId: 'fit.metrics', namespace: 'fit.metrics', uri: 'fit://metrics', label: '体能评估', retrievedAt: new Date().toISOString(), isEstimate: true }, isEstimate: true, durationMs: 0 };
        },
      };
      return { 'fit.metrics': metrics };
    },
    createValidator(_ctx): ValidatingProvider {
      return { id: 'fit.validator', validate(plan) {
        const violations = [];
        // StepCostEstimate 的真实字段：durationMs（毫秒）、costCNY（元）、confidence（0~1）
        const totalMs = plan.steps.reduce((s, st) => s + (st.estimate?.durationMs ?? 0), 0);
        const totalYuan = plan.steps.reduce((s, st) => s + (st.estimate?.costCNY ?? 0), 0); // 单位：元（¥）
        const last = plan.steps[plan.steps.length - 1];
        if (totalMs > 300 * 60 * 1000) violations.push({ severity: 'error', message: '周总训练时长超过 300 分钟上限' });
        if (totalYuan > 2) violations.push({ severity: 'error', message: '周总成本超过 ¥2（元）—— 三重闸门·成本上限' }); // maxCostCNY 默认 2（元）
        if ((last?.estimate?.confidence ?? 1) < 0.8) violations.push({ severity: 'warning', message: '末步置信度偏低' });
        return { ok: !violations.some(v => v.severity === 'error'), violations };
      } };
    },
  };
}
```

**planning.ts（严格顺序 DAG，无 parallelGroup）**
```ts
export const fitPlanning: DomainPlanningContribution = {
  stepTypes: [
    { type: 'assess', label: '体能评估', maxAttempts: 2 },
    { type: 'plan', label: '生成计划', maxAttempts: 2 },
    { type: 'schedule', label: '排期', maxAttempts: 2 },
    { type: 'review', label: '复盘', maxAttempts: 2 },
  ],
  templates: [{ id: 'fit.basic', description: '评估→计划→排期→复盘', steps: [
    { id: 's-1', type: 'assess', title: '评估体能', dependsOn: [], intent: { toolName: 'fit.assess', input: {}, producesFacts: true } },
    { id: 's-2', type: 'plan', title: '生成训练计划', dependsOn: ['s-1'], intent: { toolName: 'fit.plan', input: {}, producesFacts: false } },
    { id: 's-3', type: 'schedule', title: '排期到一周', dependsOn: ['s-2'], intent: { toolName: 'fit.schedule', input: {}, producesFacts: false } },
    { id: 's-4', type: 'review', title: '周复盘', dependsOn: ['s-3'], intent: { toolName: 'fit.review', input: {}, producesFacts: false } },
  ] }],
  validateStep(step, _ctx) {
    const violations = [];
    if (!fitPlanning.stepTypes.some(d => d.type === step.type)) violations.push({ severity: 'error', message: `未知步骤类型：${step.type}` });
    return { ok: !violations.some(v => v.severity === 'error'), violations };
  },
};
```

**tools.ts / prompts.ts / evaluation.ts / ui.ts / components / register.ts / register-ui.ts / pack.ts**
按 §2 各段形状复制 demo 同名文件，把 `demo*` 改名 `fit*`、把 fixture 换成你的数据、`stepRenderers` 映射到你的组件即可。`pack.ts` 用 `lifecycle` 可选字段收尾。

**接线**：回到 §4 在两个桶文件各加一行（`registerFitDomain` / `registerFitUIComponents` / `fitDomainId`）。

**走查验证（对照 §3 / §7）**：
- `npm run typecheck` 全绿 → 8 段类型对齐。
- vitest：构造一个 `estimate.durationMs` 累加超过 300 分钟（或 `estimate.costCNY` 累加 >2 元）的 plan，喂 `createFitProviders().createValidator().validate(plan)` → `ok===false` 且有一条 `severity==='error'`（数值硬约束生效，且内核只读 `severity`）。
- 防御性细节（增强真实感）：内核 `engine.ts:344` 在 Step 没填 `estimate` 时会按 **0.01 元**兜底累加成本，说明三重闸门的成本维度对"领域忘了报价"也有防御，不靠领域自觉。
- `curl` 跑一次 run，`domainId:'fit'` → SSE 出现 4 个顺序 step、`type` 命中 `assess/plan/schedule/review` 白名单。
- `git diff --numstat m1-core-only..HEAD -- src/core shared | wc -l` → 0；`rm -rf src/domains/fit && npm run build` → 通过（可剥离）。

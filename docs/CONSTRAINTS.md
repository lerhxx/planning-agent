# planning-agent · Vibe Coding 约束文档

> **用法**：把「第二部分」整块复制到项目根的 `CLAUDE.md`、`.cursorrules`、`AGENTS.md`（三份内容一致，工具入口不同）。
> 第一部分是方法论（给**你**看的），第二部分是规则（给 **AI** 看的）。

---

# 第一部分 · 方法论

## 1. 为什么 vibe coding 必须先写约束文档

AI 编码工具的默认行为是**按最常见写法生成代码**。它不知道你的项目约定，于是每次都按"大众默认"猜——猜对了是运气，猜错了你就会在几十处不一致的代码里做人工收口。

约束文档的本质是：**把你的架构决策提前写成 AI 每次都能读到的硬规则**，把"猜"变成"查表"。

| 没有约束文档 | 有约束文档 |
|---|---|
| 每次生成风格不同 | 风格一致 |
| 架构边界被悄悄穿透 | 边界有显式红线 |
| 你在 review 时发现架构错了 | 它在生成时就按规则走 |
| 越写越难改 | 越写越稳 |

## 2. 约束文档的 5 层结构

| 层 | 管什么 | 为什么必须写 |
|---|---|---|
| **L1 技术栈锁定** | 用什么、不换什么 | 防 AI 引入它更熟悉的库 |
| **L2 目录与命名** | 文件放哪、叫什么 | 防目录漂移与重复实现 |
| **L3 代码风格与模式** | 怎么写、用哪种模式 | 防同一件事有 N 种写法 |
| **L4 接口契约** | 数据结构的唯一真源 | 防前后端/跨模块类型不一致 |
| **L5 禁止事项** | 红线 | 防 AI 走捷径毁掉架构 |

## 3. 每条约束的写法公式

> **坏规则**："注意代码质量，保持架构清晰。"
> **好规则**：一句话禁令 + 后果 + 坏例子 + 好例子 + 可验证判据。

示例：

| 抽象要求 | ❌ 坏写法 | ✅ 好写法 |
|---|---|---|
| 内核要通用 | "内核不要耦合业务" | "`grep -rnE \"<领域词>\" src/core shared` 输出必须为空；`rm -rf src/domains/<x> && npm run build` 必须通过。判据：CI 跑该命令。" |
| 模型输出不可信 | "注意校验模型输出" | "所有来自模型/网络的 JSON 必须过 `schema.safeParse`，失败降级为 `RawPayloadCard`，绝不白屏。" |
| 事实不能编造 | "价格要让模型小心" | "`producesFacts: true` 的工具，其返回必须带 `source: SourceRef`；模型输出的事实字段一律丢弃。" |

**判据是关键**：能自动验证的约束才是真约束。写不出判据的约束，等于没写。

---

# 第二部分 · 本项目规则模板（复制到 `CLAUDE.md` / `.cursorrules` / `AGENTS.md`）

```markdown
# planning-agent · Vibe Coding 全局规则

## L1 技术栈锁定（不可自行更换）

- 框架：Next.js 16.3.3（App Router）+ React 19 + TypeScript strict
- 编排执行层：Mastra `@mastra/core@~1.67`（锁 `~`，禁止 `^`）
- 流式与模型抽象：Vercel AI SDK UI（`createUIMessageStream` + `@ai-sdk/react` 的 `useChat`）
- 校验：zod **4.1.8**（禁止 zod 3 写法）
- 状态：`useChat`（消息流）+ Zustand（UI/上传/偏好）+ `nodeReducer`（patch 累积）
- 测试：Vitest + Playwright
- 部署：Vercel 主 + Cloudflare OpenNext 镜像

★ 定位澄清：Mastra 是**执行层**（跑工具/记忆/评测），**不是规划层**。
  Planner / Replanner / Scheduler / PlanCompiler 全部自研在 `src/core/`，不得塞进 Mastra。

⛔ 不进 MVP：
  - `ai/rsc` 与 `streamUI`（官方标注 experimental、不建议用于生产）
  - Mastra Dynamic Workflows（≥1.58.0）—— 需额外 storage，威胁 Cloudflare 镜像方案
  - 任何 durable execution 引擎（Inngest / Temporal / Restate / DBOS）

## L2 目录与命名

src/core/**      领域无关层（goal / planning / execution / replan / compiler / degrade / registry / runtime）
src/domains/**   领域包，每个域一个目录
src/components/generative-ui/**   通用组件注册表 + 兜底组件
shared/**        zod schema → z.infer，前后端唯一真源
app/api/**       服务端代码唯一入口（Route Handler）

硬纪律：
  1. `src/core/**` 与 `shared/**` 中**禁止出现任何领域词**（领域名、领域概念、领域字段名）
  2. 删除任一 `src/domains/*` 目录后，`npm run build` 必须通过
  3. 页面与组件一律 `'use client'`；服务端代码只在 `app/api/**` 与 `src/core/runtime/mastra/**`
  4. **禁用 Server Actions**（除非另行评审）

命名：文件 kebab-case，组件 PascalCase，zod schema 一律 `zXxx` 且类型用 `z.infer` 推导。

## L3 代码风格与模式

- **类型唯一真源**：先写 zod schema，再用 `z.infer` 推导 TS 类型。禁止手写两份。
- **PlanCompiler 必须是纯函数**：`Plan → ExecutionGraph(IR) → 运行时图`，无副作用、可单测、含依赖环检测。
  ⛔ 不得放在 `src/core/runtime/mastra/**` 里（否则换框架要重写、Mock 无法复用）。
- **Step id 稳定性**：已完成 step 的 id 在重规划后**不变**（天然幂等键）。
- **重规划三重闸门**：次数 ≤5 / 成本 ≤¥2 / 时长 ≤90s。
- **收敛判定**：新旧计划 delta < 0.15 判定为原地打转，**强制转人工**。
- **三线降级**：`RawPayloadCard → ClarifyOptions → ErrorState`，逻辑集中在 `ComponentRenderer`，与传输层解耦。
- **流式增量**用 RFC 6902 JSON Patch，列表追加用 `{"op":"add","path":"/items/-","value":{...}}`，禁止整包重发 props。
- **已完成步骤默认冻结**：改动需显式 `rollback_to_step`。
- 每个新模块必须带单测；纯函数必须有单测。

## L4 接口契约（唯一真源，改这里必须同步改 PRD.md）

- `DomainPack`：共 8 段（meta / tools / providers / ui / prompts / planning / evaluation / lifecycle），**其中 7 段必填、`lifecycle` 可选** —— 必填集合见 `shared/domain/types.ts` 的 `REQUIRED_DOMAIN_PACK_SEGMENTS`，缺一段则 `registerDomainPack` 注册失败
- `Plan` / `Step` / `Goal`：字段定义见 `docs/PRD.md` §8，此处不复制
- `ProviderAdapter.search()` 返回 `ProviderResult<T>`，**必须带 `source: SourceRef`**
- `ValidatingProvider.validate()` 返回 `{ ok, violations[] }`
- 组件契约：`{ type, props, status, nodeId }`，props 全程可缺失（未补齐渲染骨架，不报错）

## L5 禁止事项（红线）

### L5-A 工程红线

1. NEVER 用 `ai/rsc` 或 `streamUI` 承载生成式 UI
2. NEVER 在业务代码里 `import '@mastra/*'`（只允许 `src/core/runtime/mastra/**` 内部引用）
3. NEVER 硬编码 provider 模型字符串（必须走 `models.ts`）
4. NEVER 让模型产出价格 / 评分 / 营业时间 / 数值事实（只能来自 Provider）
5. NEVER 跳过 `safeParse` 直接消费模型或网络返回的 JSON
6. NEVER 让 UI 白屏（任何失败都要落到三个兜底组件之一）
7. NEVER 用 Server Actions
8. NEVER 在组件里直接 fetch 大模型 API

### L5-B 内核 / 领域包红线（★ 本项目命根子）

9.  NEVER 在 `src/core/**` 或 `shared/**` 中出现领域词
10. NEVER 在内核中解析 `violations[].code` / `.message` / `.suggestion` / `.evidence`
11. NEVER 对 `violations[].code` 做 `switch` / `if` 分支
12. NEVER 用领域专有错误码（触发码必须是内核通用码 `PROVIDER_VALIDATION_FAILED`）
13. NEVER 让内核读取领域自由挂载点 `RunContext.meta`（`Record<string, unknown>`，设计稿里称 `domainExtras`；只在写入侧 parse、读取侧由域组件校验）
14. NEVER 把 PlanCompiler 放进 runtime 目录，或让它产生副作用
15. NEVER 让内核依赖具体 Runtime 实现（只依赖 `RuntimeAdapter` 接口）
16. NEVER 在重规划时改变已完成 step 的 id
17. NEVER 跳过三重闸门（次数 / 成本 / 时长）
18. NEVER 让重规划无限循环（必须有收敛判定）
19. NEVER 让领域包跨域引用（域之间零依赖）

## 每次改动后必须自检（并贴出结果）

npm run typecheck && npm run lint && npm test
grep -rnE "<领域词>" src/core shared | wc -l        # 必须为 0
grep -rn "\.code\|\.evidence\|\.suggestion" src/core | wc -l   # 必须为 0
rm -rf src/domains/<x> && npm run build                  # 必须通过
```

---

# 第三部分 · 分层规则文件

全局规则放根目录，目录级规则放各自目录，AI 会同时读到。

| 文件 | 管什么 |
|---|---|
| `/CLAUDE.md` `/AGENTS.md` `/.cursorrules` | 上面第二部分（四层纪律 + 红线） |
| `src/core/.cursorrules` | 禁领域词、禁解析 violations details、PlanCompiler 纯函数、只依赖 `RuntimeAdapter` |
| `src/domains/*/.cursorrules` | 7 段必填齐全（`lifecycle` 可选）、`producesFacts` 必带 `SourceRef`、禁跨域引用、禁 `@mastra/*` |
| `src/core/runtime/mastra/.cursorrules` | tool 必须带 zod `inputSchema`、模型名走 `models.ts`、禁 Dynamic Workflows |
| `src/components/generative-ui/.cursorrules` | 必须注册进注册表、必须有 zod schema、三个兜底组件为通用实现 |

---

# 第四部分 · Do's & Don'ts

## Do's

1. 先写 zod schema，再 `z.infer` 推导类型
2. 纯函数优先（Planner、PlanCompiler、`toProps` 都应是纯函数）
3. 每个领域能力都通过 `DomainPack` 的 8 段暴露，不散落在各处
4. 事实数据一律带 `SourceRef`，mock 数据标记 `isEstimate` 并显示免责声明
5. 每个 step 都可独立重试（`idempotencyKey`）
6. 计划状态变化都走显式命令，不直接改状态
7. 失败路径优先写（先想清楚怎么失败，再写成功路径）
8. 重规划只动受影响子树
9. 埋点保留业务指标（`first_component_ms` / `component_degraded` / `cost_per_turn`）
10. 新增领域后立刻跑 `git diff` 验证内核零改动

## Don'ts

1. 别在内核里写领域名
2. 别让内核读 `violations` 的领域字段
3. 别用 `streamUI`
4. 别在业务代码 import `@mastra/*`
5. 别硬编码模型名
6. 别让模型编造事实
7. 别跳过 `safeParse`
8. 别整包重发组件 props（用 JSON Patch）
9. 别让重规划改已完成 step 的 id
10. 别在没有收敛判定的情况下重规划
11. 别让 UI 出现白屏
12. 别用 Server Actions
13. 别在 `core/` 里 import `domains/`
14. 别让领域包互相依赖
15. 别省略单测（尤其纯函数）
16. 别把编译逻辑写进 runtime 目录
17. 别为了"方便"在内核加领域特判

---

# 第五部分 · Prompt 片段库

## 5.1 新增一个生成式 UI 组件

```
在 src/components/generative-ui/<Name>/ 下新增组件 <Name>。
要求：
1. 同目录必须有 schema.ts（zod 4）导出 z<Name>Props，类型用 z.infer 推导
2. 同目录必须有 index.tsx，props 全程可缺失（未补齐渲染骨架，不报错）
3. 必须在注册表中注册，标注 modelCallable
4. 必须提供 React.lazy 懒加载入口
5. 必须写单测：props 缺失时不崩、schema 校验失败时降级
6. 不得在组件内发请求；交互通过 ComponentAction 回灌对话
```

## 5.2 新增一个 Domain Pack

```
在 src/domains/<id>/ 下新增领域包 <id>。
必须提供 DomainPack 的 **7 段必填**：meta / tools / providers / ui / prompts / planning / evaluation（`lifecycle` 是第 8 段，可选）。缺任一段则注册失败。
硬要求：
1. tools 的每项必须带 zod inputSchema；producesFacts=true 的必须返回 SourceRef
2. providers 必须实现 ProviderAdapter，返回值带 source；可选实现 createValidator
3. ui 必须给出 degradeChain 四个兜底组件名与 stepRenderers 映射（**degradeChain 是服务端概念**，前端恒用 `CORE_DEGRADE_CHAIN`，写 `CORE_DEGRADE_CHAIN` 即可）
4. prompts 必须包含 antiHallucination 插槽
5. planning 必须给出 stepTypes 白名单与 validateStep
6. 不得引用任何 @mastra/*（工具实现交给 RuntimeAdapter）
7. 不得引用其他领域包
8. 完成后必须验证：
   - grep 领域词 src/core shared → 0 命中
   - rm -rf src/domains/<id> && npm run build → 通过
   - git diff --numstat <core-tag>..HEAD -- src/core/** shared/** | wc -l → 0                                    # 文件数
   - git diff --numstat <core-tag>..HEAD -- src/core/** shared/** | awk '{a+=$1;d+=$2} END{print a+d+0}' → 0    # 增删行数
```

## 5.3 新增一个流式事件（data part）

```
新增 AI SDK 自定义 data part：<name>。
必须同步改动 4 处，缺一不可：
1. shared/ 的 zod schema（唯一真源）
2. 服务端 writer.write({ type: 'data-<name>', id, data })
3. 前端 nodeReducer 的 patch 累积分支
4. 组件注册表中对应的组件 + zod schema
```

## 5.4 新增一个重规划策略

```
在 src/core/replan/ 新增策略 <name>。
必须：
1. 在策略表中登记触发条件
2. 明确影响面（单步 / 下游子树 / 全量）
3. 保留已完成 step id
4. 纳入三重闸门（次数 ≤5 / 成本 ≤¥2 / 时长 ≤90s）
5. 纳入收敛判定（delta < 0.15 强制转人工）
6. 带单测
```

---

# 第六部分 · 自检清单

每次提交前跑完并贴出结果：

```bash
npm run typecheck && npm run lint && npm test

# 1. 内核无领域词
grep -rnE "<领域词>" src/core shared | wc -l                 # → 0

# 2. 内核不读领域语义
grep -rn "\.code\|\.evidence\|\.suggestion" src/core | wc -l      # → 0

# 3. 领域可剥离
rm -rf src/domains/<x> && npm run build                          # → 通过

# 4. PlanCompiler 单测覆盖
npm test -- src/core/compiler

# 5. 可扩展性证据（`--numstat` 每个文件输出一行，故 `wc -l` = 文件数；行数要用 awk 累加）
git diff --numstat <core-tag>..HEAD -- src/core/** shared/** | wc -l                          # → 0（文件数）
git diff --numstat <core-tag>..HEAD -- src/core/** shared/** | awk '{a+=$1;d+=$2} END{print a+d+0}'   # → 0（增删行数）
```

> 两种口径都要报：M2 两者皆 0 所以结论一致，但 N > 0 时只报 `wc -l` 会把文件数当行数讲出去（见 `docs/PRD.md` §12.2）。

**五项全绿才算"这次改动没有破坏架构"。** 任何一项红了就修，不要带着红灯继续写。

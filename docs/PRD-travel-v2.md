# PRD · travel 领域 v2（图片驱动的行程规划）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（草稿，待项目所有者裁决 §9 后转 v1.0） |
| 范围 | **仅 travel 领域包**（含它不得不推动的内核/前端改动）。不含第二个领域（M3 装修）的设计 |
| 读者 | 架构 / 实现（vibe coding）、项目所有者（决策） |
| 依据 | commit **`12fd497`** / tag **`m2-travel-only`**；本文所有行号锚定于此 |
| 性质 | 这是一份**带判断**的 PRD：能装进现有契约的写"怎么装"，装不进去的写"为什么装不进去、要改哪、代价多大"。不含糊 |
| 状态约束 | 本文**不修改任何源码、不修改任何现有文档**；只新增本文件 |

---

## 0. 判定口径：三类改动，代价不同

本文反复要问"这要不要动内核"，先把**代价分级**定义清楚（承 `docs/PRD.md` §12.2 的硬判据：`git diff --numstat m1-core-only..HEAD -- src/core shared | wc -l` = **文件数**，同口径 `| awk '{a+=$1;d+=$2} END{print a+d+0}'` = **增删行数**；两种口径都要记账）：

| 级别 | 落点 | 是否在硬指标 pathspec 内 | 性质 |
|---|---|---|---|
| **L-A · 领域内生** | `src/domains/travel/**` | ❌ 否 | 完全无代价，随便做 |
| **L-B · 前端外壳** | `app/**`、`src/features/**`、`src/components/generative-ui/**` | ❌ 否（pathspec 只含 `src/core` 与 `shared`） | **数值上不算破 0**，但它是共享管道，必须保持领域无关；把领域知识写进这里是"指标作弊式的满足" |
| **L-C · 契约 / 内核** | `shared/**`、`src/core/**` | ✅ 是 | **破一次 0**。按 `techDocs/v2/03-架构设计-v2.md:738` 的要求做：把新需求**下沉成通用槽位**（不是领域分支），改完立刻重打基线 |

> ★ 我刻意把 L-B 单独拎出来，因为 §3.1 的几条"绕法"正是靠它让指标保持 0。**它们是能跑通的，但它们是错的。** 下面逐条说明为什么。

### ★ 契约补齐的清单与分批（★ 已拍板：**本轮只做第 1、2 项；2' 与第 3 项留后续**）

| # | 补齐项 | 形状 | 谁在等它 | **本轮做不做** |
|---|---|---|---|---|
| 1 | **输入通道**：`zRunRequest` 无附件位 + `engine.ts:262` 写死 `['text']` | 新增通用槽位 `zAttachment` | travel v2（§3.1） | ✅ **本轮** |
| 2 | **通用澄清表单能力**：澄清只能表达扁平选项，承载不了多字段自由输入 | 扩 `zClarifyQuestion.fields`（§3.5） | travel v2（主交互路径之一） | ✅ **本轮**（★ 有意例外，见 §3.5） |
| 2' | **warning 可见性**：SSE 事件流**没有任何**违规 / 告警通道 | 新增事件（或给 `step_status` 挂通用 payload） | **M2 遗留债 `FACTS_DROPPED`** + travel v2 的 `IMAGE_UNRESOLVED` | ⏸ **本轮不做**（§3.2 已按"warning 无出口"改判为 error 绕开） |
| 3 | **度量修正**：`stepSignature` 不含顺序 → 交换步骤顺序 delta=0 | 改 `shared/plan/types.ts:335` | M3-A（装修） | ⏸ **后续（M3 那一轮）** |

> **★ 排期已拍板**：**travel v2 先交付，本轮单独破一次 0；M3（装修）随后再破第二次**（推翻初稿"并入 M3 只破一次"的建议）。完整口径与硬闸门见 §3.1 末。
> 第 2' 项本轮不做，但不构成正确性遗留：§3.2 已把所有"必须被看见"的约束改挂到 error 与澄清（两者都有 UI 出口），warning 通道只影响"未来能否降级"。
> 第 2' 项是 M2 遗留债 —— `FACTS_DROPPED`（`providers.ts:718-725`）从落地那天起就"没有出口"，travel v2 只是第二个需求方。

---

## 1. 一句话定位

> **v2 之前的 travel**：用户给一句自然语言目标 → 三路并行检索候选 → 按天编排。输入只有文本。
> **v2 的 travel**：**首屏就是一个对话框** —— 用户在对话中**边说边传图**（建筑 / 景点 / 美食…），图片是主要输入 → Agent 先"看懂每张图"并把这种理解当作**必须可溯源的事实** → 编排一份**必须覆盖全部图片**的行程（可适当用 Provider 数据填充），用户可用 `@图片名 + 文本`给图片加说明，行程以**动态卡片 + markdown** 呈现，需要澄清时**在对话流里就地长出内联表单气泡**。

一句话：**输入从"一句话"变成"一批图 + 说明文本"，而"每条数据都不能假、每一处不知道都必须说出口"这条底线不变。**

---

## 2. 用户故事

| ID | 作为… | 我希望… | 以便… |
|---|---|---|---|
| US-1 ★改写 | 用户 | **在对话框里边说边传**：一边打目标，一边把 10 张照片拖进对话（不是先到一个上传页传完再回来描述） | 我的表达方式和素材是同一句话里的事，不用被拆成两个阶段 |
| US-2 | 用户 | 看到"每张图被识别成什么"的清单，且每条都能点开看来源 | 识别错了我能立刻发现，而不是基于错识别走完行程 |
| US-3 | 用户 | 用 `@外滩.jpg` 这种写法给某张图写说明（"这里想拍夜景"），文字与该图绑定 | 我的意图落实到具体素材，而不是被当成一段无关的备注 |
| US-4 | 用户 | 生成的行程明确告诉我：哪些条目来自我的图、哪些是系统填充的推荐 | 我能自己判断哪些是可信的、哪些仅供参考 |
| US-5 | 用户 | 行程若漏了某张图，界面会**明确报警**，而不是静悄悄略过 | 我不拿到一份"看起来完整其实缺了内容"的方案 |
| US-6 | 用户 | 信息不足时（如不知道我想几天、预算多少）界面**流式长出表单**让我填 | 我不用在一开始就想清楚所有约束 |
| US-7 | 用户 | 结果用结构化卡片（按天 / 时段 / 花费 / 来源）+ 叙述性 markdown（贴士、说明）展示 | 关键数据可核对，同时有可读的行程说明 |
| US-8 | 用户 | 改其中一天 / 替换一张图后继续跑，已完成步骤不重跑 | 局部调整不浪费已经产出的成果 |
| US-9 | 用户 | 有图识别不出来时，**我可以选择跳过它**并继续出方案，而不是被彻底卡死；但行程上必须写明"覆盖 8/10（2 张我跳过了）" | 系统不替我决定，也不让我无路可走，且我事后还能一眼看出方案不完整在哪 |

---

## 3. ★ 八个硬问题

### 3.1 Q1 · 图片字节怎么进内核？

**结论（一句话）：这是真的内核缺口。** 现有契约里**没有任何一处**能合法承载图片字节或图片引用；三条"零改动的绕法"技术上都能跑通，但都是把领域知识搬进客户端/污染已有字段，属于自欺。正确做法是把"附件输入"下沉成 `shared/**` 的一个**无领域词的通用槽位**，并把这个改动**并入 M3 已经注定要破一次 0 的那一批**。

**证据（逐条可查）**

| 事实 | 位置 |
|---|---|
| `zRunRequest` 字段全集 = `goal / domainId / simulate / replanMode / requireConstraints / answers / plan / edit`，**没有文件或字节承载位** | `shared/run/types.ts:39-62` |
| `RunContext` 有 `signals: string[]` 与自由挂载点 `meta: Record<string, unknown>` | `shared/run/types.ts:22-24` |
| 引擎写死 `signals: ['text']` | `src/core/run/engine.ts:262` |
| `RunContext.meta` 只塞 `simulate` 与 `answers` 两个键，**请求里的其它字段一概不过桥** | `src/core/run/engine.ts:263` |
| `requiredSignals` 在 `src/core/**` **零消费**（Grep 全仓：`src/core` 内仅在 `domainRegistry.test.ts:44` 的假数据里出现） | `src/domains/travel/meta.ts:28`；`shared/domain/types.ts:69` |
| 领域路由靠 `input.domainId ?? listDomainIds()[0]` | `src/core/run/engine.ts:159` |
| 规划侧：`zPlanRequest` 只有 `goal / stepTypes / templates / signals / revision` | `src/core/runtime/adapter.ts:30-37` |
| MockRuntime 的规划只回放 `templates[0]`，**只注入 `goalSummary`，不读 ctx** | `src/core/runtime/mock/script.ts:88-100` |
| 工具侧却能拿到完整 `RunContext`（`execute(input, ctx)`） | `src/domains/travel/tools.ts:91`；`src/core/execution/executor.ts:116-124` |
| 历史文档**已经把它登记为必然动内核的 P3**：「多模态 image 通道 … 必然动 `shared/run/types.ts` + `engine.ts:262`」 | `techDocs/v2/03-架构设计-v2.md:592、719` |

**四条路径对比**

| 路径 | 做法 | 效果 | 我的判断 |
|---|---|---|---|
| **A · 借道 `answers`** | `answers` 里塞 `attachment:0 → '{...}'` 或 base64；未知键原样穿过（`clarify.ts:97-99`）并随 `engine.ts:263` 进 `ctx.meta.answers`，工具可读取 | 0 行改动，端到端能跑 | ❌ **否决**。`answers` 的语义是"澄清回答"；且**无 zod 体积/数量上限**，超限无处报错 |
| **B · 借道 `goal` 文本** | 把图片清单 JSON 拼进 `goal` | 0 行改动 | ❌ **否决**。污染用户原话 → `parseGoal` 正则（`parse.ts:29-32`）可能误命中文件名里的数字；`summary = raw.slice(0,200)` 会截断，清单丢了都不知道 |
| **C · 借道 `plan` 快照** | 客户端自己拼一个 Plan（`intent.input` 是 `Record<string, unknown>`，`zStepIntent` 不校验内容，`shared/plan/types.ts:112-116`），走 `resumePlan` 通道 | 0 行改动，**结构上合法** | ❌ **否决，但这条必须被诚实记录**。指标能保持 0，代价：客户端自己拼 `Step` 与依赖 DAG、越过"计划由 Planner 生成"这一核心主张、领域知识搬到客户端。**这就是"为了 PRD 好看假装装得进去"** |
| **D · 下沉成通用槽位 `zAttachment`（推荐）** | `shared/run/types.ts` 新增 `zAttachment` + `zRunRequest.attachments` + `RunContext.attachments`；`engine.ts:253-264` 处过桥 | **破一次 0**（2 个文件，无领域词） | ✅ **推荐** |

**槽位形状（提案，未落地）**

```ts
// shared/run/types.ts —— 禁止出现任何领域词
export const zAttachment = z.object({
  id: z.string().min(1),        // 客户端稳定 id（同名图片靠它区分，见 Q4）
  kind: zInputSignalKind,       // 已存在：shared/domain/types.ts:38（'image'|'text'|'geo'|'link'|'file'）
  name: z.string().min(1),      // 展示名 / @ 提及名
  mimeType: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  ref: z.string().optional(),           // 引用优先：字节不进请求体
  inlineBytes: z.string().optional(),   // 仅小图允许内联，上限在下面
});
export const ATTACHMENT_LIMITS = { maxCount: 20, maxInlineBytesEach: 524_288, maxInlineBytesTotal: 4_194_304 } as const;
```

**★ 已拍板：引用优先 —— 先上传落地，`/api/run` 只带引用**

请求体里只放描述符，**不放字节**：`{ assetId, name, mime, byteSize, url }`。

| 方案 | 优 | 劣 |
|---|---|---|
| 内联 base64 | 零基建，`file input` 直读即可 | base64 膨胀 ≈1.33×；10 张 1MB ≈ 13MB 进单个 JSON POST；请求体上限取决于部署平台（**本项目未实测，保留为 §9 待确认，不编数字**）；且字节会随 `RunContext` 被反复传递 |
| **引用优先（✅ 已选定）** | 请求体恒定小（与图片数量无关）；天然支持大图；重跑 / 澄清 / 续跑时复用同一份引用（T2-11） | 需要"上传落地"这一步（见下，属 L-B，**不破 0**） |

**上传落地点的设计（新增 `app/api/assets`，L-B 不破 0）**

| 项 | 决定 | 理由 / 依据 |
|---|---|---|
| 职责 | ① 接收图片字节 → 落盘（临时目录）或内存；② 校验 mime 与大小并**显式报错**；③ 返回描述符 `{ assetId, name, mime, byteSize, url }` | 单一职责，不做任何识别（识别是领域 Provider 的事，§3.3） |
| **`assetId` 生成方** | **服务端生成**（上传响应里返回）；客户端可先用一个本地临时 id 做 UI key 与 `@` 联想，上传成功后替换 | 客户端生成的 id 可被伪造 / 冲突；覆盖度按 `assetId` 记账（§3.2），id 必须权威 |
| 生命周期（★ 关键约束） | **不依赖 `lifecycle.dispose`** —— 它**当前无人调用**（`techDocs/v2/02-travel领域包设计.md:355`，方案 B 的代价说明里已记录）。改用 **TTL = 1h（已定）** + 按 `runId` 在 run 结束后清理 | 已有前车之鉴：按 runId 累积而无释放点会泄漏 |
| **TTL 过期后的行为**（★ 必须实现） | 用户带着旧 `plan` 续跑（或澄清回灌）时，若 `assetId` 已失效 → **显式报错**（"这张图的临时副本已过期，请重新上传"），并指明是哪一张 | ⚠️ **绝不能静默变成"图没了"** —— 那就是 §3.2 反复在防的"静默"，会让覆盖度校验在用户不知情的情况下少算一张 |
| 存储 | MVP 用内存 Map 或临时目录；**不落对象存储**（§8 Out of Scope） | 部署选型另议 |
| 安全 | 落盘路径不可预测、文件不可执行、限制 mime 白名单 | 上传接口的通用底线 |
| 失败的兜底 | 上传失败 / 超限 → **显式错误文案**（不静默丢图） | 与 §3.2 同源：静默丢失是最不能犯的错 |

**顺便修好一个悬空声明**：有了 `RunContext.attachments`，`requiredSignals`（`meta.ts:28`）就可以被真正兑现成"当领域声明了 `image` 而本次 run 没有附件 → 准入失败"。现在它是**声明了没人读**，将来一旦有人实现 `requiredSignals ⊆ ctx.signals` 而 travel 又改了声明，就会在我们看不见的地方直接挂（`meta.ts:4-8` 的头注释早就警告过）。**建议：放行 `requiredSignals: ['image','text']` 与实现准入检查放进同一批次，不要分批。**

**与 M3（装修）的排期：★ 已拍板 —— travel v2 先做，本轮单独破一次 0**

`techDocs/v2/03-架构设计-v2.md:734-741` 的提醒是：*"内核零改动 = 0 是会过期的……抽象的成败不在于'永远不改内核'，而在于每一次改都是'加一个通用槽位'而不是'加一个领域分支'"*。本轮按这个标准执行：

| 项 | 内容 |
|---|---|
| 决策 | **travel v2 先交付，本轮单独破一次 0；M3（装修）随后再破第二次。接受两次破 0**（理由：图片功能要尽快可用） |
| 本轮破 0 的构成 | 仅两项：① **通用输入通道**（附件槽位 + `signals`）② **通用澄清表单能力**（§3.5） |
| 不在本轮 | `stepSignature` 顺序敏感的度量修正（M3 那一轮）；warning 可见性通道（后续） |
| 基线 | 仍用 **`m1-core-only`**（累积视角），**不得中途打 tag 换基线** |
| 硬闸门 | `grep -rnE "travel\|poi\|景点\|餐厅\|酒店\|行程\|图片说明" src/core shared` 必须仍为 **0**（用 Grep 工具，不用 bash） |

> ⚠️ 我初稿建议的是"并入 M3 只破一次"（成本最低），**该建议已被项目所有者推翻**。理由我认可并记录在此：这轮的目标之一是让图片功能尽快可用，为保住一个"破 0 次数"的账面数字而推迟交付，是把手段当目的。**代价是"内核零改动"这条硬证据本轮会从 0 变成 N，必须按上面的口径逐行记账。**

---

### 3.2 Q2 · 「行程涵盖所有图片」是硬约束还是软约束？

> ⚠️ **v0.2 改判**（team-lead 复核后修正）：初稿把"识别不出的图"写成 `warning` 例外通道，**这是错的** —— `warning` 在当前内核**没有任何 UI 出口**（见下方"可见性注"），等于把"漏掉一张图"这件最该被看见的事，放进一个没有出口的通道里。这恰好是本项目最不能犯的错（M2 的 P1 就是"静默"）。**改判为 `error`。**

> ⚠️ **v0.5 裁决变更**：本文 v0.2~v0.4 把 `IMAGE_UNRESOLVED` 写成"**error 优先**（校验先拦 → 转人工）"。**这个顺序已被架构裁决改掉** —— error 保留，但**触发时机推迟到澄清之后**。下面是变更后的完整口径，**以此为准**。
>
> **★ 变更后的处置顺序（两步，严格有序）**
>
> | 步 | 动作 | 依据 |
> |---|---|---|
> | **1 · 第一动作** | **工具发现识别不出的图 → 立即返回 `needsClarification` + 澄清载荷**（含"跳过这 N 张"选项），用户当场决策 | 工具侧澄清是**领域可写**的路径（§3.4 已验：`observer.ts:55-63` → `engine.ts:624-637`） |
> | **2 · 兜底** | `error` 只在**两种情形**下触发：① 上述澄清无果（用户未处置）；② 澄清路径不可用 | 此时它与 v0.2 的结论一致：**识别不出就是 error，没有第四态** |
>
> **明确写死的禁止项**：**校验不得先于澄清拦截。** 一旦 `validate()` 先返回 error，控制权就进了内核的 `askUserForValidation`，用户**再也看不到"跳过"选项**（原因见下）。
>
> **为什么必须改（这是一条 PRD 阶段没查到的代码事实）**
>
> > `askUserForValidation` 的签名是 `(prompt: string)` —— **它连"传选项"这个参数都没有**，选项在 `src/core/run/engine.ts:493-496` 被硬编码为且仅为两项：`replan`（让 Agent 重排受影响的部分）/ `abort`（放弃这一轮）。**内核里没有任何槽位能塞进"跳过这 N 张"。**
>
> 推论：如果按 v0.2~v0.4 的字面写法实现（error 优先），流程会是 `validate() → ok:false → askUserForValidation()` → 用户只看到「重排 / 放弃」—— **§3.2 定的那条 P0 跳过机制就成了不可达代码**，而且**不会有任何测试报错**，它只是让"跳过"这个选项永远不出现。这正是 **M2 P1 那个失败模式的重演**（"已回落"文案是死代码）。

> ### ★★ 但这是"符合内核设计意图的正确解法"，**不是绕开内核限制的妥协**
>
> `engine.ts:480-482` 的注释原文：
>
> > 校验不通过且无法自动修复 → **转人工**（下发 `ClarifyOptions`，绝不白屏）。**只给通用选项：内核不知道"该怎么改"是领域的事。**
>
> 这说明：校验转人工这条路**刻意只提供通用出口**（重排 / 放弃），而把**领域特定的出口**（"跳过这 N 张"）**留给领域自己去给** —— 领域给出口的方式就是 `zToolResultBase.needsClarification`（`shared/domain/types.ts:101-102`），这条路径从设计之初就是为它准备的。
>
> 换句话说：**这个顺序不是"因为内核做不到所以只能这样"，而是内核有意把"该怎么改"的判断交还给领域，我们按这个分工去实现了它。** 这一点在边界讨论里很重要 —— 它不是 workaround，是顺着既有抽象边界走。
>
> **未被推翻的部分**：「识别不出是 error，**没有第四态**」这条结论**依然成立** —— 被改的只是 error 的**触发时机**（从"校验立刻拦"推迟到"澄清之后兜底"），不是 severity 本身。终端状态表与"① 已排入 / ② 已填充关联 / ③ 无法识别·已阻断 / ④ 已跳过"的四态划分**不变**。
>
> 📍 **完整硬约束与时序图见 `techDocs/v2/05-travel-v2架构设计.md` §3.2.1**（架构已定稿，那里是实现的唯一依据）。

**结论（一句话）：硬约束（`severity: 'error'`，内核会拦），且"识别不出的图"同样是 error —— 每张图必须落到四态之一（已排入 / 已填充关联 / 无法识别·已阻断 / 已跳过·用户显式），**四态全部用户可见**；既没有"提示一下就行"的中间态，也没有"悄悄略过"的暗门。**

**为什么推荐硬约束**

| 理由 | 说明 |
|---|---|
| 用户诉求本身就是硬句 | "行程涵盖所有图片内容"是用户原话，把它降级成 warning 等于没实现需求 |
| 与既有领域哲学一致 | `validateTripPlan` 里：入不了账（`SOURCE_MISSING`）= **error 阻断**（`src/domains/travel/providers.ts:612-731`） |
| 这是"静默"这一失败类型的正面回应 | P1 的教训是"悄悄换城市不标注"（`techDocs/v2/02-travel领域包设计.md:333-337`）。**漏掉一张图而不说，与换城市而不说是同一类失败** |
| 内核侧已经有体验证过的路径 | error → `validateCurrent` 返回 `ok:false` → `decideValidationAction` → 重规划 → 仍不过则转人工（`engine.ts:505-548` / `:484-501`），**不需要新机制** |
| ★ **warning 不能作为载体** | 见下方"可见性注"：warning 在当前内核**没有任何 UI 出口**。把"识别不出"挂到 warning 上 = 让它无声消失 |

**覆盖度怎么度量（必须定义清楚，否则规则会误伤）**

| 度量对象 | 定义 | 采用 |
|---|---|---|
| 按**图片 id** 覆盖 | `已成功识别的 assetId 集合 ⊆ 行程条目引用的 assetId 集合` | ✅ **采用**。稳定、可枚举、可断言 |
| 按识别出的地点覆盖 | 模糊匹配景点名 | ❌ 同名/别名/连锁会误判，且会把"识别正确与否"和"是否被安排"两件事耦合 |
| 按像素 / 相似度 | 无意义 | ❌ |

**★ 每张图必须落到一个明确的终态（四态，全部用户可见）**

| 终态 | 含义 | severity | 用户看到什么 |
|---|---|---|---|
| ① **已排入行程** | 该图被识别且有 `source`，且行程里有条目引用它的 `assetId` | —（正常） | 卡片上带缩略图 + `🖼来自图` 角标 |
| ② **已填充关联** | 该图被识别，行程里以 `origin:'fill'` 的条目承接（标注为推荐、非来自图片） | —（正常） | 带"推荐填充"角标 |
| ③ **无法识别，已阻断** | 无法识别 / 置信度低于阈值，**且用户在"工具澄清"里未处置** | **error** | `paused` + `ClarifyOptions`（**一定看得见**）。⚠️ 此时引擎给的选项**只有「重排 / 放弃」**（`engine.ts:493-496` 硬编码），**"跳过"在 ③ 这一步已经不可用了** —— 见上方 v0.5 裁决变更 |
| ④ **已跳过（用户显式）** ★新增 | 用户在**工具澄清**（终态 ③ 之前的那一步）里主动选了"跳过" | —（约束解除） | 该图**仍出现在行程里**，带 `已跳过` 角标；卡片顶部显示「覆盖 8/10 张（2 张由你跳过）」 |

> ★ **四态的时序**：② 和 ④ 都在 **到达 ③ 之前**由工具澄清完成。**③ 是"用户走到了这一步还没处置"的兜底态，不是主路径** —— 这一点是 v0.5 改的，也是跳过机制能真正可达的前提。

> ★ 为什么 ③ 必须是 error 而不是 warning：一张图识别不出来，"行程涵盖所有图片内容"这条**硬约束已经被违反**，它不是"给个提示就行"的信息，而是"这一版方案不成立"。前两态是"安排上了"，第三态是"安排不上"，**没有中间态**。
>
> ★ **但"全 error 无出路"会逼着实现方偷偷降级成 warning**（那就是回到静默）。所以必须有 ④ —— 见下方"跳过机制"。

**★ 跳过机制（P0，两个硬条件，缺一不可）**

| # | 条件 | 落地方式 |
|---|---|---|
| 1 | **跳过只能是用户显式动作，系统不得自动替用户跳过**；且**必须发生在工具澄清这一步**（不得依赖 ③ 的转人工） | 挂靠内核已有的一等语义：`src/core/goal/clarify.ts:91` 注释明写"回答 'skip' / 'none' 表示用户放弃补充"。在**工具返回的澄清载荷**里给"跳过这 N 张"，**不预选**；用户不选 → 落到终态 ③（error，不 completed） |
| 2 | **行程必须标注实际覆盖率，跳过的图必须出现在行程里** | 覆盖率做成 **`ItineraryCard` 的 props 字段**（`coverage: { total, covered, skippedByUser, unresolved }` + `skippedAssets[]`：缩略图 / 名称 / `已跳过` 角标），形如「覆盖 8/10 张（2 张由你跳过）」 |

> ★★ **为什么覆盖率必须进 props 而不是留在校验结果里**：校验结果（`violations`）**用户看不到**（§3.2 可见性注）。而"步骤结果 → `stepRenderers.toProps` → 组件 props"这条通道是**存在且用户可见的**（`executor.ts:207-210` 只在步骤成功时下发组件 + `ui.ts:117-131` 的 `toProps`）。**把可见性挂在数据通道上，不要挂在违规通道上** —— 这是本轮反复出现的一条设计原则。

**规则表（建议）**

| code（领域私有，内核不可读） | 触发条件 | severity | 后果 |
|---|---|---|---|
| `IMAGE_COVERAGE_MISSING` | 存在已成功识别（有 `source`）的 assetId 未被行程任何条目引用 | **error** | 走既有链路：重规划 → 仍失败则 `paused` + `ClarifyOptions` 转人工（S5 可演示） |
| `IMAGE_UNRESOLVED` ★v0.5 | 图片无法识别 / 置信度低于阈值，**且前述工具澄清无果或不可用** | **error** | **兜底**，不是第一动作 —— 见上方 v0.5 裁决变更。（初稿的 warning 已撤回，原因见可见性注） |
| `MENTION_UNRESOLVED` | `@名称` 0 命中 | **不挂 warning** | 见 Q4：走澄清（工具 `needsClarification`）；备选 error |

> **带条件的未来降级（不是现在的方案）**：若 §0 的第 2 项（warning 可见性通道）落地，`IMAGE_UNRESOLVED` 可以**降级为 warning** —— 那时"识别不出"能在 UI 上说出口，就不必用阻断来换可见性。这条必须写成**条件式**，且在条件满足前按 error 实现。

**同名图片**：不能靠名字判重。客户端必须给每张图一个稳定 `assetId`（建议 `${name}#${序号}`，或「name + size + 内容摘要」）。覆盖度**只按 `assetId` 记账**，名字重复不影响判定 —— 名字只服务于 `@` 提及（见 Q4）。

> **★ 可见性注（写给实现者，别照着"warning 会提示用户"去写，会白做）**
> 当前的 SSE 事件契约（`shared/stream/events.ts`，10 类事件：`plan_start / plan_status / step_add / step_status / component_start / component_props_delta / component_end / error / done`）**全文没有 `violation` / `warning` / `severity` 任何一个字段** —— 用 Grep 工具复核为零匹配。
> 因此：**`severity: 'warning'` 的违规不会到达 UI，它只活在 `validate()` 的返回值与日志里。** 内核对 warning 的语义就是 `continue`（`decideValidationAction`，`engine.ts:430-437`）。M2 的 `FACTS_DROPPED`（`providers.ts:718-725`）就是活例子：它"必须说出口"，但**用户在界面上永远看不到**。
> 推论：**任何"必须让用户知道"的约束，都不能用 warning 承载** —— 要么 `error`（走拦-重排-转人工，用户可见），要么走澄清（`needsClarification`，用户可见）。给 warning 开事件通道是 §0 第 2 项的事，不是现在能假设的。
>
> ⚠️ 但二者**不是无条件等价**：只要该约束还需要给用户一个**特定的出口**（如"跳过这 N 张"），就**必须走澄清** —— error 那条路的选项是内核硬编码的，塞不进出口（见本节开头 v0.5 裁决变更）。

> 会不会太脆？会，但有解：识别不出的图走 error 后，用户会看到 `ClarifyOptions`（"重排 / 放弃 / 补充信息"），**他可以自己决定要不要继续**，而不是被一个看不见的提示放过。

---

### 3.3 Q3 · 「适当做行程填充推荐」—— 填充内容从哪来？会不会碰反幻觉红线？

**结论（一句话）：填充项**必须**来自 Provider（v2 阶段就是现有的 fixtures），必须带 `SourceRef`，并且必须打上 `origin: 'fill'` 标记与"来自图片"的项区分——如果让模型编一条"附近有家不错的店"，那就是直接踩红线 16。**

**依据**

| 事实 | 位置 |
|---|---|
| 事实数据（价格/评分/工时/数值）**只能来自 Provider**，模型不得编造 | `CLAUDE.md:43`（红线 16） |
| `producesFacts: true` 的步骤返回空 `sourceRefs` → `observe()` 直接判 `fail` + 内核通用码 `SOURCE_MISSING` | `src/core/execution/observer.ts:41-52` |
| `travel.poi` Provider 每条候选都带 `source`，返回体带 `SourceRef` + `isEstimate: true` + 免责声明 | `src/domains/travel/providers.ts:737-755` |
| 现有 `prompts.antiHallucination` 已经禁了"凭印象编造地名/价格/评分" | `src/domains/travel/prompts.ts:16-19` |

#### "确定项" vs "填充项"：区分的是**意图来源**，不是事实可靠性

| 维度 | 来自图片的确定项 | 填充推荐项 |
|---|---|---|
| 名称 / 价格 / 评分 / 地址 | Provider（`travel.poi` 或新增 `travel.vision`） | Provider（`travel.poi`） |
| 是否有 `SourceRef` | ✅ 必须 | ✅ 必须（否则步骤直接判失败） |
| `isEstimate` / disclaimer | ✅ 保留 | ✅ 保留 |
| **新增字段 `origin`** | `'image'` | `'fill'` |
| UI 呈现 | 带图片缩略图 + 来源 | 带"推荐填充"角标 |
| 参与覆盖度分子计数 | ✅ | ❌ |

> ★ `origin` 是**意图溯源**（"为什么这一项在行程里"），`SourceRef` 是**事实溯源**（"这一项的数据从哪来"）。两者不可互相替代：一个编出来的景点，即便带上假的 SourceRef，比不带更糟（这正是 P1 的教训，见 `techDocs/v2/02-travel领域包设计.md:333-337`）。

**prompts 需要同步补的一条**（v2 必做）：现有 `antiHallucination` 只写了"名称/价格/评分不得编造"，**没有写"填充项也不得编造"**。要加上：*"为让行程更完整而补充的条目，同样只能取 Provider 返回的候选；若 Provider 无可用候选，宁可不填并向用户说明，不得凭 '附近应该有' 生成名称或价格。"*

**上限与度量**

| 常量 | 取值 | 状态 |
|---|---|---|
| `MAX_FILL_PER_DAY` | 2 | 工程判断 |
| `MAX_FILL_RATIO`（填充项 / 总条目） | **0.3** | ★ **已定，但明标：无实测依据的工程判断，需真机演示后校准** |

> 取值理由：填充项是**"连接用"不是"凑数用"** —— 超过三成行程就不是填充而是注水了。
> 为什么必须给一个数：不给会卡住实现；但给了就要标清它是猜的。**"适当填充"里的"适当"必须是可验收的数字**，否则实现者可以拿填充凑满行程来骗过覆盖度校验 —— **这是一条必须提前堵住的暗门**（与 `FACTS_DROPPED` 同源：任何能绕过成本/覆盖校验的路径都必须可观测）。

> ⚠️ **超阈值出 `warning` 这条在此作废**（§3.2 可见性注：warning 无 UI 出口）。超阈值时改为：**在 `ItineraryCard` props 里显式标注"填充占比 X%，超过建议值 30%"**，走数据通道可见，不走违规通道。

#### 填充闸门的实际算式，与它的边界（已知限制）

实现在 `src/domains/travel/providers/compose.ts`，闸门 = **两条同时生效，取更严的那个**：

```
fillCap = min( MAX_FILL_PER_DAY,                       // 每天最多 2 项
               floor( covered * MAX_FILL_RATIO / (1 - MAX_FILL_RATIO) ) )  // 占比口径
```

第二条是"填充 / 总条目 ≤ 0.3"的反解：设图片项 `c` 项、填充 `f` 项，要求 `f / (c + f) ≤ 0.3` → `f ≤ c * 0.3 / 0.7`。

| 已排入的图片项 `covered` | `floor(c*0.3/0.7)` | 实际可填充 |
|---|---|---|
| 1 | `floor(0.43)` = **0** | **0 项** |
| 2 | `floor(0.86)` = 0 | **0 项** |
| 3 | `floor(1.29)` = 1 | 1 项 |
| 4 | `floor(1.71)` = 1 | 1 项 |
| 5 | `floor(2.14)` = 2 | 2 项（同时撞上 `MAX_FILL_PER_DAY`） |

> ⚠️ **已知限制（明标，不是 bug）**：**只排进 1~2 张图时，填充数为 0** —— 占比口径下 1 张图允许 0.43 项，取整后就是 0。
> 这是"填充是连接用不是凑数用"这条原则的直接后果：**1 张图撑不起一个"完整的一天"，此时宁可少排也不注水。**
> 影响面：单图场景的行程会明显偏短（只有 1 个确定项），演示时不要把"只上传 1 张图"当作覆盖度样例。
> 若要放宽，改的是 `MAX_FILL_RATIO` 或给 `covered < 3` 单独设下限 —— **两者都属于"需真机演示后校准"的工程判断，先不动**（同上表 0.3 的标注）。

---

### 3.4 Q4 · `@+图片名称` 的文本关联规则

> ⚠️ **v0.2 改判**（team-lead 复核后修正）：初稿把"@ 了不存在的图"写成 `warning`，**这是错的** —— warning 没有 UI 出口（§3.2 可见性注），用户 @ 错名字会**什么都不会发生**，这正是"静默"这个失败类型本身。**改判：走澄清（用户看得见），备选 error，绝不是 warning。**

**结论（一句话）**：做成领域内的**纯函数** `parseImageMentions(text, assets)`，**三态返回**（`resolved / ambiguous / unresolved`）；歧义不允许静默挑第一个（全部命中 + 显式提示），未命中不允许静默丢弃 —— **0 命中走澄清（工具返回 `needsClarification` → 步骤 `awaiting_user` → 用户点选），备选 error，绝不 warning**。

**解析规则（可直接写成测试用例）**

| 规则 | 取值 |
|---|---|
| 起始 | `@` 紧跟非空白字符（`@外滩.jpg` ✅ / `@ 外滩` ❌） |
| 结束 | 遇到**空白**、**中英文标点**（`，。；、,.!?！？`）、或下一个 `@` 为止 |
| 字符集 | 中文 + 字母 + 数字 + `. _ -`（保留常见文件名形态） |
| 转义 | `@@` 表示字面 `@` |
| 匹配方式 | 先按**完整文件名**精确匹配 `asset.name`；未命中再按"去掉扩展名"匹配（`@外滩` 命中 `外滩.jpg`） |

**三态处理**

| 状态 | 条件 | 行为（v0.2） | 为什么这样选 |
|---|---|---|---|
| `resolved` | 唯一命中 | 文本 → 该 `assetId` | 正常路径 |
| `ambiguous` | 命中 ≥2（两张图同名，如都叫 `IMG_001.jpg`） | **全部关联**，并在 UI 明示"该名称命中 N 张，说明已同时关联" | ★ Q8 已裁决：**允许重名共存，不强制改名**（强制改名 = 系统改用户数据，越界；且既然允许多命中就不能要求唯一名）。静默挑第一个 = 把用户的说明挂到错图上，是**事实伪造**（与 P1 同组）；断然报错又太重 |
| `unresolved` ★改判 | 0 命中 | **工具返回 `needsClarification: true` + `question`**（字段用 §3.5 新增的 `image-ref` 类型，候选 = 已上传图片清单）→ `observer.ts:55-63` 判 `kind:'clarify'` → 步骤转 `awaiting_user` → `engine.ts:624-637` 下发澄清，让用户点选"这段说明指哪张图 / 放弃这段说明"。**不关联任何图**（绝不猜一个挂上去） | ① 用户**看得见**（澄清是 UI 事件，不是返回值）；② **零内核改动**：这是内核已实现的领域无关路径；③ 与"不硬猜"一致（`shared/plan/types.ts:231` 对 `missingFields` 的注释：信息不足时先走澄清，不硬猜） |

> **★ 为什么不走 `Goal.missingFields`**（team-lead 提的路径，我复核后不采用它当主路径，理由要写清楚）：
> `missingFields` 的**唯一写入点是内核的 `parseGoal`**（`src/core/goal/parse.ts:73-75`，只判两件事：目标太短 / `requireConstraints` 且无约束），**`src/domains/**` 对 `missingFields` 零命中 —— 领域没有写入点**。要让领域能往里塞"@ 未命中"，就得给内核加一个领域 hook（L-C，破一次 0）。
> 而**工具返回 `needsClarification`** 这条路径**零改动就能达到同样的用户可见效果**（`observer.ts:55-63` → `engine.ts:624-637`）。既然有零代价路径，就不必为 `missingFields` 付一次 "0 → N"。**把它记为备选，不是主路径。**
>
> **备选（若澄清路径因故不可用）**：退回 **error**（走拦-重排-转人工，用户依然看得见）。**底线：绝不能是 warning。**

> **★ 可见性注**：同 §3.2 —— `shared/stream/events.ts` 全文无 `violation` / `warning` / `severity` 字段（Grep 复核零匹配），`warning` 不会到达 UI。因此"@ 未命中"若挂 warning，用户就会**什么都没发生**，这正是本项目最不能犯的"静默"失败。实现时请以"用户能看见"为准，不要以"severity 语义正确"为准。

---

### 3.5 Q5 · 澄清用「流式生成动态表单」，现有能力够不够？

**现有能力（读完的结论）**

| 事实 | 位置 |
|---|---|
| `ClarifyOptions` 的 props 只有 `questionId / prompt / options[] / traceId`；`options` 每项只有 `id / label / description` | `src/components/generative-ui/ClarifyOptions/schema.ts:5-10` |
| 组件实现就是**一排按钮**（`options.map` → `<button>`），没有任何输入控件 | `src/components/generative-ui/ClarifyOptions/index.tsx:21-41` |
| 回灌协议只有 3 种动作：`select_option / retry / cancel`，且只能带 `questionId + optionId`（**两个都是字符串**） | `src/components/generative-ui/ClarifyOptions/schema.ts:15-19` |
| 传输侧 `answers: Record<string, string>` —— **任意 string 值都能传回**，这点其实够用 | `shared/run/types.ts:54`；`shared/plan/types.ts:247-253` |
| 澄清只能由**引擎**主动下发，有三种触发：目标缺字段 / 工具返回 `needsClarification` / 计划校验转人工 | `engine.ts:236-251`、`:624-637`、`:484-501` |
| 组件产物**只在步骤成功时**下发（`awaiting_user` 的步骤不会渲染领域组件） | `src/core/execution/executor.ts:207-210` |
| 但"逐步长出"这件事**今天就能做**：`propsToPatches` 对数组字段逐项发 `{op:'add', path:'/xxx/-'}`，配前端 16ms 合批，天然就是"逐条长出" | `src/core/execution/executor.ts:263-276`；`src/features/run/useCoalescedNodes.ts` |

**一句话结论**：`ClarifyOptions` 现在是**扁平可点选项**，不是表单。缺三样东西：**① 字段描述能力（类型 / 校验 / 默认值）**、**② 多字段一次性回灌**、**③ 谁能暂停等待用户**。其中"流式长出"这件事**今天就能做**（`propsToPatches` 对数组逐项发 `/fields/-`），①③ 需要落到契约与组件上。

**★ 已拍板：上升为内核通用能力，并入 travel v2 这一轮**

> ⚠️ **这是一次有意例外，必须被显式记录，不能默默写成"应该内核化"**。
> 它与 `CLAUDE.md:96` 的纪律冲突：*"想加一个新的内核字段（先确认它会被 ≥2 个领域用到，否则是过度抽象）"* —— 目前**只有 travel 一个领域**需要动态表单。
> **破例理由（项目所有者给出，我认可）**：travel v2 的澄清不是边缘能力，而是**主交互路径之一**（给图片写说明、确认识别结果、跳过识别不出的图都要靠它）；而现有扁平选项在"给图片写一段说明"这类场景下**根本无法表达**，不是"表达得差一点"。
> **补充一条我自己的判断**：`needsClarification` 本来就是内核已有的一等能力（`observer.ts:55-63` / `shared/domain/types.ts:101-102`），现在扩的只是它**携带的载荷形状**。这更接近"补齐一个已有槽位"而不是"凭空加一个新抽象" —— 这也是我接受这次破例的第二条理由。
> **事后验证**：若第二个领域接入后**也用上了**内核表单，说明这个槽位加对了；若只有 travel 用，它就是一笔要被承认的过度设计。**这一点请写进 M3 的复盘清单。**

### 内核侧形态设计（本轮破 0 的构成 ②）

**① 字段描述的形状**（`shared/plan/types.ts`，扩 `zClarifyQuestion`，`options` 保留以兼容既有调用点）

```ts
export const zFieldKind = z.enum(['text', 'number', 'date', 'select', 'multi', 'image-ref']);

export const zClarifyField = z.object({
  id: z.string().min(1),
  kind: zFieldKind,                       // image-ref = 从已上传图片里挑一张，值为 assetId
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().default(false),
  options: z.array(zClarifyOption).default([]),   // select/multi 的候选；image-ref 复用来放图片清单
  // ★ 字段级校验：内核只**透传**这些值，不解析、不执行、不据此分支（红线 9）
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().optional(),
  default: z.string().optional(),
});

export const zClarifyQuestion = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(zClarifyOption).default([]),   // 保留：扁平选项仍是合法形态
  multi: z.boolean().default(false),
  fields: z.array(zClarifyField).default([]),     // ★ 新增：非空时按表单渲染
});
```

**② 流式增量怎么长** —— **不用新机制**，复用现成的两条路径：

| 场景 | 路径 | 依据 |
|---|---|---|
| 引擎下发的澄清（`ClarifyOptions`） | `emitComponent` 内部就是 `propsToPatches(props)` → 数组字段逐项 `{op:'add', path:'/fields/-'}` | `engine.ts:162-183` + `executor.ts:263-276` |
| 领域步骤产出的组件 | `emitResultComponents` 同样走 `propsToPatches` | `executor.ts:221-256` |

即：**字段逐个长出是协议层已经支持的能力，本轮只需要在 props 里多一个数组字段**，配前端 16ms 合批（`useCoalescedNodes`）即可。

**③ 字段级校验规则放哪** —— 三层分工，内核不得越界：

| 层 | 做什么 | 依据 |
|---|---|---|
| **内核（`shared`）** | 只定义 `min/max/maxLength/pattern/required` 的**形状**并透传；**不执行、不解析、不据此分支** | 红线 9：内核只消费 `ok`/`severity`，不得认识字段语义 |
| **前端组件** | 渲染时按这些值拦截提交（即时反馈），**不替服务端放行** | L-B，不破 0 |
| **领域** | 收到 `answers` 后自行 `safeParse` 校验；不通过 → 再发一次澄清或转 error | 红线 2：来自网络的 JSON 必须 `safeParse` |

**④ 回灌通道怎么扩** —— 现状 `answers: Record<string,string>` 的语义是 `questionId → optionId`，承载不了多字段自由输入。

| 方案 | 做法 | 改动 | 我的判断 |
|---|---|---|---|
| **A（推荐）· 通用键约定** | 键 = `makeFormKey(questionId, fieldId)`（helper 放 `shared/plan/types.ts`，纯函数、领域无关）；`multi` 值用 JSON 数组编码，领域侧 `safeParse` 还原 | **`shared/**` 加槽位；`src/core/**` 一个文件都不动**（`applyAnswers` 只认 `clarify:<field>` 键，其余原样穿过，`clarify.ts:97-99`） | ✅ 推荐。记账最干净：本轮破 0 全部落在 `shared` 加槽位 + `engine.ts` 过桥，**`src/core` 里只有 `engine.ts` 一处** |
| B · 值类型放宽 | `answers` 值放宽为 `string \| string[]` | 需同步改 `src/core/goal/clarify.ts:99` 的类型判断 | 备选。语义更直白，但本轮会多动一个 `src/core` 文件 |

**⑤ 组件与交互（L-B，不破 0）**

| 决策 | 结论（★ 已定，不再有分支） |
|---|---|
| **容器形态** | **`ClarifyOptions` 支持"表单模式"，容器固定为内联气泡**（in-place bubble，长在对话流里）。**不做模态、不做"字段少内联 / 字段多模态"的分流** —— 少一整套分支与对应测试 |
| 渲染规则 | `fields` 非空 → 按字段渲染控件；`options` 非空 → 仍是按钮；两者可共存（向后兼容既有调用点） |
| 动作 | `zComponentAction` 扩 `submit_form`，带 `values: Record<string, string \| string[]>`（`src/components/generative-ui/ClarifyOptions/schema.ts:15-19`，属 L-B） |

> **★ 已知取舍（内联气泡的代价，接受）**：字段多时表单会把对话往上顶，用户需要滚动才能同时看到行程卡与表单。**这是为了"不遮挡已有结果"主动付的代价** —— 遮罩（模态）会让人看不到自己刚生成的行程与图片墙，而那恰恰是填空时要参照的东西。**不做的**：不做按字段数分流、不做可折叠/最小化（那属于 Q13 之后的打磨，v2 不引入该分支）。

**必须同时修的一处（L-B，不破 0）**：`app/page.tsx:113-118` 的 `onAction` 现在是"每点一次就 `start()` 整轮重发"，且**不带 plan 快照**（已知限制，`techDocs/v2/03-架构设计-v2.md:597` 第 6 条）。表单场景必须改成**本地草稿 + 一次提交**，并带上 `plan` 快照续跑。

---

### 3.6 Q6 · 行程用「动态卡片 + markdown」展示

**现有形态**：`ItineraryCard` 是一份纯 Tailwind 的**结构化列表**（天数徽标 / 每日 theme / 条目 `slot·name（类别）¥price` / 住宿 / 总计 / 预算对照 / 来源 / 免责），**props schema 里没有任何自由文本字段**（`src/domains/travel/components/ItineraryCard/schema.ts:1-34`；渲染 `:31-54`）。

**分工建议（一条可被测试的原则）**

> **卡片 = 结构化数据；markdown = 叙述。凡是要参与约束计算、成本重算或溯源的数据，必须落在卡片的结构化字段里；markdown 里出现的一切都视为"叙述"，不得承载价格、评分、地址、时长等事实。**

| 内容 | 载体 | 理由 |
|---|---|---|
| 第 N 天 / 时段 / 条目名 / 价格 / 来源 | 卡片结构化字段 | 参与 `validateTripPlan` 的成本重算，必须可被解析 |
| 条目是"来自图片"还是"推荐填充" | 卡片结构化字段 `origin` | 参与覆盖度度量，不能藏在文本里 |
| 用户的 `@图片名` 说明 | 卡片结构化字段（`notes[]`，带 `assetId` 关联） + markdown 版 itinerary 里同步渲染 | 关联关系必须是数据，不是字符串 |
| 行程总述 / 每日贴士 / 交通建议 / 免责说明 | **markdown** | 纯叙述，不参与计算 |

**markdown 渲染要不要加依赖？**

当前 `package.json` 依赖只有 `next@16.3.3 / react@19 / zod@4.1.8` —— **没有任何 markdown 库**。

| 方案 | 评估 |
|---|---|
| 引第三方库（`react-markdown` 等） | 客户端 bundle 影响**小于直觉**：travel 组件是 `load: () => import('./components/ItineraryCard')`（`register-ui.ts:28`）经 `<Suspense>` 懒加载（`ComponentRenderer.tsx:88-94`），会被切进**独立 chunk**，不进首屏。真正风险是**新增依赖本身**（`CLAUDE.md:97` 要求新依赖不得威胁 Cloudflare 镜像方案）与其依赖树体积（具体 KB 数**未实测，待确认**） |
| 服务端把 md 转结构化 blocks，props 仍是 JSON，前端只渲染块（**推荐**） | 零依赖；md 的解析/白名单在服务端，前端不背 parser；与"内核 `toProps` 必须是纯函数"的要求兼容；可单测 |
| 自研 ~50–80 行极简子集渲染器（`#/##`、`**bold**`、`- 列表`、`[text](url)`，**禁止原样注入 HTML**） | 零依赖、可控；维护成本自担 |

推荐 **服务端转 blocks**（干净、可测、零依赖），把"要不要引入成熟库"作为 §9 待确认项。

---

### 3.7 Q7 · 「UI 风格与对话框交互参考即梦 AI」

> ⚠️ **本节只有两条结构性结论是已定的；视觉规范继续留白，等材料。**
> 我**没有**即梦 AI 的界面细节（栅格、配色、字体、动效时长），因此本文不描述"即梦长什么样"。强行描述会在评审当场被拆穿 —— 那不是 PRD，是作文。

### ★ 已定的两条结构性结论（项目所有者给出）

| # | 结论 | 原话 / 依据 | 落到哪 |
|---|---|---|---|
| **1 · 首屏主路径 = 对话优先** | **首屏就是对话框，不是上传区 / 素材墙**。图片由用户在对话中上传（拖拽 / 附件按钮），**不存在"先传图再进对话"这个前置阶段**。素材墙（缩略图区）是**对话内的附属呈现**，不是独立首屏区块 | 项目所有者原话：「参考即梦，首屏是对话框，图片是用户上传的」 | §5 线框重排；US-1 已改写为"边说边传" |
| **2 · 澄清表单容器 = 内联气泡** | 表单**就地在对话流里长出**，不遮行程与图片墙；不做模态、不做按字段数分流 | §3.5 ⑤（已写死为内核组件的固定形态） | `ClarifyOptions` 表单模式 |

> 这两条是**结构**，不需要视觉材料就能开工；栅格 / 配色 / 动效 / 字体**仍需材料**（见 §9.1 的 M-1 / M-3 / M-4 / M-6，状态为 ⏳ 等用户提供）。

### 交互模式层面的通用形态（不依赖具体视觉规范）

| 通用交互模式 | v2 怎么落地 |
|---|---|
| **对话优先**：对话框是唯一主入口，一切（文字、图片、澄清、结果）都发生在消息流里 | 沿用现有 `page.tsx` 的结构（`plan → PlanView → 逐条 ComponentRenderer`）；上传入口**内联在输入框旁** |
| 素材墙是**消息内的缩略图区**（某条用户消息里带了 N 张图 → 该条消息下方显示 N 张缩略图，可单删、可 hover 看名字与识别状态） | 新增 `ImageWall` 领域组件（L-A），但它**不再是一个独立首屏区块** |
| **渐进式表单**（需要补充信息时，控件逐个出现，就地长在对话流里） | §3.5 的内核表单能力：`/fields/-` 逐条长出 + 16ms 合批 + 内联气泡容器 |
| **结果卡片流**（生成结果以卡片呈现，可 hover 溯源、可点开详情） | 现有 `ItineraryCard` + `PoiCard` 扩展 |

> **面试口径建议**：*"交互模式对齐了参考产品（对话优先 + 对话内素材墙 + 卡片流 + 内联渐进式表单），视觉规范由项目方提供截图后回填。"* 这比"我们复刻了即梦"既诚实又稳 —— 而且**对话优先与内联气泡这两条是已落地的结构决策，可以讲**。

---

### 3.8 Q8 · 这个领域还装得进 DomainPack 的 8 段吗？

**逐段体检**：8 段的完整增量表见 §6；这里只挑出**会明显变胖**的三段（`providers.ts` 现已是 827 行）：

| 段 | 增量 | 预计行数 | 会不会失控 |
|---|---|---|---|
| ③ **providers** | 新增 `travel.vision` 图片理解 Provider + 覆盖度 / 填充 / `@` 的口径与校验 | **+200~300**（827 → 1000+） | ⚠️ **是** |
| ④ ui | 新增 `ImageWall`；`ItineraryCard` 加 `origin` 角标、notes、覆盖度徽标、markdown 摘要 | +150~180 | 中等（前端组件天然独立） |
| ② tools | 新增 `travel.imageUnderstand`；`itineraryCompose` 扩参扩返回 | +70~90 | 否 |

> ★ **v0.3 重估（回应"表单内核化之后 `providers` 压力是否减轻"）：几乎没减轻，拆分建议不变，但压力来源变了。**
> 表单挪走只带走 **`ui` 段**里约 60~80 行的 `ClarifyForm`（以及它附带的"本地草稿 + 一次提交"前端状态），**`providers` 一行都没少** —— 因为 `providers` 变胖的原因是**"跨步骤约束只能住在 `createValidator` 里"**（根因见下），跟表单住哪毫无关系。
> 更准确的说：**表单内核化反而让 `providers` 多背了一点** —— 澄清载荷（`fields[]`，比如"这段 @ 说明指哪张图"的候选清单）要由领域侧构造，而构造它的地方（`@` 解析）今天正被 `providers.ts` 这个文件名吸着。
> 结论：**§3.8 的文件级拆分建议不但不撤，反而更紧迫**（新增 `providers/mentions.ts` 专门承载"构造澄清载荷"这件事）。

**会不会重演 M2 的教训？会，而且概率很高 —— 现在就要动手术，不要等它发生。**

`techDocs/v2/03-架构设计-v2.md:261-301`（§3.2）已经把 M2 判死结论写得很清楚：

- M2 那两个**性质不同**的缺陷（P0 类型收窄、P1 回落语义），修复增量 **142 行、100% 落在 `providers.ts`**（685 → 827），而 `planning.ts / tools.ts / ui.ts` 几乎没动；
- 根因：**8 段里只有 `providers.createValidator` 能拿到整份 `Plan`**（`planning.validateStep` 只能拿到单个 `Step`），所以所有跨步骤约束被迫挤进去；
- 该文档给的判据（`:716`）：*"记录每个契约段在'缺陷修复'中增加的行数 —— 若 M3 第二个领域**再次**如此 → 不是两个领域各自写错，是这一段结构有问题，届时动契约，不再改实现"*。

v2 新增的三件事里，**"图片理解 Provider"本来就该住在 providers（它是事实数据源，这才是本意）**；但 **"覆盖度校验""`@` 解析""填充口径"不是数据源**，它们会被同一个文件名吸过去。**这正是 §3.2 判定的复演路径。**

**建议现在就做的三件事**

1. **文件级拆分（L-A，不算契约改动、不破 0）** —— 把 `providers.ts` 拆成：
   `providers/poi.ts`（POI 数据源）· `providers/vision.ts`（图片理解数据源）· `providers/compose.ts`（编排口径）· `providers/planCheck.ts`（计划级校验，仍从 `createValidator` 槽位导出）· `providers/mentions.ts`（`@` 解析 **+ 澄清载荷构造**，v0.3 起它要同时供 §3.5 的内核表单使用）。
   目的是让"`providers` 段实际承担了几件事"这件事**在文件名上可见**，而不是靠行数去猜。
2. **把「每个契约段在缺陷修复中增加的行数」记进 travel v2 的交付记录**，作为 §3.2 那条 P2 判据的第二个数据点（第一个数据点是 M2 的 142 行 / 100%）。
3. **第 9 段此刻**不提议**拆**：真正落地要改 `shared/domain/types.ts`（例如新增 `planning.validatePlan(plan, ctx)` 槽位），是 L-C，**建议与 §3.1 的附件槽位、M3 的 `stepSignature` 放进同一基线重打批次**。在此之前，用 (1) 的拆分先把它做成"可观测"。

> **可被反驳的量化判据**（写在这里，便于日后被人推翻）：travel v2 交付时，若"全部新增内容写完之后" `providers` 段（含其拆分文件）占领域包行数仍 **> 50%**，或其缺陷修复增量**仍 100% 落在同一槽位** → 支持立即动契约拆第 9 段。

---

## 4. 需求池

> 每条都可验收；ID 前缀 `T2` = travel v2。**P0 全部完成 = v2 闭环成立。**

### P0（必须）

| ID | 需求 | 验收标准 |
|---|---|---|
| T2-01 | **图片批量上传**（前端多选 / 拖拽 / 缩略图墙 / 单删 / 数量与单张大小限制） | 拖入 10 张图 → 缩略图墙显示 10 项；超限（>20 张或单张 >上限）→ **显式报错文案**，不静默裁剪 |
| T2-02 | **附件槽位**（§3.1 方案 D） | `zAttachment` 通过 zod 校验；`git diff` 的改动行数被记录进 PRD/审查单，且每次改动都能说明为"通用槽位"；`Grep` 复核 `src/core shared` 领域词 = 0 |
| T2-03 | **图片理解 Provider `travel.vision`（fixture，零网络零密钥）** | 每条识别结果带 `source`（`fixture://travel/vision/<id>`）；失败 → `SOURCE_MISSING`（`observer.ts:41`） |
| T2-04 | **工具 `travel.imageUnderstand`**（`producesFacts: true`） | 一次处理附件清单里的全部图；返回 `identified[] / unresolved[]`；返回体必带非空 `sourceRefs` |
| T2-05 | **stepType `image_understand` + 模板改造** | 模板形状仍是"并行→汇聚"同类；`validateStep` 新规则有单测 |
| T2-06 | **覆盖度硬校验**：`IMAGE_COVERAGE_MISSING = error` + **`IMAGE_UNRESOLVED = error`（兜底）** ★v0.5 | ① 构造"识别成功但日程漏排 1 张" → `ok===false` 且 `severity==='error'`；② 构造"1 张无法识别" → 步骤**先**产出 `awaiting_user` + 含"跳过这 N 张"的澄清节点（**不是先被校验拦下**）；③ 用户不选 → 才落到 error。**②③ 的顺序是验收重点** —— 若实现成"直接 error"，跳过选项将永不出现而测试仍全绿 |
| T2-07 | **`@` 关联解析三态**（resolved / ambiguous / unresolved）+ **0 命中走澄清** | `parseImageMentions` 纯函数单测覆盖：同名 2 张 / `@` 不存在 / 标点截断 / `@@` 转义；且"@ 不存在"端到端必须产出 `step_status: awaiting_user` + `ClarifyOptions` 节点（**不是静默通过**） |
| T2-08 | **填充推荐来自 Provider + `origin: 'image' \| 'fill'`** | Itinerary 里每条都带 `source`；`origin==='fill'` 的条目不进覆盖度分子；填充占比超过 `MAX_FILL_RATIO=0.3` 时**在卡片 props 里显式标注**（不是 warning，warning 无 UI 出口） |
| T2-09 | **ItineraryCard v2**（origin 角标 / notes / 覆盖度徽标 / markdown 摘要） | markdown 渲染走"服务端转 blocks"（§3.6 推荐方案），前端零 parser 依赖 |
| T2-10 | **回归锁 ≥ 20 用例**（P0/P1 修复 + 覆盖度 + `@` + origin） | 新增 `src/test/travelV2*.test.ts`，`npx vitest run` 全绿，**并单独跑 `npm run typecheck`**（`CLAUDE.md:84-88`） |
| T2-11 | **重跑一致性**：澄清 / 编辑 / 续跑请求必须携带同一份附件引用 | 构造"先澄清再续跑"的流程 → 第二步依然能看到同样的图（否则第二步会因覆盖度不足误报） |
| **T2-22** ★已拍板 | **通用澄清表单能力（内核化）**：`shared/plan/types.ts` 扩 `zClarifyQuestion.fields` + `zClarifyField`（`text/number/date/select/multi/image-ref`）；`ClarifyOptions` 支持表单渲染；`zComponentAction` 扩 `submit_form` | ① `fields` 非空时按控件渲染，`options` 非空时仍是按钮（向后兼容，既有调用点不回归）；② 端到端可见"字段逐个长出"（`/fields/-` + 16ms 合批）；③ **Grep 复核：`shared/**` 与 `src/core/**` 新增内容零领域词** |
| **T2-23** ★已拍板 | **回灌通道扩展**（§3.5 方案 A：`makeFormKey(questionId, fieldId)`） | 多字段自由输入能一次回灌；`multi` 值用 JSON 数组编码，领域侧 `safeParse` 还原；`applyAnswers`（`clarify.ts:97-99`）既有行为不回归 |
| **T2-24** ★已拍板 | **跳过机制**（仅用户显式动作） | ① 澄清里"跳过这 N 张"**不预选**，不选则维持 error；② 跳过后 `ItineraryCard` props 里 `coverage = {total, covered, skippedByUser, unresolved}`，UI 显示「覆盖 8/10 张（2 张由你跳过）」；③ 被跳过的图**仍出现在卡片里**带"已跳过"角标 |
| **T2-25** | **破 0 记账**：`git diff --numstat m1-core-only..HEAD -- src/core shared` 的**每一条**（`--numstat` 每行 = **一个改动文件**，不是一行代码）都能说明为"通用槽位"，且零领域词；文件数（`\| wc -l`）与增删行数（`\| awk '{a+=$1;d+=$2} END{print a+d+0}'`）两个口径都要记 | 产出一份逐行说明表进交付物；`Grep` 守卫（§7.2）通过 |

### P1（应该）

| ID | 需求 |
|---|---|
| T2-12 | 请求体体积上限的**实测**（部署平台上限、上传耗时、内存），产出数字回填 §3.1（**已拍板引用优先，故此项只是补数据，不阻塞**） |
| T2-13 | `@` 联想下拉（输入 `@` 时列出已上传图片名，从源头减少 0 命中） |
| T2-14 | `requiredSignals` 被内核真正消费（准入检查），让 `meta.ts` 的声明不再悬空 |
| T2-15 | `evaluation.metricIds` 里已声明但**无埋点**的 `fact_source_coverage`（`evaluation.ts:27`）真正采集 |
| T2-16 | 给 warning 开 SSE 事件通道（§0 第 2' 项），让 `FACTS_DROPPED` 这条 M2 遗留债可见；落地后 §3.2 的 `IMAGE_UNRESOLVED` 可按"带条件的未来降级"降为 warning |
| T2-17 | 图片 → 城市/坐标推断（EXIF 或地理 Provider），**必须标注来源**，不得静默当成已知事实 |
| **T2-26** ★已裁决 | **跳过后补图重跑**：用户跳过某张图后，可补传一张替换图并只重跑受影响步骤（不是整轮） | **P1**（跳过是当轮的出口，补图重跑是下一轮的事）；不做则用户只能删图重传 |

### P2（锦上添花）

- **T2-18** 真实视觉模型接入（`MastraRuntime` + `models.ts`，`C1-01`）
- **T2-19** 图片持久化到对象存储 / 断点续传
- **T2-20** 行程导出 PDF / 分享链接
- ~~**T2-21** 把"动态表单"上升为内核通用组件~~ → **已提前到 P0（T2-22），本项取消**

---

## 5. UI 设计稿描述（文字稿）

> ★ **下面的线框只描述信息架构与交互，不描述视觉规范。** 视觉规范（即梦部分）待 §3.7 清单里的材料到位后回填。

> ★ **v0.4 重排（已定：对话优先）**：素材墙**不再是独立首屏区块**，它是某条用户消息下方的缩略图区。下面的线框按"一条消息流"组织，而不是按"功能区"组织。

```
┌───────────────────────────────────────────────────────────┐
│  首屏 = 一条消息流（唯一主入口）                            │
│                                                           │
│  ── 用户消息 #1 ──────────────────────────────────────     │
│  │ "帮我规划三日游 @外滩.jpg 想拍夜景，预算 3000"      │    │
│  │ ② 素材墙（本条消息内，非独立区块）                  │    │
│  │ ┌────┐┌────┐┌────┐┌────┐ 徽标：已识别/未识别/已跳过 │    │
│  │ │img1││img2││img3││img4│  × 单删                    │    │
│  │ └────┘└────┘└────┘└────┘                           │    │
│  ─────────────────────────────────────────────────────     │
│                                                           │
│  ── 系统消息：计划流（PlanView 现有能力）──────────────     │
│  │ s-1 看懂 4 张图     ✅ 识别 3 / 未识别 1（点开看） │    │
│  │ s-2 检索候选（并行×3）✅ 卡片：候选 + 来源         │    │
│  │ s-3 编排行程         🔄 流式长出                   │    │
│  ─────────────────────────────────────────────────────     │
│                                                           │
│  ── 系统消息：结果卡片 + markdown ────────────────────     │
│  │ ┌ ItineraryCard v2 ─────────────────────────────┐ │    │
│  │ │ 上海 · 3 天 [样例数据]  覆盖 3/4（1 张跳过）  │ │    │
│  │ │ 第1天 ¥1190                                    │ │    │
│  │ │  上午 外滩 🖼[来自图] ¥0 — "@外滩.jpg：想拍夜景"│ │    │
│  │ │  中午 南翔馒头店 [填充推荐] ¥90                │ │    │
│  │ │ 总计 ¥2435 · 预算 ¥3000 · 在预算内             │ │    │
│  │ │ 已跳过：img4（标记原因）                       │ │    │
│  │ │ ── markdown 摘要 ──────────────────────       │ │    │
│  │ │  第 1 天以外滩为核心，傍晚建议留 1.5h 拍夜景…  │ │    │
│  │ └───────────────────────────────────────────────┘ │    │
│  ─────────────────────────────────────────────────────     │
│                                                           │
│  ── 系统消息：澄清（★内联气泡，就地长在流里）─────────     │
│  │ ┌ ClarifyOptions（表单模式）────────────────────┐ │    │
│  │ │ 还要几点信息：                                │ │    │
│  │ │  ▸ 出发日期  [日期]                           │ │    │
│  │ │  ▸ 每天强度  ( )轻松 ( )适中 ( )紧凑          │ │    │
│  │ │  ▸ 饮食忌口  [文本]                           │ │    │
│  │ │  [提交]  [跳过，按默认出计划]                 │ │    │
│  │ └───────────────────────────────────────────────┘ │    │
│  ─────────────────────────────────────────────────────     │
│                                                           │
│  ① 输入框（常驻底部）：[＋图片][拖拽至此] [发送] [中断]     │
│     输入 @ 触发图片名联想（T2-13，P1）                     │
└───────────────────────────────────────────────────────────┘
```

> ★ **"对话优先"这条对实现的具体约束**：上传入口必须**内联在输入框**（`[＋图片]` / 拖拽落点就是整个消息区），**不存在独立的上传页/上传态**；上传中的图以"该条消息内的占位缩略图"呈现，上传成功后替换为真实缩略图 + `assetId`。用户**永远不用离开对话框**。

**组件归属**

| 组件 | 归属 | 注册方式 |
|---|---|---|
| `ImageWall`、`ItineraryCard v2`、`VisionResultCard` | travel 领域（L-A） | `src/domains/travel/register-ui.ts` + `components/*/schema.ts` |
| **`ClarifyOptions`（表单模式，内联气泡容器）** ★ 从"领域自建 `ClarifyForm`"改判 | **内核**（本轮破 0 的构成 ②，L-C） | `registerCoreUIComponents()` + `shared/plan/types.ts` 扩 `fields` |
| 上传 / 拖拽区（内联在输入框）、`@` 联想输入、图片选择后的本地状态 | 前端外壳（L-B） | `src/features/**` / `app/page.tsx` |
| 降级组件（RawPayload / ErrorState / Skeleton） | 内核（不动） | `registerCoreUIComponents()` |

> ★ `ClarifyForm` 这个名字已从方案中删除。理由：一旦它是内核能力，就该由内核组件 `ClarifyOptions` 在 `fields` 非空时按表单渲染（向后兼容 `options` 按钮形态），**而不是领域另注册一个平行组件** —— 否则将来第二个领域会再写一个 `XxxForm`，内核化就白做了。

---

## 6. 领域契约增量（8 段逐段）

| 段 | 新增 / 修改 | 预计行数 | 关键字段决策 |
|---|---|---|---|
| ① meta | `requiredSignals: ['image','text']`；`capabilities.vision: true`；`matcher.keywords` += 图片相关 | +5 | ⚠️ 必须**与**"内核准入检查"同一批次放行，否则又是悬空声明（§3.1 末） |
| ② tools | `travel.imageUnderstand`（`producesFacts: true` / `idempotent: true` / `timeoutMs: 5000`）；`travel.itineraryCompose` 扩参（验收 `coverage` / `origin` / `notes`） | +70~90 | 前者必须返回非空 `sourceRefs`，否则 `SOURCE_MISSING`（`observer.ts:41`） |
| ③ providers | 新增 Provider `travel.vision`；`createValidator` 新增覆盖度规则 | **+200~300** | **强烈建议同时做文件级拆分**（§3.8），否则必然复演 M2 教训 |
| ④ ui | `ImageWall` / `ItineraryCard v2`；`stepRenderers` 新增 `image_understand → VisionResultCard` | +150~180 | ★ 澄清表单**不再注册在这里**（已内核化，§3.5）；markdown 走"服务端转 blocks"，前端零 parser 依赖 |
| ⑤ prompts | `antiHallucination` 补"填充项同样不得编造"；新增"图片识别结果是事实，须可溯源，未识别必须说出口" | +15 | prompts 只能约束模型的行为，**不能替代 Provider 侧的强制点** |
| ⑥ planning | 新增 stepType `image_understand`（`maxAttempts: 2`）；模板 `travel.basic` 改形；`validateStep` 加规则 | +40 | 形状**保持同类**（并行→汇聚），避免同时引入"换形状"变量（那是 M3 的事） |
| ⑦ evaluation | 3 个新 case：`travel.image-coverage` / `travel.image-fill` / `travel.mention-unresolved`；`metricIds` 加 `image_coverage` | +25 | `score()` 覆盖 happy-path 与覆盖度两条 |
| ⑧ lifecycle | 无（fixture 领域无资源） | 0 | 保持空实现 + 注释（`pack.ts:25-32` 的既有约定） |

---

## 7. 验收标准

### 7.1 可跑的命令

```bash
# ① 三条常规闸门（缺一不可，且 vitest 不做类型检查）
npm run typecheck && npm run lint && npm test

# ② 领域专属用例（新增 + 既有回归锁不得退化）
npx vitest run src/test/travelDomain.test.ts
npx vitest run src/test/travelRegression.test.ts
npx vitest run src/test/travelClosedLoop.test.ts
npx vitest run src/test/travelV2.test.ts          # 新增：覆盖度 / @ / origin / mentions

# ③ ★ 内核判据（预期因 T2-02 从 0 变为 N，必须书面说明每一次改动为何是"通用槽位"）
#    文件数口径（--numstat 每个文件输出一行，故 wc -l = 文件个数）
git diff --numstat m1-core-only..HEAD -- src/core shared | wc -l
#    增删行数口径（把 numstat 两列累加）
git diff --numstat m1-core-only..HEAD -- src/core shared | awk '{a+=$1;d+=$2} END{print a+d+0}'

# ④ 反向剥离
rm -rf src/domains/travel && npm run build && git checkout -- src/domains/travel
```

### 7.2 ★ Grep 守卫（**一律用 Grep 工具，不要用 bash grep** —— bash 的中文关键词会静默返回 0，而 0 恰是守卫的通过值，`CLAUDE.md:73-81`）

| 守卫 | 期望 |
|---|---|
| `<领域词>` 在 `src/core` 与 `shared` 中的命中 | **0** |
| `.code` / `.evidence` / `.suggestion` 在 `src/core` 中的读取 | **0** |

### 7.3 可演示的场景（每条配截图/录屏进交付物）

| # | 场景 | 期望结果 |
|---|---|---|
| S1 | 上传 8 张已知城市的图 + "帮我规划三日游，预算 3000" | `completed`；ItineraryCard 显示覆盖度 **8/8**；每个图像条目带缩略图与 `🖼来自图` 角标 |
| S2 | 上传 10 张，其中 2 张识别不出来 ★v0.5 | ① **先在对话里长出一个澄清气泡**："有 2 张没识别出来，想怎么处理？"含**「跳过这 2 张」**选项（**不是直接 `paused`**）；② 用户选"跳过"后才继续出方案，卡片标注「覆盖 8/10（2 张由你跳过）」；③ 用户不选 → 才落到 `error` + `paused`（此时只有「重排 / 放弃」） |
| S3 | 目标里写 `@不存在的图.jpg` 想去那里 | **不静默**：步骤转 `awaiting_user`，UI 弹出 `ClarifyOptions` 让用户点选"这段说明指哪张图 / 放弃"；该段文本**始终没有被挂到任何图上** |
| S4 | 两张同名 `IMG_001.jpg` + `@IMG_001.jpg 想久待` | 说明**同时**关联到两张，并提示"该名称命中 2 张" |
| S5 | 人为让编排漏掉 1 张已识别的图 | `plan: draft → replanning`；重排仍失败 → `paused` + `ClarifyOptions` + `VALIDATION_ASK_USER`（**一个 step 都没执行**） |
| S6 | 预算 300 | 与 M2 同款：`draft → replanning → paused → ClarifyOptions`；且新的填充项不得让总价作弊通过 |
| S7 | 信息不足（天数未知） | UI **流式长出**动态表单（字段逐个出现），填完提交 → 续跑成功，`plan.revision` 符合预期 |
| S8 | `simulate: 'fatal'` | 重排路径不崩（回归 M2 的 P0）；完成后新计划依旧满足覆盖度 |
| S9 | 澄清/编辑后续跑 | 第二步**仍能看到同样的图片**（T2-11），覆盖度不误报 |

> S1–S9 的 curl 示例**待 T2-02 的字段形状定稿后回填**（形状尚未落地，此处不放伪命令以免误导）。

---

## 8. 明确不做（Out of Scope）

| 不做 | 原因 |
|---|---|
| 真实视觉模型 / 第三方识图 API | 需要密钥与网络，违反本项目"零网络零密钥"（fixture 领域）的现状约定，且新依赖需评估 Cloudflare 镜像方案（`CLAUDE.md:97`）。v2 用 fixture Provider，走和 `travel.poi` 一样的"可溯源 + 标注"路径 |
| 图片持久化到对象存储 | 先做内存/临时目录；属部署选型，见 §9 |
| 换"计划形状"（严格时序链、回溯搜索） | 那是 M3 装修要证明的事；travel v2 刻意保持"并行→汇聚"同类 |
| 领域路由（说人话自动选域） | PRD P2 `C2-01`（`docs/PRD.md:456`）；若顺带实现建议并入同一基线批次 |
| 行程编辑的富文本编辑器 | `@` 联想输入即可；富文本会把"结构化 vs 叙述"的边界搅浑（§3.6 的原则会失效） |
| 多人协作 / 分享 / 导出 | MVP 不做（`docs/PRD.md:18-25` 的既有取舍） |
| 拆第 9 段契约槽位 | 属 L-C；建议与 M3 同批；**在此之前**用文件级拆分先让它可观测（§3.8） |
| 给 warning 开 SSE 事件通道 | §0 第 2' 项，本轮不做；§3.2 / §3.4 已把所有"必须可见"的约束改挂到 error 与澄清上（两者都有 UI 出口），不构成正确性遗留 |

---

## 9. 待确认问题清单（请项目所有者拍板）

### 9.1 ★ 必须由项目所有者**提供材料**才能继续（不提供就只能停在"待确认"，且无法靠推理补齐）

> 这一组不是"选 A 还是选 B"，是**我手上没有、也绝不会去编的东西**。已给的两条（M-2 / M-5）已落到正文；其余等用户材料，到了照着回填。

| # | 需要提供的材料 | 状态 | 卡住什么 | 缺了会怎样 |
|---|---|---|---|---|
| **M-1** | **即梦 AI 的界面截图 / 录屏 / 链接**（重点：① 输入区与素材区的关系 ② 生成结果卡片的形态 ③ 是否有独立右侧画布） | ⏳ **等用户提供**（项目所有者已确认会提供） | §5 的视觉层；`ImageWall` 与输入框的视觉关系 | 只能按通用对话式布局做，**"参考即梦"这条需求实际上无法验收** |
| **M-2** | 首屏主路径：先出图再对话，还是对话优先？ | ✅ **已给：对话优先** | — | 已闭环（§3.7 / §5 已落地） |
| **M-3** | **设计 token**：栅格 + 明暗两套主题（圆角 / 间距 / 层级 / 强调色） | ⏳ 等用户提供 | 落到 Tailwind 类；`ItineraryCard v2` 与 `ImageWall` 的视觉 | 只能沿用现有卡片样式，视觉参考落空 |
| **M-4** | **流式动效规范**：骨架屏 / 渐显 / 打字机 / 光标，各自的时长与缓动 | ⏳ 等用户提供 | "流式感"的观感；`useCoalescedNodes` 的 16ms 合批表现 | 目前只能"出现即出现"，流式感靠猜 |
| **M-5** | **澄清表单的呈现形态**：内联气泡 还是 模态？ | ✅ **已给：内联气泡** | — | 已闭环（§3.5 ⑤ 已写死为内核组件的固定容器） |
| **M-6** | **中文字体 / 字重 / 行高** | ⏳ 等用户提供 | 排版 | 沿用系统字体 |

> ★ 已给的 M-2 / M-5 都是**结构与容器**，也正是当初标"必须早给"的两条 —— 现在可以开工，不必等视觉材料。
> ⏳ 的 M-1 / M-3 / M-4 / M-6 是**纯视觉**，可边做边等；材料到了照着回填，不改动已定的结构。

### 9.2 需要拍板的问题（不含上面那组）

| # | 问题 | 我的倾向 | 不拍板的后果 |
|---|---|---|---|
| **Q-A** ★已拍板 | travel v2 与 M3（装修）的排期先后？ | ✅ **已定：v2 先做，单独破一次 0；M3 随后再破第二次**（理由：图片功能要尽快可用） | 已闭环 |
| **Q-B** ★已拍板 | 图片过桥：内联 base64 还是引用优先？ | ✅ **已定：引用优先**（请求体只带描述符）；上传落地点 `app/api/assets` 属 L-B 不破 0 | 已闭环 |
| **Q-C** ★已拍板 | 动态表单：领域内自建 还是 上升为内核能力？ | ✅ **已定：上升为内核能力，并入本轮**（有意例外 `CLAUDE.md:96`，理由见 §3.5） | 已闭环 |
| **Q-D** ★已拍板 | "跳过这 N 张识别不出的图"进 P0 吗？ | ✅ **已定：进 P0**，带两个硬条件（仅用户显式动作 / 覆盖率进 props） | 已闭环 |
| **Q-E** ★已拍板 | 首屏主路径 / 澄清表单容器（= M-2 / M-5） | ✅ **已定：对话优先 + 内联气泡**（§3.7 / §3.5 ⑤ / §5） | 已闭环 |

### 9.3 ★ 已裁决（v0.4，不再上抛）

| 编号 | 裁决 | 理由（team-lead） |
|---|---|---|
| **Q5'** | ✅ **采纳 A**（`makeFormKey(qid,fid)` 键约定，`src/core` 只动 `engine.ts` 一个文件） | 破 0 的 N 行越少越可解释。**最终以探针结果为准** —— 已派探针验 `applyAnswers` 是否只认 `optionId`；若 A 走不通则回改 |
| **Q6** | ✅ **服务端转 blocks，零依赖** | 与"新增领域不动内核依赖"同款纪律；红线要求前端只注册组件，多一个 markdown 库就多一份 bundle 与信任面 |
| **Q7** | ✅ **关闭**（不需查公开资料，用户会提供材料） | — |
| **Q8** | ✅ **同名共存，不强制改名** | 强制改名 = 系统改用户数据，越界；且与 Q4 定的"同名多命中 = 全关联 + 显式提示"自洽 —— 既然允许多命中，就不能要求唯一名 |
| **Q9** | ✅ **不放开外网依赖** | 与 M2"零网络零密钥"同款；v2 一律 fixture Provider，真实视觉模型留给后续 |
| **Q10** | ✅ **保持未实测** | 引用优先已绕开大部分风险；**不编数字** |
| **Q11** | ✅ **TTL = 1h** + 补充要求：TTL 过期后带 `plan` 续跑若 `assetId` 失效 → **显式报错**，不得静默变成"图没了" | 同 §3.2：静默是最不能犯的错（已写入 §3.1 上传落地点表） |
| **Q12** | ✅ **能补图重跑，且是 P1 不是 P0** | 跳过是当轮的出口，补图重跑是下一轮的事（已建 T2-26） |
| **Q13** | ✅ **`MAX_FILL_RATIO = 0.3`**（`MAX_FILL_PER_DAY = 2`），并明标「**无实测依据的工程判断，需真机演示后校准**」 | 不给数会卡住实现，给了要标清是猜的；填充项是"连接用"不是"凑数用"，超三成就不是填充而是注水 |

---

## 10. 变更记录

| 版本 | 变更 | 触发方 |
|---|---|---|
| v0.1 | 初稿：8 个硬问题逐条回答 | — |
| v0.2 | **Q2 / Q4 改判**：warning 无 UI 出口 → "识别不出"改 error、"@ 未命中"改澄清；§3.2 / §3.4 各加"可见性注"；§0 补"三项契约补齐" | team-lead 复核（`shared/stream/events.ts` 全文无 `violation/warning/severity`） |
| v0.2 | 反向纠正：`missingFields` 在 `src/domains/**` 零写入点，改用工具 `needsClarification` | 我复核后提出，team-lead 采纳 |
| **v0.3** | ① **排期拍板**：v2 先做、单独破一次 0，M3 随后；基线仍 `m1-core-only`，记账口径与"零领域词"硬闸门写死 ② **图片过桥拍板**：引用优先，`app/api/assets` 落地（L-B） ③ **动态表单拍板**：上升为内核能力，含内核侧形态设计（字段枚举 / 流式增量 / 校验三层分工 / 回灌扩法）与"有意例外"记录 ④ **跳过机制进 P0**（两个硬条件） ⑤ §3.8 重估：表单挪走不减轻 `providers` 压力，拆分建议不变且更紧迫 ⑥ §9 拆成"必须提供材料"与"需要拍板"两组 | 项目所有者拍板，team-lead 转达 |
| **v0.4** | ① **M-2 对话优先**：首屏就是对话框，素材墙降为"消息内缩略图区"；§1 / §2(US-1) / §3.7 / §5 线框全部重排 ② **M-5 内联气泡**：写死为内核 `ClarifyOptions` 表单模式的固定容器，不做模态、不做按字段数分流，并写明"长表单顶对话"的已知取舍 ③ §3.7 改为"两条结构性结论已定 + 视觉继续留白"，Q7 关闭 ④ **§9.3 新增九项裁决**（Q5'~Q13 全部落定） ⑤ `MAX_FILL_RATIO` 定 **0.3** 并标"无实测依据，需校准"；**超阈值不再出 warning**（无 UI 出口），改走卡片 props 显式标注 ⑥ TTL=1h + **过期续跑必须显式报错**（不得静默"图没了"） ⑦ 新增 P1 **T2-26 跳过后补图重跑** | 项目所有者给 M-2 / M-5；team-lead 一并裁决 §9.2 剩余项 |
| **v0.5（本文）** | ★ **`IMAGE_UNRESOLVED` 处置顺序改判**：从"error 优先（校验先拦）"改为「**工具澄清第一动作 → error 仅兜底**」，并写死"**校验不得先于澄清拦截**"。依据是 PRD 阶段未查到的代码事实：`askUserForValidation` 签名仅 `(prompt: string)`，选项在 `engine.ts:493-496` 硬编码为「重排 / 放弃」，**无槽位塞"跳过"** —— 按旧写法实现会让跳过机制成为**不可达代码且测试全绿**（M2 P1 死代码的重演）。同步修正：终态表 ③④ 时序、`IMAGE_UNRESOLVED` 规则行、跳过机制条件 1、**T2-06 验收**（补顺序判据）、**S2 场景**。指向架构 `techDocs/v2/05-travel-v2架构设计.md §3.2.1` | 架构裁决（techDocs/v2/05 §3.2.1 定稿），team-lead 转达 |
| **v0.5.1（本文）** | §3.2 v0.5 裁决变更下补「★ ★ **不是妥协，是顺边界**」一段：引 `engine.ts:480-482` 注释原文，说明内核校验路径**刻意只给通用出口**、领域特定出口本就该由领域经 `needsClarification` 给出 —— 为"你是不是在绕开内核"这类追问提供正面答案 | team-lead 复核建议 |

---

## 附录 A · 本文引用的关键位置速查

| 结论 / 约束 | 位置 |
|---|---|
| `zRunRequest` 无附件字段 | `shared/run/types.ts:39-62` |
| `signals` 写死 `['text']` | `src/core/run/engine.ts:262` |
| `RunContext.meta` 只过桥 2 个键 | `src/core/run/engine.ts:263` |
| 选域逻辑（只看 `domainId`） | `src/core/run/engine.ts:159` |
| 计划请求不含附件 | `src/core/runtime/adapter.ts:30-37` |
| MockRuntime 只回放模板、不读 ctx | `src/core/runtime/mock/script.ts:88-100` |
| `answers` 只有 `clarify:<field>` 键被消费 | `src/core/goal/clarify.ts:97-99` |
| ★ **内核刻意只给通用转人工出口**（"该怎么改是领域的事"） | `src/core/run/engine.ts:480-482`（注释原文） |
| ★ **校验转人工的选项无注入口**（`(prompt: string)` + 硬编码 `replan`/`abort`） | `src/core/run/engine.ts:484、493-496` |
| `missingFields` 唯一写入点（内核，领域无写入点） | `src/core/goal/parse.ts:73-75` |
| 事实缺来源即失败（内核通用码 `SOURCE_MISSING`） | `src/core/execution/observer.ts:41-52` |
| `needsClarification` → `kind:'clarify'` → `awaiting_user` | `src/core/execution/observer.ts:55-63`；`engine.ts:624-637` |
| 组件只在步骤成功时下发 | `src/core/execution/executor.ts:207-210` |
| **数组的流式追加 `/items/-`** | `src/core/execution/executor.ts:263-276`；`engine.ts:162-174` |
| ★ **SSE 事件流无 `violation/warning/severity`** | `shared/stream/events.ts`（全文 Grep 零匹配） |
| `decideValidationAction` 对 warning = `continue` | `src/core/run/engine.ts:430-437` |
| `ClarifyOptions` 只有扁平选项 | `src/components/generative-ui/ClarifyOptions/schema.ts:5-10` |
| 回灌只有 3 种动作 | `src/components/generative-ui/ClarifyOptions/schema.ts:15-19` |
| 工具侧 `needsClarification` / `question` 字段 | `shared/domain/types.ts:101-102` |
| `zInputSignalKind`（`image` 已在枚举里） | `shared/domain/types.ts:38` |
| 领域组件的懒加载入口 | `src/domains/travel/register-ui.ts:20-39` |
| `validateTripPlan` 9 条规则 | `src/domains/travel/providers.ts:612-731` |
| 回落必须标注（P1 教训） | `src/domains/travel/providers.ts:55-63、737-755` |
| image 通道已登记为必动内核 | `techDocs/v2/03-架构设计-v2.md:592、719` |
| providers 段过载的判据 | `techDocs/v2/03-架构设计-v2.md:261-301、716` |
| 内核字段要 ≥2 个领域才抽象（本次破例） | `CLAUDE.md:96` |
| 新依赖不得威胁 Cloudflare 镜像方案 | `CLAUDE.md:97` |
| Grep 守卫不可用 bash（中文会静默返回 0） | `CLAUDE.md:73-81` |

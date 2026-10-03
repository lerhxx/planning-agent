# planning-agent

**目标驱动的规划型 Agent 基座** —— 用户给一个目标，Agent 产出一份**可见、可编辑、可中断的计划**，逐步执行，遇失败或新信息**动态重规划**。

> 本仓库**只包含基座（内核）**，不含任何具体领域的实现。
> 领域通过 **Domain Pack** 接入，内核不认识任何领域语义。

---

## 1. 这是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 一个**规划内核**：Goal → Planner → Plan → Executor → Observer → Replanner | 一个具体领域的 AI 应用（不做旅行/装修/学习本身） |
| 一套**领域包契约**与注册表 | 一套 UI 组件库（只提供通用兜底组件） |
| 运行时生成、**用户可编辑可推翻**的计划文档 | 编译期写死的流程编排 |
| 可替换执行层的抽象（Mock / Mastra） | 绑定某一个 Agent 框架的产品 |

---

## 2. 核心概念

| 概念 | 一句话 |
|---|---|
| **Goal** | 用户给的目标（不是指令），含约束与成功判据 |
| **Plan** | 一等公民数据对象：可序列化、可 diff、可编辑、可局部推翻重建 |
| **Step** | 计划的最小单元，带依赖 DAG 与状态机 |
| **DomainPack** | 一个领域必须提供的全部东西（工具 / Provider / UI / 提示词 / 步骤类型 / 评测） |
| **RuntimeAdapter** | 内核唯一可见的执行接口，Mastra 只是它的一个实现 |
| **PlanCompiler** | 纯函数：`Plan → ExecutionGraph(IR) → 运行时图`，含依赖环检测 |
| **Replanner** | 失败/新信息触发重规划，保留已完成步骤，带收敛判定 |

---

## 3. 分层

```
Goal ──▶ Planner ──▶ Plan（一等公民数据）
              ▲         │
        Replanner ◀── Observer ◀── Executor
                          │
                    PlanCompiler（纯函数 · 可单测）
                          │
                  ExecutionGraph（IR）
                          │
              ┌───────────┴───────────┐
        MockRuntime              MastraRuntime
              └───────────┬───────────┘
                     DomainPack
        （tools / providers / ui / prompts / planning / evaluation）
```

**铁律**：`src/core/**` 与 `shared/**` 中不出现任何领域词；删除任一 `domains/*` 目录仍可编译运行。

---

## 4. 技术栈

| 层 | 选型 |
|---|---|
| 框架 / 运行时 | Next.js 16.3.3（App Router）+ React 19 |
| 编排执行层 | Mastra `@mastra/core@~1.67`（**执行层，不是规划层**） |
| 流式与模型抽象 | Vercel AI SDK UI（`createUIMessageStream` + `useChat`） |
| 校验 | **zod 4.1.8**（模型与网络过来的 JSON 一律不可信） |
| 状态 | `useChat`（消息流）+ Zustand（UI）+ `nodeReducer`（patch 累积） |
| 部署 | Vercel 主 + Cloudflare OpenNext 国内镜像 |

⛔ **不进 MVP**：`ai/rsc` 与 `streamUI`（官方标注 experimental）、Mastra Dynamic Workflows（需额外 storage，威胁 Cloudflare 镜像方案）。

---

## 5. 目录结构

```
planning-agent/
├── app/
│   ├── layout.tsx  globals.css
│   ├── page.tsx                      # 'use client'，仅作壳
│   └── api/
│       ├── run/route.ts              # 创建 run + SSE 流
│       └── [...mastra]/route.ts      # @mastra/next 适配器
├── src/
│   ├── core/                         # ★ 领域无关，禁止出现领域词
│   │   ├── goal/                     # 目标解析与澄清
│   │   ├── planning/                 # Planner / Plan / Step / 状态机
│   │   ├── execution/                # Executor / Observer / Scheduler
│   │   ├── replan/                   # Replanner / 策略表 / 收敛判定
│   │   ├── compiler/                 # PlanCompiler（纯函数 · 环检测）
│   │   ├── degrade/                  # 三级降级策略（领域无关）
│   │   ├── registry/                 # DomainPack 注册表
│   │   └── runtime/                  # RuntimeAdapter + mock/ + mastra/
│   ├── domains/                      # 领域包（本仓库为空，只放契约与示例骨架）
│   │   └── .gitkeep
│   ├── components/generative-ui/     # 通用注册表 + 兜底组件
│   ├── features/run/                 # useChat + nodeReducer + 合批
│   └── lib/
└── shared/                           # ★ zod schema → z.infer，前后端唯一真源
```

---

## 6. 快速开始

```bash
npm install
npm run dev
```

规则文件**已经在仓库里**，AI 编码工具会自动读到，不用手动复制：

| 文件 | 作用 |
|---|---|
| `CLAUDE.md` | 常驻规则（短，每次都进 context）：红线 + 目录 + 文档指针 |
| `AGENTS.md` | → 符号链接到 `CLAUDE.md`（兼容读 AGENTS.md 的工具） |
| `docs/CONSTRAINTS.md` | 完整约束文档（按需读） |
| `docs/ARCHITECTURE.md` | 架构地图（动手写代码前读） |

> ⚠️ `next.config.ts` 必须设 `serverExternalPackages: ['@mastra/*']`，否则打包会炸。

---

## 7. 里程碑

| M | 目标 | 验收 |
|---|---|---|
| **M1** | 内核 + MockRuntime + 通用 UI | 目标 → 计划 → 执行 → 重规划 闭环跑通 |
| **M2** | 接入第一个 Domain Pack | 领域能用内核跑通，且 `core/**` 无改动 |
| **M3** | 接入第二个 Domain Pack（不同约束形状） | **`git diff --numstat m2-only..HEAD -- src/core/** shared/** \| wc -l` → 0** |
| **M4** | 打磨 + 双部署 | 在线链接 + README 演示 |

**M3 是"可扩展"这个主张唯一的硬证据** —— 口头声称没有说服力，`git diff` 才有。

---

## 8. 文档（四层分工）

| 位置 | 谁读 | 什么时候进 context |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | AI | **每次都读**（刻意保持简短，只有红线与指针） |
| `docs/ARCHITECTURE.md` | AI | 动手写代码前读（地图：目录、契约在哪、数据流） |
| `docs/CONSTRAINTS.md` | AI + 你 | 写具体代码时按需读（完整规则、理由、Prompt 模板） |
| `docs/PRD.md` | 你 + AI | 需求/验收有疑问时读 |
| `techDocs/**` | **你（人）** | **不进 context** —— 架构论证、契约参考、面试亮点 |
| `README.md` | 你 | 本文件 |

**为什么分成这样**：常驻 context 的文件必须短，否则稀释注意力；而长篇论证文档（选型对比、历史决策）**不应该进 context**——它腐烂得比代码快，且 AI 抓不到重点。

**目录约定**：`docs/` = 驱动 AI 的规则与需求（短、可执行判据）；`techDocs/` = 给人看的技术文档（深、可论证、面试用）。

**架构最可靠的载体是代码里的 zod schema，不是 Markdown**：`shared/plan/types.ts` 永远不会和实现对不上，因为它就是实现。

---

## 9. 新增一个领域

只需要新增 `src/domains/<id>/` 一个目录，实现 `DomainPack` 的 8 段契约（见 `docs/PRD.md` §7），然后在两个桶文件里各加一行：

```ts
// src/domains/index.ts（服务端桶）
import { registerXxxDomain } from './xxx/register';
export function registerAllDomains(): string[] {
  return [registerDemoDomain(), registerXxxDomain()];
}

// src/domains/ui.ts（客户端桶）
import { registerXxxUIComponents } from './xxx/register-ui';
export function registerAllUI(): void {
  registerCoreUIComponents();
  registerDemoUIComponents();
  registerXxxUIComponents();
}
```

**内核不应有任何改动**——如果改了，说明抽象破了。生产代码里的引用点数量保持不变（仍是 2 个文件 2 处 import）。

详细的分步模板见 `docs/CONSTRAINTS.md` §5「Prompt 片段库 · 新增一个 Domain Pack」，完整开发指南见 `techDocs/04-DomainPack开发指南.md`。

---

## 10. M1 现状（内核 + MockRuntime + 通用 UI）

**M1 已跑通闭环**：`npm run dev` → 输入目标 → 计划逐条长出 → 分步执行 → 可触发重规划 → 可中断。

| 项 | 说明 |
|---|---|
| 模型 | **零网络、零 API Key**：`MockRuntime` 连模型也 mock，规划/重规划/工具全部走脚本化 fixtures |
| 领域 | `src/domains/demo/` —— ⚠️ **这是验证装置，不是产品领域**（见该目录 `meta.ts` 头注释）。它只有 2 个 stepType、2 个 tool、1 个无网络 fixture provider，唯一目的是证明内核闭环能跑 |
| 内核 | `src/core/**` 与 `shared/**` 中无任何领域词；接入新领域不需要改内核任何一个文件 |

### 怎么复现（30 秒）

```bash
npm install && npm run dev
# 打开 http://localhost:3000
```

页面上的「注入…」下拉框用来演示三条失败路径：

| 选项 | 能看到什么 |
|---|---|
| 正常执行 | 计划长出 → 两路并行采集 → 汇总 → `completed` |
| 注入可重试失败 | 某一步第一次失败 → `retry-step`（attempt 2 成功） |
| 注入不可恢复失败 | 某一步失败 → 计划转 `replanning` → **只重排受影响子树（已完成步骤 id 不变）** → 继续跑完 |
| 注入信息不足 | 步骤转 `awaiting_user` → 下发 `ClarifyOptions`，点选后带答案继续 |

「中断」按钮 = `abort` → 计划转 `paused`，界面不白屏。

**计划编辑**：run 进入终态（`paused` / `failed` / `awaiting_user` / `aborted`）后，页面上会出现「编辑计划后继续」面板，可以对某一步**改标题 / 重试 / 跳过**，或**原样继续**。它复用与澄清相同的「先编辑、再原路重发」路径：`plan` 快照 + `edit` 命令一起回传，服务端重新校验 plan 并归一状态后再跑。**已完成步骤默认冻结**——直接改会被 `FROZEN_STEP` 拒绝，得先「重试」解冻。

### 自检

```bash
npm run typecheck && npm run lint && npm test
grep -rnE "demo|采集|汇总|条目|成文" src/core shared | wc -l   # → 0
grep -rn "\.code\|\.evidence\|\.suggestion" src/core | wc -l     # → 0
```

M1 的三条硬门槛都有对应用例守着（`npm test` 共 129 例）：

| 门槛 | 守着它的用例 |
|---|---|
| 收敛判定 delta 真的能触发 | `src/test/edgeCases.test.ts` · 「重排结果与原计划一致 → 终态 `NO_CONVERGENCE`」 |
| 大计划只动一小撮**不得**被误判 | `src/core/replan/gates.test.ts` · 「25 步计划只重排 1 步」+ `edgeCases.test.ts` 同名 e2e |
| 校验型 Provider 真的在闭环里 | `src/test/validation.test.ts` + `edgeCases.test.ts` · 「`createValidator` 至少被调用一次」「不合法计划一步都不执行」 |

**反向剥离（`rm -rf src/domains && npm run build`）当前真实成本：生产代码 2 个文件、2 处 import。**

| # | 文件 | 引用 | 作用 |
|---|---|---|---|
| 1 | `app/api/run/route.ts` | `import { registerAllDomains } from '@/src/domains'` | 服务端注册领域包（**唯一**服务端引用点） |
| 2 | `app/page.tsx` | `import { defaultDomainId, registerAllUI } from '@/src/domains/ui'` | 前端注册领域组件（**唯一**客户端引用点） |

另有 3 个测试文件各自 `import { registerAllDomains } from '@/src/domains'`（`src/test/closedLoop.test.ts`、`src/test/edgeCases.test.ts`、`src/test/validation.test.ts`）——测试本来就必须引用一个领域包才能跑闭环，不计入生产引用点。

新增/删除领域包只改 `src/domains/index.ts`（服务端桶）与 `src/domains/ui.ts`（客户端桶），上面的引用点数量不变。两个桶文件刻意分开：`ui.ts` 会触及 `'use client'` 的 React 组件，不能被服务端 import 进模块图。

---

## 11. 与 Mastra 的关系

Mastra 是**执行层**（跑工具、记忆、评测），不是规划层。准确表述是**一等抽象不同**：它的一等抽象是执行图，本项目的第一等抽象是计划文档。用 generic step 在 Mastra 上模拟动态计划**走得通**，但那等于把内核在框架内部重写一遍——不可移植、不可单测、不可跨领域复用。**能做 ≠ 该做。**

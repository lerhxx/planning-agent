# planning-agent

**目标驱动的规划型 Agent 基座**。用户给目标 → 产出可见可编辑的计划 → 逐步执行 → 动态重规划。领域通过 Domain Pack 接入，内核零改动。

> 本仓库**只含基座**，不含任何具体领域实现。

---

## 开工前必读（按需要读，不要一次全塞）

| 文件 | 什么时候读 |
|---|---|
| `docs/ARCHITECTURE.md` | 动手写代码前 —— 分层、目录、契约在哪 |
| `docs/CONSTRAINTS.md` | 写任何代码前 —— 完整规则与红线 |
| `docs/PRD.md` | 需求或验收有疑问时 —— 目标、交互契约、需求池 |

> `techDocs/**` 是**给人看**的技术文档（架构论证、契约参考、面试亮点），**不要**整包塞进 context，按需单篇读。

---

## 绝对红线（违反一条就算架构破了）

### 工程
1. 类型唯一真源是 **zod schema**，用 `z.infer` 推导；禁止手写两份类型
2. 所有来自模型/网络的 JSON 必须 `safeParse`，失败降级 `RawPayloadCard`，**绝不白屏**
3. 禁止 `ai/rsc` 与 `streamUI`（官方标注 experimental）
4. 禁止 Server Actions；页面与组件一律 `'use client'`
5. 业务代码禁止 `import '@mastra/*'`（只允许 `src/core/runtime/mastra/**` 内部）
6. 禁止硬编码模型名（走 `models.ts`）
7. 流式增量用 JSON Patch `/items/-`，禁止整包重发 props

### ★ 内核 / 领域包（本项目命根子）
8. `src/core/**` 与 `shared/**` 中**禁止出现任何领域词**
9. 内核**只消费** `validate()` 的 `ok` 与 `violations[].severity`；禁止读/分支 `.code` `.message` `.suggestion` `.evidence`
10. 触发码必须是内核通用码 `PROVIDER_VALIDATION_FAILED`，禁止领域专有码
11. 领域自由挂载点 `RunContext.meta`（`Record<string, unknown>`，即设计稿里的 `domainExtras`）**内核不可读**（只在写入侧 parse）
12. `PlanCompiler` 必须是**纯函数**（可单测、含环检测），不得放在 runtime 目录
13. 内核只依赖 `RuntimeAdapter` 接口，不依赖具体实现
14. 重规划后**已完成 step 的 id 不得改变**（天然幂等键）
15. 重规划必须有三重闸门（次数 ≤5 / 成本 ≤¥2 / 时长 ≤25s）与收敛判定（delta < 0.15 强制转人工）

### 反幻觉
16. 事实数据（价格/评分/工时/数值）**只能来自 Provider**，模型不得编造

---

## 目录

```
src/core/**       领域无关：goal / planning / execution / replan / compiler / degrade / registry / runtime
src/domains/**    领域包；index.ts = 服务端桶，ui.ts = 客户端桶（生产代码对领域的引用点只有 2 处）
                  demo/ 是**验证装置**（证明闭环能跑），不是产品领域
src/components/generative-ui/**   通用组件注册表 + 兜底组件
shared/**         zod schema → z.infer，前后端唯一真源
app/api/**        服务端代码唯一入口
```

---

## 改动流程

**写之前**：确认改动落在哪一层（core / domains / ui / runtime）。落在 core 却需要知道领域细节 → 抽象破了，先问，不要硬写。

**写之后**必须跑并贴出结果：

```bash
npm run typecheck && npm run lint && npm test
grep -rnE "<领域词>" src/core shared | wc -l                 # → 0
grep -rn "\.code\|\.evidence\|\.suggestion" src/core | wc -l # → 0
rm -rf src/domains/<x> && npm run build                     # → 通过
```

---

## 不确定时

**不要猜。** 这个项目的大多数决策都有明确理由，猜错的代价比问一句高得多。遇到以下情况先确认：
- 不确定某段代码该放 core 还是 domains
- 想加一个新的内核字段（先确认它会被 ≥2 个领域用到，否则是过度抽象）
- 想引入新依赖（先确认它不威胁 Cloudflare 镜像方案）

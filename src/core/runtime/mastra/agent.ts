/**
 * Mastra Agent 封装 —— 规划 / 重规划两个方法走模型。
 *
 * ★ 为什么单独抽一层接口（`Planner`）：
 *   测试必须**零网络、零 API Key**（与 `MockRuntime` 同一纪律，
 *   见 `src/core/runtime/mock/index.ts:5`）。所以 `createMastraRuntime`
 *   接受注入的 `Planner`；生产用 `createMastraPlanner`，测试传假实现。
 *   这不是为了"解耦好看"，而是因为本环境根本连不上模型端点，
 *   走真模型的测试永远是红的或永远超时。
 *
 * ★ 为什么不用 Mastra 的 Workflow：
 *   见 `techDocs/v3/01-架构设计-v3.md` §2.2。本仓的续跑是"客户端回传不可信快照"，
 *   与 Mastra suspend/resume 的"服务端持有可信状态"信任模型相反。
 */
import { Agent } from '@mastra/core/agent';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { PlanRequest, ReplanRequest } from '@/src/core/runtime/adapter';
import { planSystemPrompt, replanSystemPrompt } from './prompts';

/**
 * 规划器抽象。
 *
 * 返回 `unknown` 是**刻意的**：模型产出在本层是不透明的，
 * 校验统一由 `parse.ts` 用 zod 兜住（红线 2）。
 * 若这里直接声明返回 `PlanDraft`，就会给人"模型输出可信"的错觉。
 */
export interface Planner {
  plan(request: PlanRequest): Promise<unknown>;
  replan(request: ReplanRequest): Promise<unknown>;
}

/**
 * 从 `generate` 的返回值里取出模型产出的规划 JSON。
 *
 * ★ 为什么不再依赖 `structuredOutput`（json_schema 结构化输出）：
 *   DeepSeek 等 OpenAI 兼容端点的 `/chat/completions` **不支持**
 *   `response_format: { type: "json_schema" }`（只支持 `json_object` 或纯文本），
 *   传 json_schema 会直接 400：
 *   "This response_format type is unavailable now"。
 *   所以这里统一改成"prompt 要求输出 JSON + 在 parse.ts 用 zod 兜底校验"，
 *   任何 OpenAI 兼容 provider 都能跑。
 *
 * ★ 取值优先级：
 *   1. `result.object` —— 若将来重新启用结构化输出，优先用已解析对象；
 *   2. 否则从 `result.text` 里抠 JSON（处理代码围栏、前后散文包裹）。
 *
 * 红线 2：模型产出不可信，真正的 schema 校验在 `parse.ts`，这里只负责"把文本变成对象"。
 */
export function extractPlanJson(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;

  // ① 结构化输出（若将来重新启用）优先用已解析对象
  const structured = record['object'];
  if (structured !== undefined && structured !== null) return structured;

  // ② 否则从文本里抠 JSON
  const text = typeof record['text'] === 'string' ? record['text'] : undefined;
  if (text === undefined) return undefined;
  return parseJsonLoose(text);
}

/** 把可能带代码围栏 / 散文包裹的模型文本松解析成 JSON；全部失败返回 undefined。 */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  // ① 剥 ```json ... ``` / ``` ... ``` 围栏
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());

  // ② 取第一个 { 到最后一个 } 之间的内容（容忍前后散文）
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 试下一个候选
    }
  }
  return undefined;
}

/** 用真实模型构造规划器。 */
export function createMastraPlanner(model: OpenAICompatibleConfig): Planner {
  const agent = new Agent({
    id: 'planner',
    name: 'planner',
    description: '把一个目标拆解成有序、可执行的步骤。',
    instructions:
      '你是一个规划器。你只输出严格符合给定 JSON 结构的结果，不输出解释性文字。',
    model,
  });

  async function ask(systemPrompt: string): Promise<unknown> {
    const result = await agent.generate([{ role: 'user', content: systemPrompt }], { model });
    return extractPlanJson(result);
  }

  return {
    plan: (request) => ask(planSystemPrompt(request)),
    replan: (request) => ask(replanSystemPrompt(request)),
  };
}

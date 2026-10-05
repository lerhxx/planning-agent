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
import {
  zPlanDraft,
  type PlanRequest,
  type ReplanRequest,
} from '@/src/core/runtime/adapter';
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
 * 从 `generate` 的返回值里取出结构化结果。
 *
 * `FullOutput<OUTPUT>` 把结构化结果放在 `object` 字段
 * （`node_modules/@mastra/core/dist/stream/base/output.d.ts` 的
 * `PromiseResults<OUTPUT>['object']`）。
 *
 * ★ 为什么要用"多个候选字段依次尝试"而不是直接 `.object`：
 *   不同版本 / 不同 structuredOutput 形态下承载字段可能不同。
 *   全部取不到时返回 `undefined`，由 `parse.ts` 判为校验失败 ——
 *   **绝不返回半成品**，也绝不静默当成空计划。
 */
function extractStructured(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ['object', 'structuredOutput', 'experimental_output']) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
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
    const result = await agent.generate([{ role: 'user', content: systemPrompt }], {
      /*
       * `structuredOutput` 是**对象**而不是裸 schema：
       * `PublicStructuredOutputOptions<OUTPUT> = StructuredOutputOptionsBase<OUTPUT> & { schema: PublicSchema<OUTPUT> }`
       * （`node_modules/@mastra/core/dist/agent/types.d.ts:493`）。
       * 传裸 zod schema 会被类型系统拒绝。
       */
      structuredOutput: { schema: zPlanDraft },
      model,
    });
    return extractStructured(result);
  }

  return {
    plan: (request) => ask(planSystemPrompt(request)),
    replan: (request) => ask(replanSystemPrompt(request)),
  };
}

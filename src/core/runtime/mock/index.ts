/**
 * MockRuntime —— `RuntimeAdapter` 的第一个实现（C0-10）。
 *
 * ★ 关键决策：**连模型也 mock**。规划/重规划/工具全部走脚本化 fixtures，
 * 因此 `npm run dev` 立刻能跑通闭环，**不需要任何 API Key、不发一个网络请求**。
 * 真实模型接入放到 MastraRuntime（M2 之后），内核一行不改。
 */
import type { RunContext } from '@/shared/run/types';
import type {
  PlanDraft,
  PlanRequest,
  ReplanRequest,
  RuntimeAdapter,
  ToolCall,
  ToolOutcome,
} from '@/src/core/runtime/adapter';
import {
  createDefaultMockScript,
  defaultMockScript,
  type MockReplanMode,
  type MockScript,
  type MockScriptOptions,
} from './script';

export interface MockRuntimeOptions {
  script?: MockScript;
  /** 传给默认脚本的重排模式（仅 `script` 未指定时生效）。 */
  replanMode?: MockReplanMode;
  /** 模拟模型思考的延迟（ms），让流式效果可见。 */
  latencyMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_LATENCY_MS = 120;
const DEFAULT_SLEEP = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 创建一个 MockRuntime。
 *
 * 所有返回值在交回内核前都会过一遍 zod（`zPlanDraft` / `zToolResultBase`），
 * 与真实模型返回走同一条"不可信输入"的校验路径。
 */
export function createMockRuntime(options: MockRuntimeOptions = {}): RuntimeAdapter {
  // 默认用工厂创建一个**独立**脚本实例：故障注入状态不跨 run 泄漏。
  const script =
    options.script ??
    createDefaultMockScript({
      ...(options.replanMode ? { replanMode: options.replanMode } satisfies MockScriptOptions : {}),
    });
  const latencyMs = options.latencyMs ?? DEFAULT_LATENCY_MS;
  const sleep = options.sleep ?? DEFAULT_SLEEP;

  return {
    id: 'mock',

    async plan(request: PlanRequest, ctx: RunContext): Promise<PlanDraft> {
      await sleep(latencyMs);
      return script.plan(request, ctx);
    },

    async replan(request: ReplanRequest, ctx: RunContext): Promise<PlanDraft> {
      await sleep(latencyMs);
      return script.replan(request, ctx);
    },

    async runTool(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      await sleep(Math.min(latencyMs, 60));
      return script.tool(call, ctx);
    },
  };
}

export { createDefaultMockScript, defaultMockScript };
export type { MockReplanMode, MockScript, MockScriptOptions };

/**
 * Runtime 工厂 —— 按**显式选择**返回 runtime，**不做隐式回退**。
 *
 * ★ 为什么不自动降级到 Mock（设计稿 §7 展开）：
 *   Mock 的重规划是脚本化的，与真模型行为差异很大。悄悄退回脚本，
 *   会让"这一轮结果是模型想的还是脚本想的"变得不可知 —— **那比直接失败更糟**。
 *   真模型失败时用户该看到明确的错误并重试，而不是一个来源不明的结果。
 *
 * ★ 选择优先级（显式 > 环境变量 > 默认 mock）：
 *   1. 调用方显式传 `preferReal`（端点解析请求参数得到）；
 *   2. 否则读环境变量 `RUNTIME_ADAPTER`（`mastra` = 真模型，其余 = mock）；
 *   3. 缺省 `mock` —— 保持"零配置可跑通闭环"的既有行为不变。
 *
 * 本文件位于 `src/core/**`：禁止出现任何领域词。
 * 它**不 import** `@mastra/*`（真正的 Mastra 符号在 `mastra/index.ts` 内部），
 * 因此红线 5 的边界守卫不会因为新增这个文件而破功。
 */
import type { RuntimeAdapter } from '@/src/core/runtime/adapter';
import { createMockRuntime, type MockReplanMode } from '@/src/core/runtime/mock';
import { createMastraRuntime, type MastraRuntimeOptions } from '@/src/core/runtime/mastra';

export interface CreateRuntimeOptions {
  /**
   * 显式要求真模型。`true` 时缺配置会**抛错**（`MissingModelConfigError`），
   * 不会退回 Mock。`false` 时无条件返回 MockRuntime。
   */
  preferReal?: boolean;
  /** 透传给 MastraRuntime（测试注入假 planner，实现零网络零密钥）。 */
  mastra?: MastraRuntimeOptions;
  /** MockRuntime 的延迟（毫秒），仅 `preferReal` 为假时生效。 */
  mockLatencyMs?: number;
  /**
   * MockRuntime 的重排模式（仅 mock 生效）。
   *
   * 这是**调试旋钮**：`stagnant` 用来触发内核的 NO_CONVERGENCE 闸门。
   * 真模型没有"原样重发"这种行为，所以这个参数在 `preferReal` 时被忽略 ——
   * 顺带也是一道防线：真模型路径不可能被"假装原地打转"。
   */
  mockReplanMode?: MockReplanMode;
}

/** 读环境变量里的选择；未设置或不是 `mastra` 一律视为 mock。 */
function preferRealFromEnv(): boolean {
  return process.env['RUNTIME_ADAPTER'] === 'mastra';
}

export function createRuntime(options: CreateRuntimeOptions = {}): RuntimeAdapter {
  const preferReal = options.preferReal ?? preferRealFromEnv();

  if (!preferReal) {
    return createMockRuntime({
      latencyMs: options.mockLatencyMs ?? 120,
      // 有才传：undefined 会让 createMockRuntime 用自己的默认值
      ...(options.mockReplanMode ? { replanMode: options.mockReplanMode } : {}),
    });
  }

  // 显式要求真模型：这里不 catch，缺配置必须炸给调用方看。
  return createMastraRuntime(options.mastra ?? {});
}

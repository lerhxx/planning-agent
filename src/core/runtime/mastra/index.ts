/**
 * MastraRuntime —— `RuntimeAdapter` 的第二个实现（方案 A）。
 *
 * 兑现 `src/core/runtime/adapter.ts:5` 的原注释：
 * > 将来的 `MastraRuntime` 必须实现同一个接口，内核一行不改。
 *
 * 本文件是**唯一**允许 `import '@mastra/*'` 的地方之一（红线 5），
 * 且只在 `src/core/runtime/mastra/**` 目录内（由 `boundary.test.ts` 自动守卫）。
 *
 * ★ 与编排层的关系：编排（批次推进、重试、重规划、HITL 续跑）**不在这里**，
 *   仍由 `src/core/run/engine.ts` 用内核通用码实现。理由见
 *   `techDocs/v3/01-架构设计-v3.md` §2.2：框架自带的重试与 suspend/resume
 *   会绕过内核闸门，或与"客户端持有不可信快照"的信任模型冲突。
 *
 * ★ 不实现故障注入：`simulate` / `replanMode` 是 MockRuntime 的调试旋钮
 *   （见 `shared/run/types.ts:50`）。真模型跑故障注入没有意义 ——
 *   要验证闸门请用 MockRuntime。
 */
import { createTool, noopObserve } from '@mastra/core/tools';
import { getTool, getToolBriefs } from '@/src/core/registry/domainRegistry';
import type {
  PlanDraft,
  PlanRequest,
  ReplanRequest,
  RuntimeAdapter,
  ToolCall,
  ToolOutcome,
} from '@/src/core/runtime/adapter';
import type { RunContext } from '@/shared/run/types';
import { createMastraPlanner, type Planner } from './agent';
import { parsePlanDraft, parseToolResult, toolFailure } from './parse';
import { textModel } from './models';
import { createTextClassifier } from './classifier';

export { createTextClassifier };

/** 规划 / 重规划的产出没通过 schema 校验。路由会把它转成可见的 RUN_ERROR。 */
export class MastraOutputError extends Error {
  /** 内核白名单错误码，供上层分支使用。 */
  readonly code: string;

  constructor(message: string, code = 'PLAN_GENERATION_FAILED') {
    super(message);
    this.name = 'MastraOutputError';
    this.code = code;
  }
}

export interface MastraRuntimeOptions {
  /**
   * 注入规划器。**测试用假实现，生产留空**。
   *
   * 为什么要留这个口：本仓测试纪律是"零网络、零 API Key"
   * （`src/core/runtime/mock/index.ts:5`），而模型端点在 CI / 本环境都连不上。
   */
  planner?: Planner;
}

/**
 * 创建一个 Mastra 驱动的 runtime。
 *
 * ★ 缺模型配置时**抛错**（`MissingModelConfigError`），不退回 Mock ——
 *   悄悄退回脚本数据、让用户以为在跑真模型，是欺骗性降级。
 */
export function createMastraRuntime(options: MastraRuntimeOptions = {}): RuntimeAdapter {
  /*
   * 建模时机放在这里（而非模块顶层）：`models.ts` 的 `requireEnv` 会在
   * 缺配置时抛错，而导入模块就执行顶层代码会让**整个进程**在任何地方
   * import 这个文件时炸掉——包括只想用 `parse.ts` 的测试。
   */
  const planner = options.planner ?? createMastraPlanner(textModel());

  async function draft(
    run: () => Promise<unknown>,
    ctx: RunContext,
  ): Promise<PlanDraft> {
    const startedAt = Date.now();
    const parsed = parsePlanDraft(await run(), ctx, Date.now() - startedAt);
    if (!parsed.ok) {
      /*
       * 这里**选择抛错而不是返回一个坏草稿**，是刻意的：
       * `RuntimeAdapter.plan` 的契约是"返回一个已通过校验的 PlanDraft"。
       * 返回未校验数据会让契约变成"有时有效"，那正是本仓最忌讳的静默失效形态。
       * 抛出后由 `app/api` 下两个 route 的 catch 转成 `RUN_ERROR`（可见），
       * 而 `planner.ts:66` 的 `safeParse` 仍作为第二道防线独立存在。
       */
      throw new MastraOutputError(
        parsed.outcome.error?.message ?? '模型返回的计划未通过校验',
        'PLAN_GENERATION_FAILED',
      );
    }
    return parsed.draft;
  }

  return {
    id: 'mastra',

    /*
     * ★ 两个方法都在这里**补齐工具清单**（`{ ...request, tools: … }`），而不是只靠调用方传。
     *
     * 理由：prompt 的硬性约束要求模型"只能用清单里的 toolName"，而清单此前
     * 既不在请求里、也没被渲染 —— 模型只能猜，猜错就撞上`工具未在当前领域注册`。
     * 只在 `createPlan` 里装配是不够的：**重排请求是由编排层 `src/core/run/engine.ts`
     * 直接组装的**，那条路径不经过 `createPlan`。若只补 plan 不补 replan，
     * 重排 prompt 就会拿到空清单，而空清单会被渲染成"所有 intent 必须为 null"——
     * 那比原bug 更糟（模型被明确指示放弃工具调用）。
     *
     * `RunContext.domainId` 在这里可信（内核自己填的），所以就地按它取清单，
     * 与 `runTool` 用 `ctx.domainId` 查工具是同一个领域口径。
     * 覆盖而不是"仅在为空时填"：调用方若传了**过期或别处**的清单，
     * 静默沿用它等于把同一个 bug 换个入口再犯一次。
     */
    plan: (request: PlanRequest, ctx: RunContext): Promise<PlanDraft> =>
      draft(() => planner.plan({ ...request, tools: getToolBriefs(ctx.domainId) }), ctx),

    replan: (request: ReplanRequest, ctx: RunContext): Promise<PlanDraft> =>
      draft(() => planner.replan({ ...request, tools: getToolBriefs(ctx.domainId) }), ctx),

    /**
     * 执行单个领域工具。
     *
     * 用 `createTool` 把领域的 `ToolSpec` 包成 Mastra 工具，让它进入 Mastra 的
     * 工具体系（描述、schema、execute 契约都是框架标准形状）。
     * **工具实现仍然属于领域包**（`tool.execute`），内核与框架都不碰语义。
     *
     * ★ 关于"输入校验"要说准确：Mastra 只在**它自己**通过 Agent 调用工具时才会
     *   套用 `inputSchema`；这里是直接调 `mastraTool.execute()`，**不经过那条校验**。
     *   所以真正的校验是下面第 115-117 行**我们自己**的 `safeParse`。
     *   写注释时不能把这两件事混为一谈 —— 那会让人以为"框架替我兜住了输入"，
     *   进而把本地那行 `safeParse` 删掉，那就是标准的静默失效。
     */
    async runTool(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const tool = getTool(ctx.domainId, call.toolName);
      if (!tool) {
        return toolFailure('TOOL_FAILED', '工具未在当前领域注册', false, ctx);
      }

      const startedAt = Date.now();
      // 输入不可信（红线 2）：先过领域自己的 inputSchema；失败则用原始输入兜底。
      const parsedInput = tool.inputSchema.safeParse(call.input);
      const input = parsedInput.success ? parsedInput.data : call.input;

      const mastraTool = createTool({
        id: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (inputData: unknown) => tool.execute(inputData as never, ctx),
      });

      if (!mastraTool.execute) {
        return toolFailure('INTERNAL_ERROR', 'Mastra 工具未提供 execute', false, ctx);
      }

      try {
        const result = await mastraTool.execute(input as never, {
          /*
           * 第二参数 `ToolExecuteContext` 里只有 `observe` 是必填的
           * （`ToolExecutionContext` 继承 `Partial<ObservabilityContext>`，其余字段全可选，
           * 见 `node_modules/@mastra/core/dist/tools/types.d.ts`）。
           * 本仓的工具实现自己闭包捕获了 `ctx`，不依赖这里的任何其他字段，
           * 所以用 Mastra 自带的 `noopObserve` 满足签名即可 ——
           * 不要为了"看起来完整"编造字段名，那只会骗过类型检查、骗不过运行期。
           */
          observe: noopObserve,
        });
        return parseToolResult(result, ctx, Date.now() - startedAt);
      } catch (error) {
        return toolFailure(
          'TOOL_FAILED',
          error instanceof Error ? error.message : '工具执行抛出异常',
          tool.retryable,
          ctx,
          Date.now() - startedAt,
        );
      }
    },
  };
}

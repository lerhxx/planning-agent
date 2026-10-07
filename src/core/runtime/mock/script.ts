/**
 * MockRuntime 的脚本化 fixtures —— **零网络、零 API Key**，连"模型输出"也是脚本。
 *
 * ★ 领域无关的设计原则：
 * - `plan()` **回放领域声明的模板**（`planning.templates`），而不是在内核里写死任何领域步骤；
 * - `replan()` 只做通用的"替换受影响子树"，标题一律由领域的 `stepTypes[].label`
 *   拼出来（或干脆原样保留）—— 内核不认识这些 label 是什么；
 * - `tool()` 先做故障注入，再把调用委托给领域注册的 ToolSpec（事实数据由 Provider 提供）。
 *
 * 因此本文件中**不出现任何领域词**。
 */
import {
  makeReplanStepId,
  makeStepId,
  zClarifyQuestion,
  type StepDraft,
} from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import type {
  PlanDraft,
  PlanRequest,
  ReplanRequest,
  ToolCall,
  ToolOutcome,
} from '@/src/core/runtime/adapter';
import { getTool } from '@/src/core/registry/domainRegistry';

export interface MockScript {
  plan(request: PlanRequest, ctx: RunContext): PlanDraft | Promise<PlanDraft>;
  replan(request: ReplanRequest, ctx: RunContext): PlanDraft | Promise<PlanDraft>;
  tool(call: ToolCall, ctx: RunContext): ToolOutcome | Promise<ToolOutcome>;
}

/**
 * 脚本化"模型"的重排行为（**唯一**影响 delta 的旋钮）。
 *
 * | 模式       | 行为                                   | delta | 用途                     |
 * |------------|----------------------------------------|-------|--------------------------|
 * | `stagnant` | 原样重发受影响步骤（标题不变）          | 0     | 验证 NO_CONVERGENCE 闸门 |
 * | `diverge`  | 受影响步骤按领域 stepType label 重新命名 | 1     | 验证"重排后继续跑完"     |
 *
 * ★ 这里**不再**偷偷多追加一步来把 delta 抬过阈值 —— 那样会掩盖收敛判定的 bug。
 * 差异必须是显式的、可切换的、可被测试证伪的。
 */
export type MockReplanMode = 'stagnant' | 'diverge';

export interface MockScriptOptions {
  /** 默认 `diverge`：脚本化模型"想出了新方案"，闭环能继续跑完。 */
  replanMode?: MockReplanMode;
}

interface MockScriptState {
  /** `fatal` 整轮只注入一次：否则重排后的新步骤会再次失败，永远收敛不了。 */
  fatalInjected: boolean;
}

function fail(
  code: string,
  message: string,
  retryable: boolean,
  ctx: RunContext,
  durationMs = 0,
): ToolOutcome {
  return {
    ok: false,
    sourceRefs: [],
    isEstimate: false,
    durationMs,
    error: { code, message, retryable, traceId: ctx.traceId },
  };
}

/** 故障注入开关：从 RunContext.meta 读取（内核不解析其语义，只做字符串匹配）。 */
function simulateMode(ctx: RunContext): string {
  const value = ctx.meta['simulate'];
  return typeof value === 'string' ? value : 'none';
}

/** 用户是否已回答过某一步的澄清问题（M1：澄清 = 带答案重跑）。 */
function readAnswer(ctx: RunContext, stepId: string): string | undefined {
  const answers = ctx.meta['answers'];
  if (answers === null || typeof answers !== 'object') return undefined;
  const value = (answers as Record<string, unknown>)[`clarify:tool:${stepId}`];
  return typeof value === 'string' ? value : undefined;
}

/** 规划：优先回放领域声明的模板。 */
function planDraft(request: PlanRequest): PlanDraft {
  const template = request.templates[0];
  if (template) {
    // ★ 这里**原样回放**模板的 `intent`，一个字都不改。
    // 目标摘要（`intent.input.goalSummary`）由内核在建计划时统一注入 ——
    // 见 `src/core/planning/planner.ts` 的 `injectGoalSummary`。
    // 本文件曾经顺手注入过一次，那是"只有 Mock 满足的隐性契约"：
    // 它替内核兜了底，把真模型路径上的缺口一直遮着，直到真模型返回的入参缺摘要才暴露。
    return {
      summary: `按领域模板生成 ${template.steps.length} 个步骤`,
      steps: template.steps.map((step) => ({
        ...step,
        dependsOn: step.dependsOn.slice(),
        intent: step.intent ? { ...step.intent, input: { ...step.intent.input } } : null,
      })),
    };
  }

  // 兜底：每个声明过的 stepType 一步，线性串联（纯推理，不调工具）。
  const steps: StepDraft[] = request.stepTypes.map((descriptor, index) => ({
    id: makeStepId(index),
    type: descriptor.type,
    title: descriptor.label,
    dependsOn: index === 0 ? [] : [makeStepId(index - 1)],
    intent: null,
  }));
  return { summary: '按步骤类型线性生成', steps };
}

/**
 * 重规划：替换受影响子树。
 *
 * ★ 只重写受影响的那几步，不做任何"为了让 delta 变大"的额外加工。
 */
function replanDraft(request: ReplanRequest, mode: MockReplanMode): PlanDraft {
  const impacted = request.impactedSteps;
  const revision = request.revision;
  const idMap = new Map<string, string>();
  impacted.forEach((step, index) => {
    idMap.set(step.id, makeReplanStepId(revision, index));
  });

  const rewritten: StepDraft[] = impacted.map((step, index) => {
    const label = request.stepTypes.find((descriptor) => descriptor.type === step.type)?.label;
    // diverge：按领域声明的 label 重新命名（脚本化模型"换了方案"）。
    // stagnant：连标题都不动 —— 这正是"模型没想出新方案"的情形，收敛闸门必须拦住它。
    const title =
      mode === 'diverge' ? `${label ?? step.type} · 重排 ${revision}` : step.title;
    return {
      id: idMap.get(step.id) ?? makeReplanStepId(revision, index),
      type: step.type,
      title,
      description: step.description,
      // 依赖重写：被替换的依赖指向新 id；被保留的依赖（含已完成步骤）原样保留。
      dependsOn: step.dependsOn.map((dep) => idMap.get(dep) ?? dep),
      parallelGroup: step.parallelGroup,
      intent: step.intent ?? null,
      estimate: step.estimate,
      renderAs: step.renderAs,
    };
  });

  return {
    summary: `重排 ${impacted.length} 个步骤（${mode === 'diverge' ? '换方案' : '原样重发'}）`,
    steps: rewritten,
  };
}

/** 工具调用：故障注入 → 委托领域 ToolSpec。 */
async function toolCall(
  call: ToolCall,
  ctx: RunContext,
  state: MockScriptState,
): Promise<ToolOutcome> {
  const mode = simulateMode(ctx);

  // ① 可重试失败：第一次尝试失败，重试即成功（用于观察 retry-step 路径）
  if (mode === 'retryable' && call.attempt <= 1) {
    return fail('TOOL_FAILED', '注入的可重试失败（第一次尝试）', true, ctx, 30);
  }

  // ② 不可恢复失败：整轮只注入一次（用于观察 local-subtree 重规划）
  if (mode === 'fatal' && !state.fatalInjected) {
    state.fatalInjected = true;
    return fail('TOOL_FAILED', '注入的不可恢复失败', false, ctx, 30);
  }

  // ③ 信息不足：下发澄清问题；带答案重跑时自动放行
  if (mode === 'clarify' && !readAnswer(ctx, call.stepId)) {
    return {
      ok: false,
      sourceRefs: [],
      isEstimate: false,
      durationMs: 20,
      needsClarification: true,
      question: zClarifyQuestion.parse({
        id: `clarify:tool:${call.stepId}`,
        prompt: '这一步缺少必要信息，选一个继续？',
        options: [
          { id: 'opt-a', label: '采用候选 A', description: '按默认口径继续' },
          { id: 'opt-b', label: '采用候选 B', description: '换一种口径继续' },
        ],
        multi: false,
      }),
    };
  }

  const tool = getTool(ctx.domainId, call.toolName);
  if (!tool) {
    return fail('TOOL_FAILED', '工具未注册', false, ctx, 0);
  }

  const startedAt = Date.now();
  // 输入同样是不可信的：先过工具的 zod inputSchema，失败则用原始输入兜底。
  const parsed = tool.inputSchema.safeParse(call.input);
  const input = parsed.success ? parsed.data : call.input;

  try {
    const result = await tool.execute(input as never, ctx);
    return {
      ...result,
      durationMs: result.durationMs || Date.now() - startedAt,
    };
  } catch (error) {
    return fail(
      'TOOL_FAILED',
      error instanceof Error ? error.message : '工具执行异常',
      tool.retryable,
      ctx,
      Date.now() - startedAt,
    );
  }
}

/**
 * 创建默认脚本实例。
 *
 * 用**工厂**而不是共享常量：故障注入需要"整轮只注入一次"的状态，
 * 多个 run 之间必须互相隔离。
 */
export function createDefaultMockScript(options: MockScriptOptions = {}): MockScript {
  const state: MockScriptState = { fatalInjected: false };
  const mode: MockReplanMode = options.replanMode ?? 'diverge';
  return {
    plan: (request) => planDraft(request),
    replan: (request) => replanDraft(request, mode),
    tool: (call, ctx) => toolCall(call, ctx, state),
  };
}

/** 共享实例：仅用于「一次 run 跑完即结束」的场景（如单测）。 */
export const defaultMockScript: MockScript = createDefaultMockScript();

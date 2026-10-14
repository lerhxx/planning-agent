/**
 * 编排引擎 —— 把「Goal → 计划 → 执行 → 重规划」串成一轮闭环（M1 验收项）。
 *
 * 领域无关：只调 `src/core/**` 的纯函数与 `RuntimeAdapter`，不认识任何领域语义。
 * 所有对 UI 的输出都通过 `emit(StreamEvent)` 下发，因此同一份内核可以接任意传输层。
 *
 * 失败路径优先：每一步都有兜底 —— 计划生成失败 / 编译失败 / 闸门拦截 / 不收敛
 * 都会落到 `ErrorState` 组件，并下发 `done(failed)`，**绝不白屏**。
 */
import {
  type Attachment,
  type EditCommand,
  type Plan,
  type Step,
} from '@/shared/plan/types';
import {
  type RunContext,
  type RunTerminalStatus,
} from '@/shared/run/types';
import type { StreamEvent } from '@/shared/stream/events';
import { compilePlan } from '@/src/core/compiler/planCompiler';
import { executeStep } from '@/src/core/execution/executor';
import type { Observation } from '@/src/core/execution/observer';
import { createRunEvents } from './runEvents';
import { applyReplanOutcome, doReplan, type ReplanEnv, type RunSession } from './replanCoordinator';
import { runExecutionLoop } from './executionLoop';
import { prepareRun } from './prepareRun';
import { highestSeverity, validatePlan, validateStep } from '@/src/core/planning/validate';
import { type ReplanBudget } from '@/src/core/replan/gates';
import { decideValidationAction } from '@/src/core/replan/policy';
import type { RuntimeAdapter } from '@/src/core/runtime/adapter';

export interface EngineInput {
  goal: string;
  domainId?: string;
  /** 故障注入：none | retryable | fatal | clarify。 */
  simulate?: string;
  requireConstraints?: boolean;
  answers?: Record<string, string>;
  /** 本轮输入附件（引用优先：只带描述符，字节由上传接口先落地）。 */
  attachments?: Attachment[];
  /** 续跑：上一次的 plan 快照（来自客户端，**不可信**）。 */
  resumePlan?: Plan | null;
  /** 续跑前要应用的编辑命令（只在 run 终态生效）。 */
  edit?: EditCommand | null;
}

export interface EngineDeps {
  runtime: RuntimeAdapter;
  emit: (event: StreamEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  /** 中断信号（来自 HTTP 请求的 AbortSignal）。 */
  signal?: { readonly aborted: boolean };
  now?: () => Date;
  streamDelayMs?: number;
}

export interface EngineResult {
  status: RunTerminalStatus;
  plan: Plan | null;
  traceId: string;
  reason?: string;
}

const NOOP_SLEEP = async (): Promise<void> => undefined;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function replaceStep(plan: Plan, next: Step): Plan {
  return { ...plan, steps: plan.steps.map((step) => (step.id === next.id ? next : step)) };
}

/**
 * 续跑计划解析已抽到 `./resume.ts`；这里重新导出以保持向后兼容
 * （若有调用方直接从 `engine.ts` 引用 `resumePlan`，无需改动）。
 */
export { resumePlan } from './resume';

/**
 * 跑完一轮：Goal → Plan → 执行 →（必要时）重规划 → 终态。
 */
export async function runGoal(input: EngineInput, deps: EngineDeps): Promise<EngineResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? NOOP_SLEEP;
  /**
   * ★ 整轮开始的时刻 —— **只用于记账，不用于时长闸门**。
   * 见下面 `planReadyMs` 的注释：闸门度量的是"计划产出之后还剩多少可用时间"。
   */
  const startedMs = now().getTime();

  const runId = makeId('run');
  const traceId = makeId('trace');

  /** 事件出口：组件事件、终态事件与失败收尾统一收敛到 `runEvents.ts`。 */
  const events = createRunEvents({ emit: deps.emit, sleep, traceId });

  /* ---------------- 1+2. 准备阶段：目标解析/澄清、RunContext、计划创建或恢复（已抽到 prepareRun.ts） ---------------- */

  const prepared = await prepareRun({ input, deps, now, sleep, events, runId, traceId, startedMs });
  if (prepared.kind === 'early_exit') return prepared.result;
  const { goal, domainId, planReadyMs } = prepared;
  let plan: Plan = prepared.plan;
  let ctx: RunContext = prepared.ctx;
  const budget: ReplanBudget = prepared.budget;

  /**
   * 一轮 run 内共享的可变状态。用 getter/setter 把 `let plan` / `let ctx` 与本 session
   * 对象绑定，使抽出的 `replanCoordinator` / 即将抽出的 `executionLoop` / `prepareRun`
   * 能直接读写同一份状态，而不必把整个 `runGoal` 改写成 `session.plan = ...`。
   *
   * ★ 克制原则：只放确实跨阶段共享的 `plan` / `ctx` / 重规划预算，不放其他字段。
   */
  const session: RunSession = {
    get plan() {
      return plan;
    },
    set plan(value: Plan) {
      plan = value;
    },
    get ctx() {
      return ctx;
    },
    set ctx(value: RunContext) {
      ctx = value;
    },
    budget,
  };

  /** 重规划协调器运行所需的外部依赖。 */
  const replanEnv: ReplanEnv = {
    runtime: deps.runtime,
    emit: deps.emit,
    now,
    goal,
    domainId,
    runId,
  };

  const execDeps = () => ({
    runtime: deps.runtime,
    emit: deps.emit,
    domainId,
    planId: plan.id,
    sleep,
    now,
    streamDelayMs: deps.streamDelayMs,
  });

  /**
   * 校验当前计划（PRD §7.1）。
   *
   * ★ 内核只取 `ok` 与最高 `severity` 两个信号：
   * 不读 `.code` / `.message` / `.suggestion` / `.evidence`，也不对它们做分支（红线 8）。
   */
  const validateCurrent = async (
    target: Plan,
  ): Promise<{ ok: boolean; severity: 'error' | 'warning' | null }> => {
    const result = await validatePlan(target, ctx);
    return { ok: result.ok, severity: highestSeverity(result) };
  };

  /** 执行一步（含重试循环）；直接更新外层的 `plan`。 */
  const runStep = async (stepId: string): Promise<Observation> => {
    let current = plan.steps.find((step) => step.id === stepId);
    if (!current) return { kind: 'fail', stepId };
    for (;;) {
      const result = await executeStep(current, ctx, execDeps());
      plan = replaceStep(plan, result.step);
      budget.costCNY += result.step.estimate?.costCNY ?? 0.01;
      current = result.step;
      if (result.observation.kind === 'retry' && current.attempt < current.maxAttempts) {
        await sleep(150);
        continue;
      }
      return result.observation;
    }
  };

  /**
   * 校验不通过且无法自动修复 → **转人工**（下发 ClarifyOptions，绝不白屏）。
   * 只给通用选项：内核不知道"该怎么改"是领域的事。
   */
  const askUserForValidation = async (prompt: string): Promise<EngineResult> => {
    plan = { ...plan, status: 'paused' };
    deps.emit({ type: 'plan_status', planId: plan.id, status: 'paused', revision: plan.revision });
    await events.emitComponent({
      nodeId: 'node-clarify-validation',
      component: 'ClarifyOptions',
      props: {
        questionId: 'clarify:validation',
        prompt,
        options: [
          { id: 'replan', label: '让 Agent 重排受影响的部分' },
          { id: 'abort', label: '放弃这一轮' },
        ],
        traceId,
      },
    });
    return events.finish('awaiting_user', plan, 'VALIDATION_ASK_USER');
  };

  /* ---------------- 3. 计划校验（PRD §7.1 主路径） ---------------- */

  const validation = await validateCurrent(plan);
  if (!validation.ok) {
    const action = decideValidationAction({
      ok: validation.ok,
      severity: validation.severity,
      attempt: 0,
      maxAttempts: 1,
    });

    if (action === 'ask-user') {
      return askUserForValidation('计划校验没有通过，希望怎么继续？');
    }

    if (action !== 'continue') {
      // 定位不合法的步骤作为重排种子；校验是计划级的，退化时用全部步骤。
      const seeds: string[] = [];
      for (const step of plan.steps) {
        const result = await validateStep(step, ctx);
        if (!result.ok) seeds.push(step.id);
      }
      const seedIds = seeds.length > 0 ? seeds : plan.steps.map((step) => step.id);

      plan = { ...plan, status: 'replanning' };
      deps.emit({
        type: 'plan_status',
        planId: plan.id,
        status: 'replanning',
        revision: plan.revision,
      });
      const outcome = await doReplan(session, replanEnv, {
        seedIds,
        trigger: 'PROVIDER_VALIDATION_FAILED',
        severity: validation.severity ?? 'error',
        attempt: 0,
        maxAttempts: 1,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'VALIDATION_ASK_USER') {
          return askUserForValidation('重排后的计划仍未通过校验，希望怎么继续？');
        }
        return events.failRun(
          plan,
          `校验未通过且无法重排：${outcome.reason}${outcome.context}`,
          outcome.reason,
        );
      }
      applyReplanOutcome(session, replanEnv, outcome);
    }
  }

  /* ---------------- 5. 审批 → 执行 → 收尾 ---------------- */

  const compiled = compilePlan(plan);
  if (!compiled.ok) {
    return events.failRun(plan, compiled.error.message, compiled.error.code);
  }
  return runExecutionLoop(session, {
    graph: compiled.graph,
    signal: deps.signal,
    events,
    emit: deps.emit,
    now,
    planReadyMs,
    runStep,
    askUserForValidation,
    replanEnv,
    traceId,
  });
}

/**
 * DomainPack 注册表 + 完整性守卫（C0-11）。
 *
 * ★ 缺一段则注册失败 —— 这是"领域包必须完整"唯一的执行点。
 * 本文件位于 `src/core/**`：只认槽位名，**禁止出现任何领域词**。
 */
import { z } from 'zod';
import {
  CORE_DEGRADE_CHAIN,
  REQUIRED_DOMAIN_PACK_SEGMENTS,
  zDegradeChain,
  zDomainMeta,
  zDomainPrompts,
  zEvaluationContributionMeta,
  zPlanningContributionMeta,
  zToolSpecMeta,
  zUIContributionMeta,
  type ComponentDefinition,
  type DegradeChain,
  type DomainPack,
  type ProviderAdapter,
  type StepRenderer,
  type StepTypeDescriptor,
  type ToolSpec,
  type ValidatingProvider,
} from '@/shared/domain/types';
import type { RunContext } from '@/shared/run/types';
import { toolInputJsonSchema, type ToolBrief } from '@/src/core/runtime/adapter';

type PackMap = Map<string, DomainPack>;

const packs: PackMap = new Map();

export type RegisterResult =
  | { ok: true; pack: DomainPack }
  | { ok: false; missing: string[]; issues: string[] };

/**
 * 注册领域包。**入参是不可信的 unknown**（可能来自配置文件 / 动态 import），
 * 因此先做段位守卫，再逐段 `safeParse`。
 */
export function registerDomainPack(candidate: unknown): RegisterResult {
  const missing = REQUIRED_DOMAIN_PACK_SEGMENTS.filter((segment) => {
    const value = (candidate as Record<string, unknown> | null)?.[segment];
    return value === undefined || value === null;
  });
  if (missing.length > 0) {
    return { ok: false, missing, issues: [`缺少必填段：${missing.join(', ')}`] };
  }

  const pack = candidate as DomainPack;
  const issues: string[] = [];

  const meta = zDomainMeta.safeParse(pack.meta);
  if (!meta.success) {
    issues.push(`meta 段校验失败：${meta.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }

  const prompts = zDomainPrompts.safeParse(pack.prompts);
  if (!prompts.success) {
    issues.push(
      `prompts 段校验失败：${prompts.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }

  const tools = z.record(z.string(), zToolSpecMeta).safeParse(
    Object.fromEntries(
      Object.entries(pack.tools ?? {}).map(([key, tool]) => [
        key,
        {
          name: tool?.name,
          description: tool?.description,
          producesFacts: tool?.producesFacts,
          idempotent: tool?.idempotent,
          timeoutMs: tool?.timeoutMs,
          retryable: tool?.retryable,
          stepType: tool?.stepType,
        },
      ]),
    ),
  );
  if (!tools.success) issues.push('tools 段校验失败：每个工具都必须是合法的 ToolSpec');

  const planning = zPlanningContributionMeta.safeParse({
    stepTypes: pack.planning?.stepTypes,
    templates: pack.planning?.templates,
  });
  if (!planning.success) {
    issues.push(
      `planning 段校验失败：${planning.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }

  const ui = zUIContributionMeta.safeParse({
    components: pack.ui?.components ?? [],
    degradeChain: pack.ui?.degradeChain ?? CORE_DEGRADE_CHAIN,
    stepRendererNames: Object.fromEntries(
      Object.entries(pack.ui?.stepRenderers ?? {}).map(([type, renderer]) => [
        type,
        { component: renderer?.component },
      ]),
    ),
  });
  if (!ui.success) {
    issues.push(`ui 段校验失败：${ui.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }

  const evaluation = zEvaluationContributionMeta.safeParse({
    cases: pack.evaluation?.cases ?? [],
    metricIds: pack.evaluation?.metricIds ?? [],
  });
  if (!evaluation.success) issues.push('evaluation 段校验失败');

  if (!pack.providers || typeof pack.providers.namespace !== 'string') {
    issues.push('providers 段必须提供 namespace');
  }
  if (typeof pack.providers?.create !== 'function') {
    issues.push('providers 段必须提供 create(ctx)');
  }
  if (typeof pack.planning?.validateStep !== 'function') {
    issues.push('planning 段必须提供 validateStep(step, ctx)');
  }

  if (issues.length > 0) return { ok: false, missing: [], issues };

  const id = meta.success ? meta.data.id : String((pack.meta as { id?: string })?.id ?? '');
  if (!id) return { ok: false, missing: [], issues: ['meta.id 缺失'] };

  packs.set(id, pack);
  return { ok: true, pack };
}

/** 读取领域包；未注册返回 undefined（由调用方决定降级）。 */
export function getDomainPack(domainId: string): DomainPack | undefined {
  return packs.get(domainId);
}

/** 强制要求领域包存在，否则抛内核通用错误码。 */
export function requireDomainPack(domainId: string): DomainPack {
  const pack = packs.get(domainId);
  if (!pack) {
    throw new Error(`DOMAIN_PACK_NOT_FOUND: ${domainId}`);
  }
  return pack;
}

export function listDomainPacks(): Array<DomainPack['meta']> {
  return [...packs.values()].map((pack) => pack.meta);
}

export function listDomainIds(): string[] {
  return [...packs.keys()];
}

/** 清空注册表（测试专用）。 */
export function clearDomainPacks(): void {
  packs.clear();
}

/** step.type 白名单。 */
export function getStepTypes(domainId: string): StepTypeDescriptor[] {
  return getDomainPack(domainId)?.planning.stepTypes ?? [];
}

export function getStepType(domainId: string, type: string): StepTypeDescriptor | undefined {
  return getStepTypes(domainId).find((descriptor) => descriptor.type === type);
}

export function isAllowedStepType(domainId: string, type: string): boolean {
  return getStepType(domainId, type) !== undefined;
}

export function getTemplates(domainId: string) {
  return getDomainPack(domainId)?.planning.templates ?? [];
}

export function getTool(domainId: string, name: string): ToolSpec | undefined {
  return getDomainPack(domainId)?.tools[name];
}

/**
 * ★ 列出某领域注册过的**全部**工具（给规划 prompt 的"可用工具"清单用）。
 *
 * ## 为什么需要它
 *
 * prompt 的硬性约束要求模型"只能使用清单里列出的 toolName"，
 * 而模型写 `intent.toolName` 时**没有任何途径**看到这份清单——
 * 以前只能猜，猜错就撞上 `工具未在当前领域注册`，步骤全失败、耗尽重排次数。
 * 既有访问器只有 `getTool(domainId, name)`（按名取一个），
 * 拼清单需要"列出全部"这个能力，所以在这里补上。
 *
 * ## 顺序保证
 *
 * 返回顺序 = **注册名的字典序**，用 `a < b ? -1 : ...` 这种**逐字符比较**实现，
 * 刻意**不用** `localeCompare`：后者结果依赖运行环境的 locale/ICU 数据，
 * 同一份注册表在 CI 与本地可能给出不同顺序。
 * 之所以不用 `Object.keys` 的插入序：清单会**逐字渲染进 prompt**，
 * 插入序依赖领域包对象字面量的书写顺序、也受 `Object.keys` 的"整数键前置"规则影响，
 * 两者都会让同一份注册表在两次构建间渲染出**不同顺序的清单**——
 * 那会让 prompt 快照类断言时绿时红，也会让模型看到的清单在两次运行间漂移。
 * 字典序是注册表内容的纯函数，与书写顺序、与运行环境都无关。
 */
export function getTools(domainId: string): ToolSpec[] {
  const tools = getDomainPack(domainId)?.tools ?? {};
  return Object.keys(tools)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => tools[key])
    .filter((tool): tool is ToolSpec => tool !== undefined);
}

/** 某领域注册过的全部工具名（字典序）。校验 `intent.toolName` 时的合法集合。 */
export function getToolNames(domainId: string): string[] {
  return getTools(domainId).map((tool) => tool.name);
}

/**
 * ★ 把注册表里的工具装配成"给模型看的清单"（`ToolBrief[]`）。
 *
 * ## 为什么要有这一步
 *
 * prompt 的硬性约束写着"只能使用『可用工具』里列出的 toolName"，
 * 而这份清单此前**既没进请求、也没被渲染** —— 模型无从知道有哪些工具，
 * 只能凭语义猜（把领域概念自行拼成"名.动作"的形状），猜错即 `工具未在当前领域注册`，
 * 步骤全失败、耗尽重排次数。这是"契约声称提供某项信息、实际没提供"的典型形态。
 *
 * ## 为什么住在注册表里而不是 planner 里
 *
 * 它是**注册表到请求字段**的纯投影，与 `planner.ts` 无关。
 * 而需要它的有两个地方：
 * - `createPlan`（`src/core/planning/planner.ts`）装配 `PlanRequest`；
 * - `MastraRuntime.plan` / `.replan`（`src/core/runtime/mastra/index.ts`）——
 *   因为**重排请求是由编排层 `src/core/run/engine.ts` 直接组装的**，
 *   那条路径不经过 `createPlan`。
 * 放在 planner 里就得让 `runtime/mastra` 反向 import `core/planning`，
 * 那是内核里错误的依赖方向（runtime 是 planning 用的下层实现）。
 * 放在这里则两个方向都只依赖注册表。
 *
 * ## `maxAttempts` 为什么要从 stepType 反查
 *
 * 工具自己**不**声明重试上限 —— 它随 `step.type` 走
 * （`planner.ts` 的 `maxAttemptsFor` 是同一个来源）。
 * 所以按 `ToolSpec.stepType` 反查领域声明的 `zStepTypeDescriptor.maxAttempts`；
 * 查不到（工具没写 `stepType`）时回落到 2，与 `planner.ts` 的 `?? 2` 同值——
 * 两处必须一致，否则模型看到的重试上限会和内核实际执行的不一样。
 */
export function getToolBriefs(domainId: string): ToolBrief[] {
  return getTools(domainId).map((tool) => ({
    name: tool.name,
    description: tool.description,
    maxAttempts:
      (tool.stepType ? getStepType(domainId, tool.stepType)?.maxAttempts : undefined) ?? 2,
    // ★ 入参约束由工具**真实的** inputSchema 现场推导（`toolInputJsonSchema`），
    //   不在这里手抄枚举：手抄的表必然随领域改 schema 而过期，而过期的枚举表
    //   会让模型稳定地填错值 —— 且报错与病因完全对不上。
    inputSchema: toolInputJsonSchema(tool.inputSchema),
  }));
}

export function getStepRenderer(domainId: string, stepType: string): StepRenderer | undefined {
  return getDomainPack(domainId)?.ui.stepRenderers[stepType];
}

export function getComponentDefinition(
  domainId: string,
  name: string,
): ComponentDefinition | undefined {
  return getDomainPack(domainId)?.ui.components.find((component) => component.name === name);
}

/** 降级链：领域未声明则回落到内核通用组件。 */
export function getDegradeChain(domainId: string): DegradeChain {
  const chain = getDomainPack(domainId)?.ui.degradeChain;
  const parsed = chain ? zDegradeChain.safeParse(chain) : undefined;
  return parsed && parsed.success ? parsed.data : CORE_DEGRADE_CHAIN;
}

export function createProviders(domainId: string, ctx: RunContext): Record<string, ProviderAdapter> {
  return getDomainPack(domainId)?.providers.create(ctx) ?? {};
}

export function createValidator(domainId: string, ctx: RunContext): ValidatingProvider | undefined {
  return getDomainPack(domainId)?.providers.createValidator?.(ctx);
}

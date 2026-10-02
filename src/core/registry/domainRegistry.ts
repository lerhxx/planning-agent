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

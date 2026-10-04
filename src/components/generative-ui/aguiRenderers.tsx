'use client';

/**
 * CopilotKit v2 / AG-UI 的活动消息渲染器（生成式卡片这一层的适配层）。
 *
 * 职责边界：
 * - **只做适配**：把 AG-UI 的 `activityType + content` 翻译成 `ComponentRenderer` 的节点；
 * - **绝不重写降级**：zod 校验 → 三级降级链 → 懒加载，全部仍然走 `ComponentRenderer`。
 *   本文件里没有任何一处"自己判断该渲染什么"，否则降级链就被旁路了（红线）。
 *
 * 渲染器数组 `aguiActivityRenderers` 由**遍历组件注册表**生成，
 * 不硬编码组件名清单 —— 往注册表里加一个组件，这里自动多一个渲染器。
 */
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import type {
  AbstractAgent,
  ActivityMessage,
  ReactActivityMessageRenderer,
} from '@copilotkit/react-core/v2';
import { z } from 'zod';

import ComponentRenderer from './ComponentRenderer';
import { registerCoreUIComponents } from './coreComponents';
import {
  listCoreComponents,
  resolveComponent,
  type RegisteredComponent,
} from './registry';
import { zPlanViewProps } from './PlanView/schema';
import type { ComponentAction } from './ClarifyOptions/schema';

/* ------------------------------------------------------------------ *
 * ① 领域上下文
 * ------------------------------------------------------------------ */

/**
 * 活动消息本身**不带 domainId**，但 `ComponentRenderer` 查领域组件需要它。
 * 由外壳（CopilotChat 所在层）用 `DomainIdProvider` 注入。
 *
 * ★ 缺省是 `''`：此时 `resolveComponent('', name)` 只会命中内核通用组件表，
 * 全部卡片仍可渲染（只是拿不到领域定制组件）。这是刻意的可降级设计，不是漏接线。
 */
export const DomainIdContext = createContext<string>('');

/** 缺省领域 id：空串 = "只用内核通用组件"。 */
export const DEFAULT_DOMAIN_ID = '';

export interface DomainIdProviderProps {
  domainId?: string;
  children: ReactNode;
}

export function DomainIdProvider(props: DomainIdProviderProps): ReactNode {
  const { domainId = DEFAULT_DOMAIN_ID, children } = props;
  return <DomainIdContext.Provider value={domainId}>{children}</DomainIdContext.Provider>;
}

/** 读取当前领域 id；没有 provider 时返回 `''`（回落到内核组件）。 */
export function useDomainId(): string {
  return useContext(DomainIdContext) ?? DEFAULT_DOMAIN_ID;
}

/* ------------------------------------------------------------------ *
 * ② 视觉外壳（明亮卡片，token 与 app/theme.tokens.css 一致）
 * ------------------------------------------------------------------ */

export interface ActivityCardFrameProps {
  /** 卡片顶部的小标题（组件用途 / 活动类型）。 */
  eyebrow?: string;
  children: ReactNode;
}

/**
 * 生成式卡片的统一外框：白底 + 22px 圆角 + 极轻阴影。
 * 只负责"壳"，内容一律由 `ComponentRenderer` 决定（可能是降级态）。
 */
export function ActivityCardFrame(props: ActivityCardFrameProps): ReactNode {
  const { eyebrow, children } = props;
  return (
    <div className="w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-[var(--spacing-gutter)] shadow-[var(--shadow-card)]">
      {eyebrow ? (
        <p className="mb-2 text-[11px] font-medium tracking-wide text-[var(--color-accent)]">
          {eyebrow}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ③ 澄清答案 → AG-UI interrupt
 * ------------------------------------------------------------------ */

/**
 * AG-UI interrupt 的**最小可用面**。
 *
 * 只声明这里真正会读的字段，不去猜 CopilotKit 的完整类型 ——
 * 网络/宿主对象一律按"不可信"处理，逐个字段做运行时检查。
 */
interface PendingInterruptLike {
  id?: string;
  name?: string;
  resolve?: (value: unknown) => void | Promise<void>;
}

function readPendingInterrupts(agent: unknown): PendingInterruptLike[] {
  const holder = agent as { pendingInterrupts?: unknown } | null | undefined;
  const list = holder?.pendingInterrupts;
  return Array.isArray(list) ? (list as PendingInterruptLike[]) : [];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 组件回灌动作 → 中断的 `answers` 载荷。 */
function toAnswers(action: ComponentAction): Record<string, string> {
  if (action.type === 'select_option') {
    const key = action.questionId ?? 'selection';
    return { [key]: action.optionId ?? '' };
  }
  if (action.type === 'submit_form') {
    return { ...(action.values ?? {}) };
  }
  // `retry` / `cancel` 不是答案，不进 answers。
  return {};
}

/** 只有这两类动作携带用户答案。 */
function carriesAnswer(action: ComponentAction): boolean {
  return action.type === 'select_option' || action.type === 'submit_form';
}

export interface InterruptSubmit {
  /** 交给 `ComponentRenderer.onAction` 的回调。 */
  submit: (action: ComponentAction) => void;
  /** 提交失败/无法提交时的可见提示；没有则为 null。 */
  notice: string | null;
}

/**
 * 把澄清卡的提交接到 AG-UI interrupt 上。
 *
 * ★ 红线（"静默失败"是本项目反复出现的 bug 模式）：
 * 用户点了一次提交，答案**必须**有显式结果 —— 要么送进 interrupt，要么在界面上说清楚为什么没送出去。
 * 因此下面三个分支每一个都留下可见痕迹（`notice`）或在注释里写明为什么可以不管：
 * 1. 非答案类动作（retry/cancel）→ 本来就不该提交，直接返回；
 * 2. 没有 pending interrupt → 渲染"当前无法提交"提示，绝不静默丢弃；
 * 3. `resolve` 抛错 → 把错误文案渲染出来。
 */
export function useInterruptSubmit(agent: unknown): InterruptSubmit {
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useCallback(
    (action: ComponentAction): void => {
      // ① 非答案类动作：不提交是本分，不是失败。
      if (!carriesAnswer(action)) return;

      const interrupt = readPendingInterrupts(agent)[0];

      // ② 没有可回复的中断 —— 明确告知，绝不静默丢弃用户答案。
      if (interrupt === undefined) {
        setNotice('当前没有待回复的中断，答案未送出。请稍后重试，或直接在对话里回复。');
        return;
      }
      if (typeof interrupt.resolve !== 'function') {
        setNotice('中断对象未提供 resolve()，答案未送出。');
        return;
      }

      // ③ resolve 可能同步抛、也可能返回 rejected Promise —— 两条路都要可见。
      try {
        void Promise.resolve(interrupt.resolve({ answers: toAnswers(action) })).catch(
          (error: unknown) => {
            setNotice(`提交失败：${describeError(error)}`);
          },
        );
      } catch (error) {
        setNotice(`提交失败：${describeError(error)}`);
      }
    },
    [agent],
  );

  return { submit, notice };
}

/* ------------------------------------------------------------------ *
 * ④ 渲染参数与工具
 * ------------------------------------------------------------------ */

/** AG-UI 传给 `render` 的参数（与 `ReactActivityMessageRenderer.render` 的 props 一致）。 */
export interface ActivityRenderProps {
  activityType: string;
  content: Record<string, unknown>;
  message: ActivityMessage;
  /**
   * CopilotKit 的 props 里 `agent` 是**可选**的（`AbstractAgent | undefined`）——
   * 没有 agent 时拿不到 interrupt，提交会走"无法提交"的可见提示分支。
   */
  agent?: AbstractAgent;
}

/**
 * 渲染器列表的元素类型。
 *
 * 泛型参数只能是 `any`：每个组件的 props 形状由它**自己的** zod schema 校验
 * （校验发生在 `ComponentRenderer` 里），渲染器列表这一层刻意不做约束。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 见上方注释：props 形状由各组件 schema 校验
export type AnyActivityMessageRenderer = ReactActivityMessageRenderer<any>;

function readMessageId(message: unknown): string | null {
  const id = (message as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/* ------------------------------------------------------------------ *
 * ⑤ `plan` 活动：思考模块 / 计划推演卡
 * ------------------------------------------------------------------ */

export const PLAN_ACTIVITY_TYPE = 'plan';

/**
 * **所有**渲染器的传输层 content schema：一律放行（`unknown`）。
 *
 * ★ 为什么不放组件自己的严格 schema（哪怕是"能接住"的那个）：
 * CopilotKit 在调用 `render` **之前**会先拿 `content` 做一次 `~standard.validate()`，
 * 失败就直接 `console.warn` + `return null` —— 也就是**整张卡片不渲染**，
 * 我们的三级降级链根本没机会跑（`useRenderActivityMessage` 的实现，已核实）。
 * 那正是本项目最忌讳的"白屏"。
 *
 * ★ 而且这不是理论风险，**必然发生**：`ACTIVITY_SNAPSHOT` 的 content 起始是 `{}`，
 * 之后靠 `ACTIVITY_DELTA` 逐条 JSON Patch 长出 —— **中间态的 content 一定不满足
 * `def.schema`**（例如 `StepItem` 必填 `id`，在 `id` 到达前的每一帧都不合法）。
 * 若这里把关，卡片在"长出"的全过程中会一直是空白，直到最后一帧才可能显示；
 * 而 `decideDegrade` 本来就是为这个场景设计的（props 未补齐 → 骨架）。
 *
 * 所以这里只做"放行"，**真正的校验留在 `ComponentRenderer` 里**（它用 `def.schema`）：
 * 合法 → 渲染组件；不合法 / 未补齐 → 骨架或原始载荷，用户看得见。
 */
export const zActivityContent = z.unknown();

export interface PlanActivityCardProps {
  /** 活动消息的 content（未经信任，下面会 safeParse）。 */
  content: unknown;
  nodeId: string;
}

/**
 * 计划推演卡（「思考模块」）：可折叠，**默认展开**，展开后是步骤列表 + 各自状态。
 *
 * 内容仍然交给 `ComponentRenderer` 渲染 `PlanView` ——
 * 载荷不合法时由它落到三级降级（原始载荷 / 错误态 / 骨架），这里不另开分支。
 */
export function PlanActivityCard(props: PlanActivityCardProps): ReactNode {
  const { content, nodeId } = props;
  const domainId = useDomainId();
  const [open, setOpen] = useState<boolean>(true);

  const parsed = zPlanViewProps.safeParse(content ?? {});
  const steps = parsed.success ? parsed.data.steps : [];
  const doneCount = steps.filter((step) => step.status === 'done').length;
  // 载荷不合法时把"解析失败"显式写在卡片头上，而不是装作一切正常。
  const statusText = parsed.success ? String(parsed.data.status) : '载荷未通过校验';
  const revisionText = parsed.success ? `rev ${parsed.data.revision}` : 'rev -';
  const countText = parsed.success ? `${doneCount}/${steps.length} 步` : '— 步';

  return (
    <div className="w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2 px-[var(--spacing-gutter)] py-3">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]"
        />
        <span className="text-[13px] font-semibold text-[var(--color-text-strong)]">计划推演</span>
        <span className="rounded-[var(--radius-pill)] bg-[var(--color-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--color-accent-strong)]">
          {statusText}
        </span>
        <span className="text-[11px] text-[var(--color-text-weak)]">{revisionText}</span>
        <span className="text-[11px] text-[var(--color-text-weak)]">{countText}</span>

        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((previous) => !previous)}
          className="ml-auto rounded-[var(--radius-pill)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-fill-soft)]"
        >
          {open ? '收起' : '展开'}
        </button>
      </div>

      {open ? (
        <div className="border-t border-[var(--color-divider)] px-[var(--spacing-gutter)] py-3">
          <ComponentRenderer
            node={{
              nodeId,
              component: 'PlanView',
              props: (content ?? {}) as Record<string, unknown>,
              status: parsed.success ? 'ready' : 'degraded',
            }}
            domainId={domainId}
          />
        </div>
      ) : null}
    </div>
  );
}

function createPlanActivityRenderer(): AnyActivityMessageRenderer {
  function PlanActivityView(props: ActivityRenderProps): ReactNode {
    return (
      <PlanActivityCard
        content={props.content}
        nodeId={readMessageId(props.message) ?? props.activityType}
      />
    );
  }
  return {
    activityType: PLAN_ACTIVITY_TYPE,
    content: zActivityContent,
    render: PlanActivityView,
  };
}

/* ------------------------------------------------------------------ *
 * ⑥ 注册表 → 渲染器
 * ------------------------------------------------------------------ */

/**
 * 一个注册表条目 → 一个活动渲染器。
 *
 * `render` 内部只做一件事：把 content 原样交给 `ComponentRenderer`。
 * 校验与降级仍然在 `ComponentRenderer` 里，避免"适配层悄悄绕过降级链"。
 */
function createRegistryRenderer(
  definition: RegisteredComponent,
): AnyActivityMessageRenderer {
  function RegistryActivityView(props: ActivityRenderProps): ReactNode {
    const domainId = useDomainId();
    const { submit, notice } = useInterruptSubmit(props.agent);

    return (
      <ActivityCardFrame eyebrow={definition.description || definition.name}>
        <ComponentRenderer
          node={{
            nodeId: readMessageId(props.message) ?? props.activityType,
            component: props.activityType,
            props: props.content ?? {},
            status: 'ready',
          }}
          domainId={domainId}
          onAction={submit}
        />
        {notice ? (
          <p
            role="status"
            className="mt-2 rounded-[var(--radius-control)] bg-[var(--color-fill-soft)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]"
          >
            {notice}
          </p>
        ) : null}
      </ActivityCardFrame>
    );
  }

  return {
    activityType: definition.name,
    // ★ 传输层放行；真正的校验在 `ComponentRenderer` 里用 `definition.schema`。
    // 详见 `zActivityContent` 的注释（否则 CopilotKit 会先校验失败并整卡不渲染）。
    content: zActivityContent,
    render: RegistryActivityView,
  };
}

/**
 * 通配活动类型。CopilotKit 的匹配顺序是
 * `精确 activityType（优先 agentId 命中的）→ "*" 兜底`，
 * 所以 `"*"` **不会抢走**任何有专属渲染器的类型（已核实 `useRenderActivityMessage`）。
 */
export const WILDCARD_ACTIVITY_TYPE = '*';

/** 兜底渲染器的 content 同样放行：见 `zActivityContent` 的注释。 */

/**
 * 兜底渲染器：任何**没有专属渲染器**的活动类型都落到这里。
 *
 * 解决两个真实的白屏口子：
 * 1. 领域组件（运行时才 `registerDomainComponents`，不在模块加载时的快照里）
 *    → `ComponentRenderer` 是**运行时查表**，照样能渲染出来；
 * 2. 完全不认识的活动类型 → `ComponentRenderer` 查不到 → 一级降级「原始载荷」，
 *    用户至少看得到数据，而不是一块空白。
 */
function createFallbackActivityRenderer(): AnyActivityMessageRenderer {
  function FallbackActivityView(props: ActivityRenderProps): ReactNode {
    const domainId = useDomainId();
    const { submit, notice } = useInterruptSubmit(props.agent);

    return (
      <ActivityCardFrame eyebrow={`活动 · ${props.activityType}`}>
        <ComponentRenderer
          node={{
            nodeId: readMessageId(props.message) ?? props.activityType,
            component: props.activityType,
            props: props.content ?? {},
            status: 'ready',
          }}
          domainId={domainId}
          onAction={submit}
        />
        {notice ? (
          <p
            role="status"
            className="mt-2 rounded-[var(--radius-control)] bg-[var(--color-fill-soft)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]"
          >
            {notice}
          </p>
        ) : null}
      </ActivityCardFrame>
    );
  }

  return {
    activityType: WILDCARD_ACTIVITY_TYPE,
    content: zActivityContent,
    render: FallbackActivityView,
  };
}

/**
 * 按**当前**注册表生成渲染器数组。
 *
 * 领域组件若在模块加载之后才注册，外壳应重新调用本函数（注册表是运行时可变的）。
 */
export function buildAguiActivityRenderers(): AnyActivityMessageRenderer[] {
  const renderers: AnyActivityMessageRenderer[] = [createPlanActivityRenderer()];

  for (const name of listCoreComponents()) {
    const definition = resolveComponent(DEFAULT_DOMAIN_ID, name);
    if (definition === undefined) {
      // 不可达：`listCoreComponents()` 的键必然在内核表里。
      // 仍然显式告警而不是静默跳过 —— 真出现了说明注册表被并发清空，必须可见。
      console.warn(`[agui] 注册表缺少组件「${name}」，已跳过其活动渲染器`);
      continue;
    }
    renderers.push(createRegistryRenderer(definition));
  }

  // 兜底放最后：精确匹配永远优先，它只在"没人认领"时上场。
  renderers.push(createFallbackActivityRenderer());

  return renderers;
}

// 渲染器数组是模块加载时对注册表的一次快照，因此先确保内核组件已注册
// （`registerCoreUIComponents` 幂等，重复调用无副作用）。
registerCoreUIComponents();

/**
 * CopilotKit v2 provider 的 `renderActivityMessages` 直接吃这个数组。
 *
 * 名字与类型是跟外壳（`app/**`）约定好的契约，**不要改**。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 各组件 props 形状由各自 schema 校验，渲染器列表刻意不约束
export const aguiActivityRenderers: ReactActivityMessageRenderer<any>[] =
  buildAguiActivityRenderers();

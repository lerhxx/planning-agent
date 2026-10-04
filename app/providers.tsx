'use client';

/**
 * 应用外壳的 Provider 层：把 CopilotKit v2 接到我们自己的 AG-UI 端点上。
 *
 * 设计要点（务必读，改动前先读）：
 *
 * 1. **不走 CopilotKit runtime。**
 *    我们只有一个自营的 AG-UI SSE 端点 `/api/agui`，没有标准的 CopilotKit runtime。
 *    所以这里**显式不传 `runtimeUrl`** —— 一旦传了，react-core 会周期性去探 `/info`
 *    并走 5s 超时/重试循环（控制台刷屏 + 无谓请求）。同理不传 `useSingleEndpoint`：
 *    它只影响上面那个探测的地址形态，跟我们这条 HttpAgent 链路毫无关系，
 *    传了只会误导后来人。
 *
 * 2. **agent 通过 `selfManagedAgents` 注入。**
 *    `HttpAgent`（@ag-ui/client）直接把请求打到 `/api/agui`，Agent key 为 `default`，
 *    与 `<CopilotChat agentId="default" />` 对应。
 *
 * 3. ⚠️ **已知副作用：`publicLicenseKey` 告警。**
 *    `selfManagedAgents` 非空时，react-core 会 `console.warn` 要求 `publicLicenseKey`
 *    （CopilotKit Enterprise 收费项）。这条告警**不阻断功能**：只是 license 校验失败，
 *    agent 仍然正常注册、正常跑。dev 期若嫌噪音，可把 `selfManagedAgents` 换成
 *    `agents__unsafe_dev_only` —— 两者最终都落到同一个 localAgents 注册表，行为等价，
 *    差别只是名字把"这是 dev-only 通道"写进了代码里。当前**保留 `selfManagedAgents`**。
 *
 * 4. **agent 实例必须稳定持有。**
 *    `HttpAgent` 里挂着订阅者与 run 状态，每次渲染 new 一个会导致正在跑的 run 断流。
 *    这里用 `useMemo(() => …, [])` 固定为单例。
 *
 * 5. **`labels` 不在这层传。**
 *    `CopilotKitProviderProps` **没有 `labels` 字段**；文案走
 *    `<CopilotChat labels={…} />`（键名见 `CopilotChatDefaultLabels`，例如输入框占位符
 *    叫 `chatInputPlaceholder`，不是 `inputPlaceholder`）。
 *
 * 6. **`renderActivityMessages`** 是我们的 AG-UI 活动卡片渲染器（计划卡片等），
 *    契约见 `src/components/generative-ui/aguiRenderers` 的导出
 *    `aguiActivityRenderers: ReactActivityMessageRenderer<any>[]`。
 *
 * 7. **领域 id 与运行期开关的通道**（见下方 `agent` 构造处）：
 *    - `domainId` → `RunAgentInput.state`
 *    - `simulate` / `replanMode` / `requireConstraints` → `RunAgentInput.forwardedProps`
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { HttpAgent, type AbstractAgent } from '@ag-ui/client';
import type { RunAgentInput } from '@ag-ui/core';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  DomainIdProvider,
  aguiActivityRenderers,
} from '@/src/components/generative-ui/aguiRenderers';
import { domainOptions, registerAllUI } from '@/src/domains/ui';
import { TRAVEL_DOMAIN_ID } from '@/src/domains/travel/meta';
import { buildResumeWithCancelled } from '@/src/agui/resume';

/**
 * 保留旧页面的启动注册：生成式组件**按名字**在注册表里查找（`ComponentRenderer`），
 * 不注册的话查找会落空并静默降级（本项目反复出现的一类 bug：查不到 → 什么都不画）。
 * 这里幂等注册「内核兜底组件 + 各领域组件」，代价是把领域 UI 拉进客户端 bundle，
 * 和改造前一致。客户端对领域的引用点仍然只有 `src/domains/ui.ts` 这一个桶文件。
 */
registerAllUI();

/** 自营 AG-UI 端点。改成远端服务时只需要动这一个常量。 */
const AGUI_ENDPOINT = '/api/agui';

/** `<CopilotChat agentId="…">` 用的 agent key，与下面的注册键保持一致。 */
export const DEFAULT_AGENT_ID = 'default';

/* ------------------------------------------------------------------ *
 * 运行期开关（故障注入 / 重排行为）
 * ------------------------------------------------------------------ */

/** `/api/agui` 的 `forwardedProps` 只认这四个键，未知键会被忽略（不会 400）。 */
export interface RunOptions {
  /** 故障注入：`none` 正常 / `retryable` 可重试 / `fatal` 不可恢复 / `clarify` 触发澄清中断。 */
  simulate: 'none' | 'retryable' | 'fatal' | 'clarify';
  /** 重排行为：`diverge` 换方案 / `stagnant` 原地打转（演示 NO_CONVERGENCE 闸门）。 */
  replanMode: 'diverge' | 'stagnant';
  /** 强制先澄清约束再出计划（与"直接执行"互斥演示用）。 */
  requireConstraints: boolean;
}

const DEFAULT_RUN_OPTIONS: RunOptions = {
  simulate: 'none',
  replanMode: 'diverge',
  requireConstraints: false,
};

/**
 * 领域默认选 travel：这是本项目投入最大的领域，写死 demo 等于永远摸不到。
 *
 * ⚠️ 服务端对 `domainId` 是**强校验**的（`/api/agui`）：
 *   - 不传 / 传 `''`（或纯空白）→ 合法，走内核默认（第一个已注册领域 = demo）；
 *   - 传了但不在注册表里 → **400** `{ error:'UNKNOWN_DOMAIN', domainId, available }`，
 *     不再静默回落；
 *   - 只做 trim，不归一化大小写（`'Travel'` 会被拒）。
 * 所以取值必须是各领域包 `meta.ts` 里的**小写 id 字面量**。
 * 选择器选项一律来自 `domainOptions[].id` —— 绝不能传 `.label`（中文展示名，必 400）。
 */
const DEFAULT_DOMAIN_ID: string = domainOptions.some((option) => option.id === TRAVEL_DOMAIN_ID)
  ? TRAVEL_DOMAIN_ID
  : (domainOptions[0]?.id ?? '');

/* ------------------------------------------------------------------ *
 * 外壳配置 Context
 * ------------------------------------------------------------------ */

export interface ShellConfig {
  /** 当前领域 id。必须是已注册的小写字面量（服务端强校验，未知值直接 400）。 */
  domainId: string;
  setDomainId: (domainId: string) => void;
  runOptions: RunOptions;
  setRunOptions: (patch: Partial<RunOptions>) => void;
}

const ShellConfigContext = createContext<ShellConfig | null>(null);

/**
 * 读取外壳配置（领域 + 运行期开关）。
 *
 * 刻意**不**给默认值兜底：忘了包 Provider 是接线错误，静默回落到默认值会让
 * "我明明选了 travel 却跑了 demo" 这类问题查不到根因 —— 直接抛。
 */
export function useShellConfig(): ShellConfig {
  const config = useContext(ShellConfigContext);
  if (config === null) {
    throw new Error('useShellConfig 必须在 <Providers> 内部使用');
  }
  return config;
}

export interface ProvidersProps {
  children: ReactNode;
}

export default function Providers({ children }: ProvidersProps): ReactNode {
  const [domainId, setDomainId] = useState<string>(DEFAULT_DOMAIN_ID);
  const [runOptions, setRunOptions] = useState<RunOptions>(DEFAULT_RUN_OPTIONS);

  /**
   * 中间件每次 run 都要读**最新**的领域与开关值，但 `useMemo(…, [])` 里的
   * agent 只构造一次 —— 所以用一个 ref 桥接，避免闭包吃到构造时的旧值。
   */
  const latestRef = useRef<{ domainId: string; runOptions: RunOptions }>({
    domainId,
    runOptions,
  });
  latestRef.current = { domainId, runOptions };

  const agent = useMemo<HttpAgent>(() => {
    const instance = new HttpAgent({ url: AGUI_ENDPOINT });
    instance.state = { domainId: DEFAULT_DOMAIN_ID };

    /**
     * 每次 run 之前把当前配置打进 `RunAgentInput`。
     *
     * 为什么用中间件而不是 `runAgent({ forwardedProps })`：run 是 `<CopilotChat>`
     * 内部发起的，外壳拿不到调用点；而 AG-UI 的 middleware 就在 `runAgent` 的
     * 链路里（`[...middlewares, boundary].reduceRight(...).run(input)`），
     * 是唯一能在不改组件库的前提下改写出参的地方。
     *
     * 为什么 `state` 和 `forwardedProps` 都写：`/api/agui` 的 `parseRunOptions` 两个
     * 都读（state 先，forwardedProps 后覆盖），`domainId` 走 state 是跟服务端约定好的通道，
     * 开关走 forwardedProps 语义更准（它们不是会话状态，是本次 run 的指令）。
     */
    instance.use((input: RunAgentInput, next: AbstractAgent) =>
      next.run({
        ...input,
        state: { ...input.state, domainId: latestRef.current.domainId },
        forwardedProps: { ...input.forwardedProps, ...latestRef.current.runOptions },
      }),
    );

    /*
     * ★ 补齐未交代的 pending interrupt —— 一个真实的阻断性 bug 的修法。
     *
     * 现象：用户在澄清卡片上**不点选项、直接在输入框发新消息** →
     *   Error: Thread has 1 pending interrupt(s) not addressed by resume: clarify:…
     *   （`@ag-ui/client` 的 `AbstractAgent.onInitialize` 抛，请求发出去之前就死了）
     *
     * 为什么包在 `runAgent` 上、而不是顺手在上面的中间件里补 `resume`：
     * 校验发生在 `runAgent` 内部，且**早于**中间件 ——
     *     const input = this.prepareRunAgentInput(parameters);
     *     await this.onInitialize(input, …);              ← 校验在这里抛
     *     …middlewares.reduceRight(…).run(input)           ← 中间件在这里才跑
     * 校验看的是中间件之前的 input，中间件补 resume 根本来不及。
     * 唯一能在不动组件库的前提下提前注入的位置就是 `runAgent` 的**参数**：
     * CopilotKit 的发消息链路正是 `copilotkit.runAgent({ agent })` → core 内部
     * `agent.runAgent(agentRunInput, …)` → 落到这里。
     *
     * 为什么补 `cancelled` 而不是"什么都不管"：
     *   1. 用户直接发新消息 = 放弃上一个问题改问新的，新消息天然覆盖旧问题；
     *   2. SDK 自己另一条错误分支的文案就是「… can no longer be answered. **Cancel**
     *      it to continue the thread.」—— `cancelled` 是它认可的"放弃并继续"出口；
     *   3. 服务端 `mergeResumeAnswers` 只消费 `status === 'resolved'`，`cancelled`
     *      不产生 answers，正好等价于"这次不带答案，重新跑"。
     * ★ 已经交代过的中断绝不能再补一条 cancelled（见 `buildResumeWithCancelled` 注释）：
     *   那样会把用户刚点的选项冲掉。
     */
    const baseRunAgent = instance.runAgent.bind(instance);
    instance.runAgent = (parameters, subscriber) => {
      const resume = buildResumeWithCancelled(
        instance.pendingInterrupts ?? [],
        parameters?.resume,
      );
      return baseRunAgent(
        resume === undefined ? parameters : { ...parameters, resume: [...resume] },
        subscriber,
      );
    };

    return instance;
  }, []);

  const selfManagedAgents = useMemo<Record<string, HttpAgent>>(
    () => ({ [DEFAULT_AGENT_ID]: agent }),
    [agent],
  );

  /**
   * 出错即打印 —— 本项目红线：禁止 catch 后静默吞掉。
   * 这里不做 UI 呈现（聊天区自带错误态），只保证异常一定可见。
   */
  const handleError = useCallback(
    (event: { error: Error; code: string; context: Record<string, unknown> }): void => {
      console.error('[copilotkit] agent error', event.code, event.context, event.error);
    },
    [],
  );

  const config = useMemo<ShellConfig>(
    () => ({
      domainId,
      setDomainId,
      runOptions,
      setRunOptions: (patch: Partial<RunOptions>): void =>
        setRunOptions((prev) => ({ ...prev, ...patch })),
    }),
    [domainId, runOptions],
  );

  return (
    <CopilotKitProvider
      selfManagedAgents={selfManagedAgents}
      renderActivityMessages={aguiActivityRenderers}
      onError={handleError}
    >
      <ShellConfigContext.Provider value={config}>
        {/*
         * 领域上下文：`ComponentRenderer` 查领域定制组件时需要 domainId，
         * 而 AG-UI 活动消息不携带它，所以由外壳显式提供（缺省 `''` 只命中内核通用表）。
         * 这里与 `agent.state.domainId` 同源，避免"服务端跑 travel、客户端按 demo 渲染"。
         */}
        <DomainIdProvider domainId={domainId}>{children}</DomainIdProvider>
      </ShellConfigContext.Provider>
    </CopilotKitProvider>
  );
}

'use client';

/**
 * 应用外壳的 Provider 层：把 CopilotKit v2 接到我们自己的 AG-UI 端点上。
 *
 * 设计要点（务必读，改动前先读）：
 *
 * 1. **不走 CopilotKit runtime。**
 *    我们只有一个自营的 AG-UI SSE 端点 `/api/agui`（见 app/api/agui/route.ts），
 *    没有标准的 CopilotKit runtime。所以这里**显式不传 `runtimeUrl`** —— 一旦传了，
 *    react-core 会周期性去探 `/info` 并走 5s 超时/重试循环（控制台刷屏 + 无谓请求）。
 *    同理不传 `useSingleEndpoint`：它只影响上面那个探测的地址形态，
 *    跟我们这条 HttpAgent 链路毫无关系，传了只会误导后来人。
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
 *    这里用 `useMemo(() => ..., [])` 固定为单例。
 *
 * 5. **`labels` 不在这层传。**
 *    `CopilotKitProviderProps`（dist/copilotkit-*.d.mts）**没有 `labels` 字段**；
 *    文案走 `<CopilotChat labels={...} />`（键名见 `CopilotChatDefaultLabels`，
 *    例如输入框占位符叫 `chatInputPlaceholder`，不是 `inputPlaceholder`）。
 *
 * 6. **`renderActivityMessages`** 是我们的 AG-UI 活动卡片渲染器（计划卡片等），
 *    契约见 `src/components/generative-ui/aguiRenderers` 的导出
 *    `aguiActivityRenderers: ReactActivityMessageRenderer<any>[]`。
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { HttpAgent } from '@ag-ui/client';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  DomainIdProvider,
  aguiActivityRenderers,
} from '@/src/components/generative-ui/aguiRenderers';
import { defaultDomainId, registerAllUI } from '@/src/domains/ui';

/**
 * 保留旧页面的启动注册：生成式组件**按名字**在注册表里查找（`ComponentRenderer`），
 * 不注册的话查找会落空并静默降级（本项目反复出现的一类 bug：查不到 → 什么都不画）。
 * 这里幂等注册「内核兜底组件 + 各领域组件」，代价是把领域 UI 拉进客户端 bundle，
 * 和改造前一致。客户端对领域的引用点仍然只有 `src/domains/ui.ts` 这一个桶文件。
 */
registerAllUI();

/** 自营 AG-UI 端点。改成远端服务时只需要动这一个常量。 */
const AGUI_ENDPOINT = '/api/agui';

/** `<CopilotChat agentId="...">` 用的 agent key，与下面的注册键保持一致。 */
export const DEFAULT_AGENT_ID = 'default';

export interface ProvidersProps {
  children: ReactNode;
}

export default function Providers({ children }: ProvidersProps): ReactNode {
  // 单例：整个应用生命周期内只创建一次。
  const agent = useMemo<HttpAgent>(() => {
    const instance = new HttpAgent({ url: AGUI_ENDPOINT });
    /**
     * 领域 id 的唯一通道：AG-UI 的 `RunAgentInput.state`。
     * `/api/agui` 从 `input.state`（或 `forwardedProps`）里读 `domainId`，
     * 活动消息本身不带它，所以这里**同时**做两件事：
     *   1. 写进 agent.state —— 每次 run 都会带上，服务端据此选领域；
     *   2. 喂给 `DomainIdProvider` —— 客户端卡片查领域组件时用它。
     * 两边同源，避免"服务端跑 travel、客户端按 demo 渲染"这种错位。
     *
     * ⚠️ 服务端对 `domainId` 是**强校验**的（`/api/agui`，commit 4a35faa）：
     *   - 不传 / 传 `''`（或纯空白）→ 合法，走内核默认（第一个已注册领域 = demo）；
     *   - 传了但不在注册表里 → **400** `{ error:'UNKNOWN_DOMAIN', domainId, available }`，
     *     不再静默回落；
     *   - 只做 trim，不归一化大小写（`'Travel'` 会被拒）。
     * 所以这里必须是各领域包 `meta.ts` 里的**小写 id 字面量**（当前 `defaultDomainId`
     * = `demoDomainId` = `'demo'`）。将来若加领域选择器，务必传 `domainOptions[].id`
     * 而不是 `.label`（label 是中文展示名，传过去必 400）。
     */
    instance.state = { domainId: defaultDomainId };
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

  return (
    <CopilotKitProvider
      selfManagedAgents={selfManagedAgents}
      renderActivityMessages={aguiActivityRenderers}
      onError={handleError}
    >
      {/*
       * 领域上下文：`ComponentRenderer` 查领域定制组件时需要 domainId，
       * 而 AG-UI 活动消息不携带它，所以由外壳显式提供。缺省值 `''` 也能渲染
       * （只命中内核通用组件表），包了之后才能拿到领域定制组件。
       */}
      <DomainIdProvider domainId={defaultDomainId}>{children}</DomainIdProvider>
    </CopilotKitProvider>
  );
}

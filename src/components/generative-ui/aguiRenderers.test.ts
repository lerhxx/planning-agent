// @vitest-environment jsdom
/**
 * AG-UI 活动渲染器的契约测试。
 *
 * 重点盯两条红线：
 * 1. **降级链没被绕过** —— 不合法 content 必须落到降级态，绝不白屏/抛异常；
 * 2. **不静默失败** —— 澄清答案送不出去时必须看得见。
 */
import { createElement } from 'react';
import type { ZodType } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AbstractAgent, ActivityMessage } from '@copilotkit/react-core/v2';

import {
  aguiActivityRenderers,
  buildAguiActivityRenderers,
  DomainIdProvider,
  PLAN_ACTIVITY_TYPE,
  useDomainId,
  WILDCARD_ACTIVITY_TYPE,
} from './aguiRenderers';
import { resolveComponent, listCoreComponents, registerDomainComponents } from './registry';
import { registerCoreUIComponents } from './coreComponents';
import { zPlanViewProps } from './PlanView/schema';

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 活动消息只用到 `id`，其余字段不关心 —— 但类型必须是 `ActivityMessage`。 */
const fakeMessage = { id: 'activity-1' } as unknown as ActivityMessage;

function makeAgent(pendingInterrupts: unknown[] = []): AbstractAgent {
  return { pendingInterrupts } as unknown as AbstractAgent;
}

function rendererOf(activityType: string) {
  const renderer = aguiActivityRenderers.find((item) => item.activityType === activityType);
  if (!renderer) throw new Error(`缺少活动渲染器：${activityType}`);
  return renderer;
}

/** `content` 声明为 `StandardSchemaV1`，实际是 zod schema —— 取回来做 safeParse。 */
function schemaOf(activityType: string): ZodType {
  return rendererOf(activityType).content as unknown as ZodType;
}

/** 降级态的可见指纹：`RawPayloadCard` / `ErrorState` / `SkeletonList` 三者之一。 */
const DEGRADE_MARKER = /原始载荷|出错|组件生成中|组件加载中/;

afterEach(() => {
  cleanup();
});

describe('aguiActivityRenderers', () => {
  it('注册表里每个组件都有一个同名渲染器，content 就是它自己的 schema', () => {
    registerCoreUIComponents();
    const names = aguiActivityRenderers.map((item) => item.activityType);

    // 注册表里的组件一个都不能漏。
    for (const name of listCoreComponents()) {
      expect(names, `注册表里的 ${name} 没有对应渲染器`).toContain(name);
      const definition = resolveComponent('', name);
      expect(definition, `注册表里查不到 ${name}`).toBeDefined();
      expect(rendererOf(name).content).toBe(definition!.schema);
    }

    // 反向：渲染器也不能凭空多出注册表里没有的类型
    //（`plan` 是专用渲染器，`*` 是兜底渲染器，两者本来就不在注册表里）。
    for (const name of names) {
      if (name === PLAN_ACTIVITY_TYPE || name === WILDCARD_ACTIVITY_TYPE) continue;
      expect(listCoreComponents()).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('plan 活动有专用渲染器，且 content schema 能接住服务端那份形状', () => {
    const renderer = rendererOf(PLAN_ACTIVITY_TYPE);
    expect(renderer.activityType).toBe('plan');

    const result = schemaOf(PLAN_ACTIVITY_TYPE).safeParse({
      planId: 'plan-1',
      revision: 2,
      status: 'running',
      summary: '三天两夜成都',
      steps: [],
    });
    expect(result.success).toBe(true);

    // 带步骤的完整载荷也要能接住。
    const withSteps = schemaOf(PLAN_ACTIVITY_TYPE).safeParse({
      planId: 'plan-1',
      revision: 2,
      status: 'running',
      summary: '三天两夜成都',
      steps: [{ id: 's1', title: '订机票', status: 'running' }],
    });
    expect(withSteps.success).toBe(true);

    // ★ 更强的断言：`ComponentRenderer` 真正拿去校验的 `zPlanViewProps`
    // 也必须接住这两份形状 —— 这才是"服务端 shape 与内核 schema 兼容"的实质。
    // 传输层 schema 是刻意放宽的（否则 CopilotKit 会先校验失败并整卡不渲染），
    // 所以只测它是不够的。
    expect(zPlanViewProps.safeParse({
      planId: 'plan-1',
      revision: 2,
      status: 'running',
      summary: '三天两夜成都',
      steps: [],
    }).success).toBe(true);
    expect(zPlanViewProps.safeParse({
      planId: 'plan-1',
      revision: 2,
      status: 'running',
      summary: '三天两夜成都',
      steps: [{ id: 's1', title: '订机票', status: 'running' }],
    }).success).toBe(true);
  });

  it('plan 的传输层 schema 必须放行不合法载荷，否则降级链根本跑不到', () => {
    // CopilotKit 在 render 之前先 `~standard.validate(content)`，
    // 失败就 return null（整卡不渲染）。所以传输层**不能**在这里把关，
    // 校验必须留给 ComponentRenderer —— 它失败会渲染「原始载荷」而不是白屏。
    const malformed = {
      planId: 'plan-1',
      revision: 1,
      status: 'draft',
      summary: '坏载荷',
      steps: 'not-an-array',
    };
    expect(schemaOf(PLAN_ACTIVITY_TYPE).safeParse(malformed).success).toBe(true);
    expect(zPlanViewProps.safeParse(malformed).success).toBe(false);
  });

  it('通配符渲染器存在，且未知活动类型落到降级态而不是空白', async () => {
    const renderer = rendererOf(WILDCARD_ACTIVITY_TYPE);
    expect(renderer.activityType).toBe('*');
    // 兜底必须放行任何载荷，否则又变成"校验失败 → 整卡不渲染"。
    expect(schemaOf(WILDCARD_ACTIVITY_TYPE).safeParse({ anything: [1, 2, 3] }).success).toBe(true);

    const { container } = render(
      createElement(renderer.render, {
        activityType: 'TotallyUnknownCard',
        content: { foo: 'bar' },
        message: fakeMessage,
        agent: makeAgent(),
      }),
    );

    await waitFor(() => {
      expect(container.textContent ?? '').toMatch(DEGRADE_MARKER);
    });
  });

  it('领域组件即使不在渲染器快照里，也能经兜底渲染器渲染出来', async () => {
    registerDomainComponents('domain-test', [
      {
        name: 'DomainOnlyCard',
        description: '领域专属卡片',
        schema: zPlanViewProps,
        requiredProps: [],
        modelCallable: false,
        lazy: false,
        load: async () => ({
          default: () => createElement('div', null, '我是领域卡片'),
        }),
      },
    ]);

    const renderer = rendererOf(WILDCARD_ACTIVITY_TYPE);

    const { container } = render(
      createElement(
        DomainIdProvider,
        {
          domainId: 'domain-test',
          children: createElement(renderer.render, {
            activityType: 'DomainOnlyCard',
            content: {},
            message: fakeMessage,
            agent: makeAgent(),
          }),
        },
      ),
    );

    await waitFor(() => {
      expect(container.textContent ?? '').toContain('我是领域卡片');
    });
  });

  it('不合法的 content 落到降级态，绝不白屏、绝不抛异常', async () => {
    const renderer = rendererOf(PLAN_ACTIVITY_TYPE);

    const { container } = render(
      createElement(renderer.render, {
        activityType: PLAN_ACTIVITY_TYPE,
        content: {
          planId: 'plan-1',
          revision: 1,
          status: 'draft',
          summary: '坏载荷',
          steps: 'not-an-array',
        },
        message: fakeMessage,
        agent: makeAgent(),
      }),
    );

    await waitFor(() => {
      expect(container.textContent ?? '').toMatch(DEGRADE_MARKER);
    });
    // 正常渲染分支的文字不能出现 —— 证明确实降级了，不是"恰好渲染成功"。
    expect(container.textContent ?? '').not.toContain('还没有步骤');
  });

  it('注册表组件的 content 不合法时同样降级', async () => {
    const renderer = rendererOf('ClarifyOptions');

    const { container } = render(
      createElement(renderer.render, {
        activityType: 'ClarifyOptions',
        content: { prompt: '选一个', options: 12345 },
        message: fakeMessage,
        agent: makeAgent(),
      }),
    );

    await waitFor(() => {
      expect(container.textContent ?? '').toMatch(DEGRADE_MARKER);
    });
  });

  it('CalendarField 与 ChoiceGroupField 已注册且可懒加载', () => {
    registerCoreUIComponents();

    for (const name of ['CalendarField', 'ChoiceGroupField']) {
      const definition = resolveComponent('', name);
      expect(definition, `${name} 未注册`).toBeDefined();
      expect(typeof definition!.load, `${name} 缺少懒加载入口`).toBe('function');
      // 空 props 也必须能过 schema（全部键都有默认值），否则会永久卡在骨架。
      expect(definition!.schema.safeParse({}).success).toBe(true);
      expect(aguiActivityRenderers.map((item) => item.activityType)).toContain(name);
    }
  });

  it('澄清答案送不出去时给出可见提示，绝不静默丢弃', async () => {
    const renderer = rendererOf('ClarifyOptions');

    render(
      createElement(renderer.render, {
        activityType: 'ClarifyOptions',
        content: {
          questionId: 'q1',
          prompt: '选一个',
          options: [{ id: 'opt-a', label: '方案 A' }],
        },
        message: fakeMessage,
        agent: makeAgent([]), // ← 没有 pending interrupt
      }),
    );

    fireEvent.click(await screen.findByText('方案 A'));

    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').textContent ?? '').toContain('当前没有待回复的中断');
  });

  it('有 pending interrupt 时，澄清答案经 resolve({ answers }) 回灌', async () => {
    const resolve = vi.fn();
    const renderer = rendererOf('ClarifyOptions');

    render(
      createElement(renderer.render, {
        activityType: 'ClarifyOptions',
        content: {
          questionId: 'q1',
          prompt: '选一个',
          options: [{ id: 'opt-a', label: '方案 A' }],
        },
        message: fakeMessage,
        agent: makeAgent([{ id: 'interrupt-1', resolve }]),
      }),
    );

    fireEvent.click(await screen.findByText('方案 A'));

    await waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(1);
    });
    expect(resolve).toHaveBeenCalledWith({ answers: { q1: 'opt-a' } });
  });
});

describe('DomainIdContext', () => {
  let lastSeen = 'unset';
  function Probe(): null {
    // 只记录 hook 的返回值，不为断言渲染额外 DOM。
    lastSeen = useDomainId();
    return null;
  }

  it('缺省是空串，且空串能回落到内核组件（不抛错）', () => {
    render(createElement(Probe));
    expect(lastSeen).toBe('');

    expect(resolveComponent('', 'PlanView')).toBeDefined();
    expect(resolveComponent('', 'CalendarField')).toBeDefined();
  });

  it('provider 注入的 domainId 能被读到', () => {
    render(
      createElement(DomainIdProvider, {
        domainId: 'travel',
        children: createElement(Probe),
      }),
    );
    expect(lastSeen).toBe('travel');
  });

  it('没有 provider 时卡片依然渲染得出来（回落到内核组件）', async () => {
    const renderer = rendererOf('CalendarField');

    const { container } = render(
      createElement(renderer.render, {
        activityType: 'CalendarField',
        content: {},
        message: fakeMessage,
        agent: makeAgent(),
      }),
    );

    await waitFor(() => {
      expect(container.querySelector('button')).toBeTruthy();
    });
    expect(container.textContent ?? '').not.toMatch(DEGRADE_MARKER);
  });
});

describe('buildAguiActivityRenderers', () => {
  it('每次调用都能重新按注册表生成渲染器', () => {
    const rebuilt = buildAguiActivityRenderers();
    expect(rebuilt.length).toBe(aguiActivityRenderers.length);
    expect(rebuilt.map((item) => item.activityType)).toEqual(
      aguiActivityRenderers.map((item) => item.activityType),
    );
    for (const item of rebuilt) {
      expect(typeof item.render).toBe('function');
    }
  });
});

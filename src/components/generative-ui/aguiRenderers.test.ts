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
} from './aguiRenderers';
import { resolveComponent, listCoreComponents } from './registry';
import { registerCoreUIComponents } from './coreComponents';

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

    // 反向：渲染器也不能凭空多出注册表里没有的类型（`plan` 是唯一的例外）。
    for (const name of names) {
      if (name === PLAN_ACTIVITY_TYPE) continue;
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

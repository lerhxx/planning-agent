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
  planAnswers,
  WILDCARD_ACTIVITY_TYPE,
} from './aguiRenderers';
import { zGoal, makeFormKey, parseFormKey } from '@/shared/plan/types';
import { applyAnswers } from '@/src/core/goal/clarify';
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

/**
 * 每个内核组件一份"必然被它自己的 schema 拒绝"的载荷。
 *
 * 尽量取 **delta 中间态的真实形态**（字段只长了一半），而不是随手造一个垃圾值 ——
 * 这样断言才有说服力：`StepItem` 缺必填 `id`、`ChoiceGroupField` 的 `groups` 还是字符串……
 * 都是 `ACTIVITY_DELTA` 逐条长出过程中的真实中间帧。
 */
const MALFORMED_CONTENT: Record<string, Record<string, unknown>> = {
  PlanView: { steps: 'not-an-array' },
  StepItem: { title: '订机票' }, // 缺必填 id
  RawPayloadCard: { title: 42 },
  ClarifyOptions: { options: 'not-an-array' },
  ErrorState: { recoverable: 'yes' },
  SkeletonList: { rows: 'three' },
  CalendarField: { tabs: 'not-an-array' },
  ChoiceGroupField: { groups: 'not-an-array' },
};

afterEach(() => {
  cleanup();
});

describe('aguiActivityRenderers', () => {
  it('注册表里每个组件都有一个同名渲染器，且传输层一律放行', () => {
    registerCoreUIComponents();
    const names = aguiActivityRenderers.map((item) => item.activityType);

    // 注册表里的组件一个都不能漏。
    for (const name of listCoreComponents()) {
      expect(names, `注册表里的 ${name} 没有对应渲染器`).toContain(name);
      const definition = resolveComponent('', name);
      expect(definition, `注册表里查不到 ${name}`).toBeDefined();
      // ★ 传输层**不再**等于 `def.schema`：它必须放行任意载荷，
      // 否则 CopilotKit 会在 render 之前校验失败并整卡不渲染（白屏）。
      // 真正的校验留给 ComponentRenderer —— 下面有用例逐个证明它确实还在校验。
      expect(
        schemaOf(name).safeParse({ 半截字段: [1, 2, 3] }).success,
        `${name} 的传输层没有放行`,
      ).toBe(true);
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

  it('每个内核组件：传输层放行 + def.schema 拒 + 渲染落降级态（三者缺一不可）', async () => {
    registerCoreUIComponents();

    for (const name of listCoreComponents()) {
      const bad = MALFORMED_CONTENT[name];
      expect(bad, `缺少 ${name} 的坏载荷夹具`).toBeDefined();

      // ① 传输层必须放行 —— 否则 CopilotKit 会在 render 之前就 return null（白屏）。
      expect(schemaOf(name).safeParse(bad).success, `${name} 的传输层没有放行`).toBe(true);

      // ② 真正的校验必须还在 def.schema 里 —— 只测 ① 是假绿。
      const definition = resolveComponent('', name);
      expect(definition).toBeDefined();
      expect(
        definition!.schema.safeParse(bad).success,
        `${name} 的 schema 竟然接受了坏载荷（校验被挪走了）`,
      ).toBe(false);

      // ③ 渲染必须是降级态而不是空白 —— 只测 ② 证明不了降级链真的接管了。
      const { container, unmount } = render(
        createElement(rendererOf(name).render, {
          activityType: name,
          content: bad,
          message: fakeMessage,
          agent: makeAgent(),
        }),
      );
      await waitFor(() => {
        expect(
          container.textContent ?? '',
          `${name} 拿到坏载荷后渲染成空白，降级链没接管`,
        ).toMatch(DEGRADE_MARKER);
      });
      unmount();
    }
  });

  it('delta 中间态（必填键还没到）渲染骨架，而不是空白', async () => {
    // `ClarifyOptions.requiredProps = ['prompt']`：prompt 到达之前 schema 仍通过
    // （prompt 可选），但 props 未补齐 → `decideDegrade` 判骨架。
    // 这正是 ACTIVITY_SNAPSHOT（content = {}）→ 逐条 delta 长出的第一帧。
    const renderer = rendererOf('ClarifyOptions');

    const { container } = render(
      createElement(renderer.render, {
        activityType: 'ClarifyOptions',
        content: {},
        message: fakeMessage,
        agent: makeAgent(),
      }),
    );

    await waitFor(() => {
      expect(container.textContent ?? '').toContain('组件生成中');
    });
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
          questionId: 'clarify:constraint.budget',
          prompt: '预算上限是多少？',
          options: [{ id: '500', label: '≤ ¥500' }],
        },
        message: fakeMessage,
        agent: makeAgent([]), // ← 没有 pending interrupt
      }),
    );

    fireEvent.click(await screen.findByText('≤ ¥500'));

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
          // 引擎下发的 questionId 形如 `clarify:<missingField>`（见 buildClarifyQuestions）
          questionId: 'clarify:constraint.budget',
          prompt: '预算上限是多少？',
          options: [{ id: '500', label: '≤ ¥500' }],
        },
        message: fakeMessage,
        agent: makeAgent([{ id: 'interrupt-1', resolve }]),
      }),
    );

    fireEvent.click(await screen.findByText('≤ ¥500'));

    await waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(1);
    });
    expect(resolve).toHaveBeenCalledWith({
      answers: { 'clarify:constraint.budget': '500' },
    });
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

describe('planAnswers · 目标澄清（select_option → applyAnswers）', () => {
  function goalMissing(...fields: string[]) {
    return zGoal.parse({
      id: 'goal-1',
      runId: 'run-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      missingFields: fields,
    });
  }

  it('键必须是 clarify:<字段> 形（不是随便一个前缀）', () => {
    const plan = planAnswers({
      type: 'select_option',
      questionId: 'clarify:constraint.budget',
      optionId: '500',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    for (const key of Object.keys(plan.answers)) {
      expect(key).toMatch(/^clarify:/);
    }
  });

  it('★ 端到端：applyAnswers 真的吃到了 —— 字段从 missingFields 消失且约束被写入', () => {
    const plan = planAnswers({
      type: 'select_option',
      questionId: 'clarify:constraint.budget',
      optionId: '500',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const before = goalMissing('constraint.budget');
    const after = applyAnswers(before, plan.answers);

    // 只断言"键名带 clarify: 前缀"是假绿 —— 这里证明内核真的消费了。
    expect(after.missingFields).not.toContain('constraint.budget');
    expect(after.missingFields).toEqual([]);
    expect(after.constraints).toEqual([
      { kind: 'budget', value: '500', raw: 'budget<=500' },
    ]);
    expect(after.resources.budgetCNY).toBe(500);
  });

  it('★ 对照组：键不带 clarify: 前缀时，内核**不会**消费（追问死循环的前兆）', () => {
    const wrong = { 'constraint.budget': '500' }; // 裸字段名，applyAnswers 查不到
    const after = applyAnswers(goalMissing('constraint.budget'), wrong);
    expect(after.missingFields).toContain('constraint.budget');
    expect(after.constraints).toEqual([]);

    // 所以 planAnswers 必须在这种键形上直接拒绝，而不是照发。
    const plan = planAnswers({ type: 'select_option', questionId: 'q1', optionId: '500' });
    expect(plan.ok).toBe(false);
  });

  it('questionId 缺失 / 不是 clarify: 形 → 拒绝发送（不静默丢一个必然被丢弃的值）', () => {
    for (const questionId of [undefined, '', 'q1', 'clarify:']) {
      const plan = planAnswers({ type: 'select_option', questionId, optionId: '500' });
      expect(plan.ok, `questionId=${String(questionId)} 不该被放行`).toBe(false);
    }
  });

  it('多选 JSON 数组值 → 拒绝发送（内核会算成 NaN 然后静默丢弃约束）', () => {
    const plan = planAnswers({
      type: 'select_option',
      questionId: 'clarify:constraint.budget',
      optionId: JSON.stringify(['100', '500']),
    });
    expect(plan.ok).toBe(false);
  });

  it('skip / none / provide 是合法保留值（不产生约束，但字段会被移除）', () => {
    const plan = planAnswers({
      type: 'select_option',
      questionId: 'clarify:constraint.generic',
      optionId: 'none',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const after = applyAnswers(goalMissing('constraint.generic'), plan.answers);
    expect(after.missingFields).toEqual([]);
    expect(after.constraints).toEqual([]);
  });
});

describe('planAnswers · 工具澄清（submit_form → makeFormKey，K3）', () => {
  const QUESTION_ID = 'clarify:travel.trip-brief';

  it('键必须是 makeFormKey(questionId, fieldId)，领域就是这么读的', () => {
    const plan = planAnswers({
      type: 'submit_form',
      questionId: QUESTION_ID,
      values: { days: '3', budget: '2000' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // 领域的读法：`answers[makeFormKey(questionId, fieldId)]`
    expect(plan.answers[makeFormKey(QUESTION_ID, 'days')]).toBe('3');
    expect(plan.answers[makeFormKey(QUESTION_ID, 'budget')]).toBe('2000');
    // 裸 fieldId 不该出现（那是旧的错误形状）
    expect(Object.keys(plan.answers)).not.toContain('days');
  });

  it('★ 每个键都能被 parseFormKey 原样拆回（否则领域查不到）', () => {
    const plan = planAnswers({
      type: 'submit_form',
      questionId: QUESTION_ID,
      values: { days: '3', 'asset:6f1d3f10': 'later' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    for (const [fieldId, key] of [
      ['days', makeFormKey(QUESTION_ID, 'days')],
      ['asset:6f1d3f10', makeFormKey(QUESTION_ID, 'asset:6f1d3f10')],
    ] as const) {
      expect(parseFormKey(key)).toEqual({ questionId: QUESTION_ID, fieldId });
    }
  });

  it('多选值按 K3 用 JSON 数组编码，原样透传（领域侧 safeParse 还原）', () => {
    const encoded = JSON.stringify(['later']);
    const plan = planAnswers({
      type: 'submit_form',
      questionId: QUESTION_ID,
      values: { unresolved_action: encoded },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.answers[makeFormKey(QUESTION_ID, 'unresolved_action')]).toBe(encoded);
  });

  it('缺 questionId → 拒绝发送（拼不出 makeFormKey）', () => {
    const plan = planAnswers({ type: 'submit_form', values: { days: '3' } });
    expect(plan.ok).toBe(false);
  });

  it('表单值不会伪装成 clarify:<字段> 去骗 applyAnswers', () => {
    const plan = planAnswers({
      type: 'submit_form',
      questionId: QUESTION_ID,
      values: { days: '3' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // J3：表单只在工具澄清路径使用，目标澄清恒为扁平选项。
    const after = applyAnswers(
      zGoal.parse({
        id: 'g',
        runId: 'r',
        createdAt: '2026-01-01T00:00:00.000Z',
        missingFields: ['constraint.budget'],
      }),
      plan.answers,
    );
    expect(after.missingFields).toContain('constraint.budget');
  });
});

describe('答案发不得时：可见提示 + 绝不调用 resolve', () => {
  it('questionId 不是 clarify: 形 → 有中断也不发，且给出可见提示', async () => {
    const resolve = vi.fn();
    const renderer = rendererOf('ClarifyOptions');

    render(
      createElement(renderer.render, {
        activityType: 'ClarifyOptions',
        content: {
          questionId: 'q1', // ← 不是 clarify:<字段>
          prompt: '选一个',
          options: [{ id: 'opt-a', label: '方案 A' }],
        },
        message: fakeMessage,
        agent: makeAgent([{ id: 'interrupt-1', resolve }]),
      }),
    );

    fireEvent.click(await screen.findByText('方案 A'));

    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').textContent ?? '').toContain('答案未送出');
    // ★ 关键：不能"看起来提交了" —— resolve 一次都没被调用。
    expect(resolve).not.toHaveBeenCalled();
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

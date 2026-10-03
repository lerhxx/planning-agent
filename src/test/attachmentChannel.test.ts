/**
 * 通用输入通道（T01 ①）+ 表单回灌键（T01 ②）。
 *
 * 证明四件事：
 * 1. `zAttachment` / `zRunRequest.attachments` / `zRunContext.attachments` 都是**通用槽位**；
 * 2. 20 张上限真的拦得住（超限必须报错，**不能静默裁剪**）；
 * 3. **引擎真的把 attachments 过桥进了 `ctx`**，且 `signals` 由附件种类派生（不再是写死的 `['text']`）；
 * 4. `makeFormKey` / `parseFormKey` 的键约定（含 `fieldId` 内含 `:` 的边界）。
 *
 * ★ 第 3 条怎么在不动领域包的前提下观测 `ctx`：
 * 复制一个已注册的领域包，只把 `planning.validateStep` 包一层把 `ctx` 记下来。
 * 内核在 `validatePlan` 里必然调它，因此这是**零领域改动**的观测点。
 */
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_COUNT,
  makeFormKey,
  parseFormKey,
  zAttachment,
  type Attachment,
  type Step,
} from '@/shared/plan/types';
import { zRunContext, zRunRequest } from '@/shared/run/types';
import type { RunContext } from '@/shared/run/types';
import type { StreamEvent } from '@/shared/stream/events';
import { runGoal, type EngineResult } from '@/src/core/run/engine';
import { getDomainPack, registerDomainPack } from '@/src/core/registry/domainRegistry';
import { createMockRuntime } from '@/src/core/runtime/mock';
import { registerAllDomains } from '@/src/domains';

const [BASE_DOMAIN_ID] = registerAllDomains();
const PROBE_DOMAIN_ID = 'probe-channel';

const GOAL = '两路采集后汇总成一版结论，预算不超过 500 元，三天内完成';

function attachment(index: number): Attachment {
  return {
    id: `asset-${index}`,
    kind: 'image',
    name: `shot-${index}.png`,
    mimeType: 'image/png',
    byteSize: 1024,
    ref: `asset://asset-${index}`,
  };
}

let captured: RunContext | null = null;

/** 注册探针领域包（复制既有包，只包一层 `validateStep`）。 */
function registerProbe(): void {
  const base = getDomainPack(BASE_DOMAIN_ID);
  if (!base) throw new Error('基线领域包未注册');
  const result = registerDomainPack({
    ...base,
    meta: { ...base.meta, id: PROBE_DOMAIN_ID },
    planning: {
      ...base.planning,
      validateStep: (step: Step, ctx: RunContext) => {
        captured = ctx;
        return base.planning.validateStep(step, ctx);
      },
    },
  });
  if (!result.ok) throw new Error(`探针领域包注册失败：${result.issues.join('; ')}`);
}

async function runWithAttachments(attachments: Attachment[]): Promise<EngineResult> {
  captured = null;
  registerProbe();
  const events: StreamEvent[] = [];
  return runGoal(
    { goal: GOAL, domainId: PROBE_DOMAIN_ID, simulate: 'none', attachments },
    {
      runtime: createMockRuntime({ latencyMs: 0 }),
      emit: (event) => events.push(event),
      sleep: async () => undefined,
      streamDelayMs: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    },
  );
}

describe('zAttachment（通用输入槽位）', () => {
  it('只带必填三件也能过；`image` 只是 kind 的一个取值', () => {
    const parsed = zAttachment.safeParse({ id: 'a1', kind: 'image', name: 'x.png' });
    expect(parsed.success).toBe(true);
    expect(zAttachment.safeParse({ id: 'a1', kind: 'text', name: 'note.md' }).success).toBe(true);
  });

  it('缺 name / 空 id → 不过（绝不静默吃脏数据）', () => {
    expect(zAttachment.safeParse({ id: 'a1', kind: 'image' }).success).toBe(false);
    expect(zAttachment.safeParse({ id: '', kind: 'image', name: 'x' }).success).toBe(false);
  });

  it('同名共存：两条同名附件互不干扰', () => {
    const same = { id: 'a1', kind: 'image', name: 'dup.png' };
    const other = { ...same, id: 'a2' };
    expect(zAttachment.parse(same).id).not.toBe(zAttachment.parse(other).id);
  });
});

describe('请求体 / 上下文的 attachments 槽位', () => {
  it('zRunRequest 接受附件，且 20 张是硬上限', () => {
    const list = Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, index) => attachment(index));
    expect(zRunRequest.safeParse({ goal: GOAL, attachments: list }).success).toBe(true);

    const tooMany = [...list, attachment(ATTACHMENT_MAX_COUNT)];
    expect(zRunRequest.safeParse({ goal: GOAL, attachments: tooMany }).success).toBe(false);
  });

  it('zRunContext 的 attachments 可省略（槽位空值由引擎补齐为 []）', () => {
    const ctx = zRunContext.parse({
      runId: 'r',
      traceId: 't',
      goalId: 'g',
      domainId: 'd',
      startedAt: '2026-01-01T00:00:00.000Z',
      deadlineAt: '2026-01-01T00:00:25.000Z',
    });
    expect(ctx.attachments ?? []).toEqual([]);
  });
});

describe('引擎过桥（src/core 只动 engine.ts 一个文件）', () => {
  it('attachments 原样进 ctx，signals 由 kind 派生', async () => {
    await runWithAttachments([attachment(1), attachment(2)]);
    expect(captured).not.toBeNull();
    expect(captured!.attachments).toHaveLength(2);
    expect((captured!.attachments ?? []).map((item) => item.id)).toEqual(['asset-1', 'asset-2']);
    expect(captured!.signals).toContain('text');
    expect(captured!.signals).toContain('image');
    // 种类去重：两张都是 image，不该出现两个 image。
    expect(captured!.signals.filter((signal) => signal === 'image')).toHaveLength(1);
  });

  it('无附件时 signals 退回只有 text（既有行为不回归）', async () => {
    await runWithAttachments([]);
    expect(captured).not.toBeNull();
    expect(captured!.attachments).toEqual([]);
    expect(captured!.signals).toEqual(['text']);
  });

  it('★ 不清空 meta：answers 仍是回灌通道的载体', async () => {
    captured = null;
    registerProbe();
    const events: StreamEvent[] = [];
    await runGoal(
      {
        goal: GOAL,
        domainId: PROBE_DOMAIN_ID,
        simulate: 'none',
        attachments: [attachment(1)],
        answers: { 'clarify:tool:s-1::days': '3' },
      },
      {
        runtime: createMockRuntime({ latencyMs: 0 }),
        emit: (event) => events.push(event),
        sleep: async () => undefined,
        streamDelayMs: 0,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      },
    );
    expect(captured).not.toBeNull();
    expect(captured!.meta.answers).toEqual({ 'clarify:tool:s-1::days': '3' });
  });
});

describe('表单回灌键约定（K3）', () => {
  it('makeFormKey / parseFormKey 往返', () => {
    const key = makeFormKey('clarify:tool:s-1', 'days');
    expect(key).toBe('clarify:tool:s-1::days');
    expect(parseFormKey(key)).toEqual({ questionId: 'clarify:tool:s-1', fieldId: 'days' });
  });

  it('fieldId 内含 `:` 时按**最后一个** `::` 切', () => {
    const key = makeFormKey('q', 'a:b');
    expect(parseFormKey(key)).toEqual({ questionId: 'q', fieldId: 'a:b' });
  });

  it('非法键 → null（不静默产生半个键）', () => {
    expect(parseFormKey('nope')).toBeNull();
    expect(parseFormKey('::x')).toBeNull();
    expect(parseFormKey('q::')).toBeNull();
  });
});

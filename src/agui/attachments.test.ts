/**
 * `/api/agui` 的**附件通道**（传输层）回归。
 *
 * 盯住四件事（对应本项目"禁止静默失败"的红线）：
 * 1. 附件真的过桥进了内核 `ctx`，`signals` 由附件 `kind` 派生（`text` 之外的种类要出现）；
 * 2. ★ K9 兜底：有附件时 `requireConstraints` 被强制关掉，图片流程不会被"还缺少约束条件"卡死；
 * 3. 附件不合法（超 20 个 / 类型不对 / 元素缺字段）→ **400 BAD_ATTACHMENTS**，绝不退化成"当没传"；
 * 4. 不带附件时行为与改动前完全一致（`attachments: []`、`signals: ['text']`）。
 *
 * ★ 第 1、2 条怎么在不动领域包的前提下观测 `ctx`：与 `src/test/attachmentChannel.test.ts`
 * 同一个手法 —— 复制一个已注册的领域包，只把 `planning.validateStep` 包一层把 `ctx` 记下来。
 * 内核 `validatePlan` 必然调它，因此这是**零领域改动**的观测点。
 *
 * ★ 为什么必须打端点（而不是只测纯函数）：附件能不能到内核，取决于
 * `app/api/agui/route.ts` 里 `runGoal({...})` 那一行**有没有传** `attachments`。
 * 纯函数测不到"根本没接线"这类错误（现在这条通道断的就是这一处）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_COUNT,
  type Attachment,
  type Step,
} from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import { getDomainPack, registerDomainPack } from '@/src/core/registry/domainRegistry';
import { registerAllDomains } from '@/src/domains';
import {
  parseForwardedAttachments,
  resolveRequireConstraints,
  zForwardedAttachments,
} from '@/app/api/agui/attachments';
import { POST } from '@/app/api/agui/route';

const [BASE_DOMAIN_ID] = registerAllDomains();
const PROBE_DOMAIN_ID = 'probe-agui-attachments';

/**
 * 目标文案：**不含任何约束关键词**（预算 / 期限 / 数量 / 排除项），
 * 因此 `requireConstraints: true` 时必然被判"信息不足"走澄清 ——
 * 这让"有没有被追问卡住"成为一个可观测的开关。
 */
const GOAL = '帮我看看这张图里有什么，整理成一份清单';

let captured: RunContext | null = null;

/** 探针领域包：复制基线包，只包一层 `validateStep` 把 ctx 抓出来。 */
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

function attachment(index: number, kind: Attachment['kind'] = 'image'): Attachment {
  return {
    id: `asset-${index}`,
    kind,
    name: `shot-${index}.png`,
    mimeType: 'image/png',
    byteSize: 1024,
    ref: `asset://asset-${index}`,
  };
}

interface RunResult {
  status: number;
  events: Array<Record<string, unknown>>;
  body: Record<string, unknown> | null;
}

/** 打一次端点；200 时把 SSE 拆成事件数组，非 200 时把 JSON 错误体带回来。 */
async function postAgui(forwardedProps: Record<string, unknown>): Promise<RunResult> {
  captured = null;
  const payload = {
    threadId: 'thread-attachments',
    runId: 'run-attachments',
    messages: [{ id: 'm1', role: 'user', content: GOAL }],
    forwardedProps: { domainId: PROBE_DOMAIN_ID, ...forwardedProps },
  };

  const response = await POST(
    new Request('http://localhost/api/agui', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  );

  if (response.status !== 200) {
    return {
      status: response.status,
      events: [],
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  const text = await response.text();
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
  return { status: response.status, events, body: null };
}

/** 取 RUN_FINISHED 帧（端点保证只发一次）。 */
function runFinished(result: RunResult): Record<string, unknown> | undefined {
  return result.events.find((event) => event.type === 'RUN_FINISHED');
}

function outcomeType(result: RunResult): string | undefined {
  const outcome = runFinished(result)?.outcome as { type?: string } | undefined;
  return outcome?.type;
}

beforeAll(() => {
  registerProbe();
});

describe('parseForwardedAttachments（纯函数口径）', () => {
  it('没这个键 / 值是 undefined → 视为"没传附件"（attachments 为 undefined）', () => {
    expect(parseForwardedAttachments(undefined)).toEqual({ ok: true, attachments: undefined });
    expect(parseForwardedAttachments({})).toEqual({ ok: true, attachments: undefined });
    expect(parseForwardedAttachments({ attachments: undefined })).toEqual({
      ok: true,
      attachments: undefined,
    });
  });

  it('传 [] → 合法空数组（不报错，也不被当成"没传"）', () => {
    const parsed = parseForwardedAttachments({ attachments: [] });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.attachments).toEqual([]);
  });

  it(`20 个是硬上限，第 ${ATTACHMENT_MAX_COUNT + 1} 个必须失败（绝不静默裁剪）`, () => {
    const list = Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, index) => attachment(index));
    expect(zForwardedAttachments.safeParse(list).success).toBe(true);
    expect(zForwardedAttachments.safeParse([...list, attachment(99)]).success).toBe(false);
  });

  it('类型不对 / 元素缺字段 → 失败并给出可读原因（含路径）', () => {
    const wrongType = parseForwardedAttachments({ attachments: 'asset-1' });
    expect(wrongType.ok).toBe(false);
    expect(wrongType.ok === false && wrongType.message).toContain('forwardedProps.attachments');

    const missingField = parseForwardedAttachments({ attachments: [{ id: 'a1', kind: 'image' }] });
    expect(missingField.ok).toBe(false);
    expect(missingField.ok === false && missingField.issues.length).toBeGreaterThan(0);

    // ★ `null` 也算"显式传了但类型不对"：不许静默当成没附件。
    expect(parseForwardedAttachments({ attachments: null }).ok).toBe(false);
  });
});

describe('K9 兜底：resolveRequireConstraints', () => {
  it('有附件 → 强制 false（无论客户端要什么）', () => {
    expect(resolveRequireConstraints(true, [attachment(1)])).toBe(false);
    expect(resolveRequireConstraints(false, [attachment(1)])).toBe(false);
  });

  it('空数组 / 没传 → 原样保留客户端口径（不回归）', () => {
    expect(resolveRequireConstraints(true, [])).toBe(true);
    expect(resolveRequireConstraints(true, undefined)).toBe(true);
    expect(resolveRequireConstraints(false, undefined)).toBe(false);
  });
});

/**
 * ★ 传输层的**盲区**（由 v2-ui-shell 提示后显式化）。
 *
 * 客户端 `useAttachments` 只把 `status === 'ready'` 的条目放进
 * `forwardedProps.attachments`，上传中/失败的留在列表里标红由用户自己删。
 * 也就是说服务端按契约**收不到**非 ready 的条目。
 *
 * 但这是**客户端纪律**，不是服务端能力：本端点只认描述符形状，既不查资产库、
 * 也看不出条目状态。下面三条把"拦不住"写成断言 —— 目的不是证明能拦，
 * 而是防止哪天有人误以为"服务端会挡住上传失败的附件"，从而悄悄撤掉客户端那道闸。
 * 真要靠服务端挡，必须**新增**校验（那就会让这些用例失败，逼人把口径写清楚）。
 */
describe('传输层的盲区：只认形状，不认状态（别把它当成第二道闸）', () => {
  it('★ 孤儿 ref 过得去：服务端不查 asset 是否真的存在', () => {
    const parsed = parseForwardedAttachments({
      attachments: [{ id: 'a1', kind: 'image', name: 'shot.png', ref: 'asset://根本不存在' }],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.attachments?.[0]?.ref).toBe('asset://根本不存在');
  });

  it('★ ref 可省略：zAttachment 里它就是可选字段，缺了不算错', () => {
    const parsed = parseForwardedAttachments({
      attachments: [{ id: 'a1', kind: 'image', name: 'shot.png' }],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.attachments?.[0]).toEqual({
      id: 'a1',
      kind: 'image',
      name: 'shot.png',
    });
  });

  it('★ 多出来的 `status` 会被 schema 剥掉：服务端**无法**据此区分 ready / uploading', () => {
    const parsed = parseForwardedAttachments({
      attachments: [{ id: 'a1', kind: 'image', name: 'shot.png', status: 'uploading' }],
    });
    expect(parsed.ok).toBe(true);
    // 形状照样合法 —— 所以"只发 ready"这条纪律只能由客户端守。
    expect(parsed.ok && parsed.attachments?.[0]).toEqual({
      id: 'a1',
      kind: 'image',
      name: 'shot.png',
    });
  });
});

describe('端点接线：/api/agui → 内核 ctx', () => {
  it(
    '★ 附件真的进 ctx，signals 由 kind 派生（含去重）',
    async () => {
      const result = await postAgui({ attachments: [attachment(1), attachment(2)] });

      expect(result.status).toBe(200);
      expect(captured).not.toBeNull();
      expect((captured!.attachments ?? []).map((item) => item.id)).toEqual(['asset-1', 'asset-2']);
      // ★ `ref` 也必须原样过去：引用优先的通道里，ref 被吞掉等同于"附件到了但取不到字节"，
      // 而这种现象在界面上毫无提示 —— 与静默丢附件同族。
      expect((captured!.attachments ?? []).map((item) => item.ref)).toEqual([
        'asset://asset-1',
        'asset://asset-2',
      ]);
      expect(captured!.signals).toContain('text');
      expect(captured!.signals).toContain('image');
      // 两张都是 image：种类只应出现一次。
      expect(captured!.signals.filter((signal) => signal === 'image')).toHaveLength(1);
      expect(outcomeType(result)).toBe('success');
    },
    30_000,
  );

  it(
    '★ K9：有附件 + requireConstraints=true → 实际按 false 跑（不被追问卡住）',
    async () => {
      const result = await postAgui({
        attachments: [attachment(1)],
        requireConstraints: true,
      });

      expect(result.status).toBe(200);
      // 走到了 ctx 构建 = 没停在澄清态；附件也确实进来了。
      expect(captured).not.toBeNull();
      expect((captured!.attachments ?? []).map((item) => item.id)).toEqual(['asset-1']);
      expect(outcomeType(result)).not.toBe('interrupt');
    },
    30_000,
  );

  it(
    '★ 对照组：同样的 requireConstraints=true 但没有附件 → 确实会被澄清拦住',
    async () => {
      const result = await postAgui({ requireConstraints: true });

      expect(result.status).toBe(200);
      // 没有 ctx = 卡在澄清；这说明上一条用例的差异**只**来自 K9 兜底，不是目标文案变了。
      expect(captured).toBeNull();
      expect(outcomeType(result)).toBe('interrupt');
    },
    30_000,
  );

  it(
    '不带附件 → 与改动前完全一致（ctx.attachments 为空、signals 只有 text）',
    async () => {
      const result = await postAgui({});

      expect(result.status).toBe(200);
      expect(captured).not.toBeNull();
      expect(captured!.attachments).toEqual([]);
      expect(captured!.signals).toEqual(['text']);
    },
    30_000,
  );
});

describe('端点接线：校验失败必须 400（绝不静默丢附件）', () => {
  it(`21 个附件 → 400 BAD_ATTACHMENTS（上限 ${ATTACHMENT_MAX_COUNT}）`, async () => {
    const tooMany = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, index) =>
      attachment(index),
    );
    const result = await postAgui({ attachments: tooMany });

    expect(result.status).toBe(400);
    expect(result.body?.error).toBe('BAD_ATTACHMENTS');
    expect(String(result.body?.message)).toContain(String(ATTACHMENT_MAX_COUNT));
    expect(result.events).toEqual([]);
  });

  it('attachments 类型不对（字符串 / 缺字段元素）→ 400，不是"当没传"', async () => {
    const asString = await postAgui({ attachments: 'asset-1' });
    expect(asString.status).toBe(400);
    expect(asString.body?.error).toBe('BAD_ATTACHMENTS');

    const brokenItem = await postAgui({ attachments: [{ id: 'a1', kind: 'image' }] });
    expect(brokenItem.status).toBe(400);
    expect(brokenItem.body?.error).toBe('BAD_ATTACHMENTS');
    expect(Array.isArray(brokenItem.body?.issues)).toBe(true);
  });
});

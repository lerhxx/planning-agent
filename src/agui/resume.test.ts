import { describe, expect, it } from 'vitest';
import { buildResumeWithCancelled, type CancelledResumeEntry } from './resume';

/**
 * 这些用例对应一个真实的阻断性 bug：
 * 用户在澄清卡片上不点选项、直接发新消息 → AG-UI 以
 * "Thread has N pending interrupt(s) not addressed by resume" 硬拦，请求根本发不出去。
 */
describe('buildResumeWithCancelled', () => {
  it('核心回归：有 pending 但本次不带 resume → 全部补成 cancelled', () => {
    const result = buildResumeWithCancelled([{ id: 'i1' }], undefined);

    expect(result).toEqual([{ interruptId: 'i1', status: 'cancelled' }]);
  });

  /**
   * ★ 最重要的一条：绝不能把用户刚提交的答案冲掉。
   * SDK 对同一 interruptId 出现两条时后写的会覆盖前面的 resolved，
   * 所以已经交代过的中断必须原样保留（这里连引用都不换）。
   */
  it('已交代的中断保持原样，不补 cancelled（否则会吞掉用户选项）', () => {
    const resume = [
      { interruptId: 'i1', status: 'resolved', payload: { answers: { budget: '3000' } } },
    ];

    const result = buildResumeWithCancelled([{ id: 'i1' }], resume);

    expect(result).toBe(resume);
    expect(result).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'cancelled' })]),
    );
  });

  it('部分交代：只给没交代的那些补 cancelled，已交代的保持原样', () => {
    const resolvedI1 = { interruptId: 'i1', status: 'resolved', payload: { answers: {} } };

    const result = buildResumeWithCancelled([{ id: 'i1' }, { id: 'i2' }], [resolvedI1]);

    expect(result).toEqual([resolvedI1, { interruptId: 'i2', status: 'cancelled' }]);
  });

  it('无 pending 时不凭空造 resume 数组', () => {
    expect(buildResumeWithCancelled([], undefined)).toBeUndefined();
  });

  it('顺序：原有 resume 在前，补的 cancelled 在后；多个 pending 按传入顺序', () => {
    const existing = [{ interruptId: 'i0', status: 'resolved', payload: { answers: {} } }];

    const result = buildResumeWithCancelled([{ id: 'i2' }, { id: 'i1' }], existing);

    expect(result).toEqual([
      existing[0],
      { interruptId: 'i2', status: 'cancelled' },
      { interruptId: 'i1', status: 'cancelled' },
    ]);
    expect((result as CancelledResumeEntry[]).slice(1).map((entry) => entry.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });
});

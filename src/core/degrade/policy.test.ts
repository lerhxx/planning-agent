import { describe, expect, it } from 'vitest';
import { CORE_DEGRADE_CHAIN } from '@/shared/domain/types';
import { decideDegrade, isPropsComplete, type DegradeInput } from './policy';

const okInput: DegradeInput = {
  componentKnown: true,
  parseOk: true,
  propsComplete: true,
  hasError: false,
  needsClarify: false,
  chain: CORE_DEGRADE_CHAIN,
};

describe('decideDegrade（三级降级，绝不白屏）', () => {
  it('一切正常 → none', () => {
    expect(decideDegrade(okInput).level).toBe('none');
  });

  it('组件未注册 → 一级降级 RawPayloadCard', () => {
    const decision = decideDegrade({ ...okInput, componentKnown: false });
    expect(decision.level).toBe('raw');
    expect(decision.component).toBe('RawPayloadCard');
  });

  it('props 校验失败 → 一级降级 RawPayloadCard', () => {
    const decision = decideDegrade({ ...okInput, parseOk: false });
    expect(decision.level).toBe('raw');
    expect(decision.component).toBe('RawPayloadCard');
  });

  it('显式错误 → 三级降级 ErrorState', () => {
    const decision = decideDegrade({ ...okInput, hasError: true });
    expect(decision.level).toBe('error');
    expect(decision.component).toBe('ErrorState');
  });

  it('置信度不足 → 二级降级 ClarifyOptions', () => {
    const decision = decideDegrade({ ...okInput, needsClarify: true });
    expect(decision.level).toBe('clarify');
    expect(decision.component).toBe('ClarifyOptions');
  });

  it('props 未补齐（还在流式） → 骨架 SkeletonList', () => {
    const decision = decideDegrade({ ...okInput, propsComplete: false });
    expect(decision.level).toBe('skeleton');
    expect(decision.component).toBe('SkeletonList');
  });

  it('优先级：错误 > 澄清 > 校验失败 > 骨架', () => {
    const decision = decideDegrade({
      componentKnown: true,
      parseOk: false,
      propsComplete: false,
      hasError: true,
      needsClarify: true,
      chain: CORE_DEGRADE_CHAIN,
    });
    expect(decision.level).toBe('error');
  });

  it('每个分支都有组件名，不会返回空组件', () => {
    const levels = [
      { ...okInput, componentKnown: false },
      { ...okInput, hasError: true },
      { ...okInput, needsClarify: true },
      { ...okInput, parseOk: false },
      { ...okInput, propsComplete: false },
    ];
    for (const input of levels) {
      expect(decideDegrade(input).component.length).toBeGreaterThan(0);
    }
  });
});

describe('isPropsComplete', () => {
  it('必填齐全 → true', () => {
    expect(isPropsComplete({ title: 'x', items: [] }, ['title'])).toBe(true);
  });

  it('缺必填 → false', () => {
    expect(isPropsComplete({ items: [] }, ['title'])).toBe(false);
  });

  it('值为 undefined 视为缺失', () => {
    expect(isPropsComplete({ title: undefined }, ['title'])).toBe(false);
  });
});

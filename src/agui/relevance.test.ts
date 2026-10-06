/**
 * 离题拦截：纯函数口径（unit project，零模型、零网络）。
 *
 * 盯住三件事：
 * 1. 启发式三态（related / offtopic / neutral）判定正确；
 * 2. 灰区在**无分类器**时按 `neutral-default`（引导）处理；
 * 3. 灰区在**有分类器**时把判定权交给模型，且分类器抛错时保守引导、不向外抛。
 */
import { describe, expect, it, vi } from 'vitest';
import { heuristicRelevance, resolveRelevance } from './relevance';

describe('heuristicRelevance：三态判定', () => {
  it('明显旅游词 → related（行程 / 机票 / 签证 / 想去 …）', () => {
    expect(heuristicRelevance('帮我规划一个三天两夜的东京行程')).toBe('related');
    expect(heuristicRelevance('想订下个月的机票和酒店')).toBe('related');
    expect(heuristicRelevance('去日本需要办签证吗')).toBe('related');
    expect(heuristicRelevance('周末想去周边转转散心')).toBe('related');
  });

  it('明显离题词 → offtopic（编程 / 股票 / 影视 …）', () => {
    expect(heuristicRelevance('帮我写一段 Python 代码')).toBe('offtopic');
    expect(heuristicRelevance('今天股票大盘怎么样')).toBe('offtopic');
    expect(heuristicRelevance('推荐一部好看的科幻电影')).toBe('offtopic');
  });

  it('灰区（无旅游词也无离题词）→ neutral', () => {
    expect(heuristicRelevance('你好')).toBe('neutral');
    expect(heuristicRelevance('现在几点了')).toBe('neutral');
    expect(heuristicRelevance('')).toBe('neutral');
  });
});

describe('resolveRelevance：灰区兜底', () => {
  it('启发式已能决定的，不走分类器', async () => {
    const classify = vi.fn(async () => true);
    expect(await resolveRelevance('帮我规划东京行程', classify)).toEqual({
      related: true,
      method: 'keyword',
    });
    expect(await resolveRelevance('帮我写代码', classify)).toEqual({
      related: false,
      method: 'offtopic-hint',
    });
    // 关键：启发式命中时分类器一次都不该被调用。
    expect(classify).not.toHaveBeenCalled();
  });

  it('灰区 + 无分类器 → neutral-default（引导，不放行进规划）', async () => {
    expect(await resolveRelevance('你好')).toEqual({ related: false, method: 'neutral-default' });
  });

  it('灰区 + 分类器判相关 → model:true', async () => {
    const classify = vi.fn(async () => true);
    // 灰区字符串：既无旅游词也无离题词（"今天心情不太好"）。
    expect(await resolveRelevance('今天心情不太好', classify)).toEqual({
      related: true,
      method: 'model',
    });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('灰区 + 分类器判离题 → model:false', async () => {
    const classify = vi.fn(async () => false);
    expect(await resolveRelevance('帮我推荐个餐厅', classify)).toEqual({
      related: false,
      method: 'model',
    });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('灰区 + 分类器抛错 → 保守引导、不向外抛（neutral-default）', async () => {
    const classify = vi.fn(async () => {
      throw new Error('model timeout');
    });
    await expect(resolveRelevance('随便聊聊', classify)).resolves.toEqual({
      related: false,
      method: 'neutral-default',
    });
  });
});

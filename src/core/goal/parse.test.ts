import { describe, expect, it } from 'vitest';
import { applyAnswers, buildClarifyQuestions, needsClarification } from './clarify';
import { parseGoal } from './parse';

describe('parseGoal', () => {
  it('抽出预算约束', () => {
    const { goal } = parseGoal({ runId: 'r1', raw: '做一件事，预算不超过 500 元' });
    expect(goal.constraints.some((c) => c.kind === 'budget' && c.value === '500')).toBe(true);
    expect(goal.resources.budgetCNY).toBe(500);
  });

  it('抽出期限约束', () => {
    const { goal } = parseGoal({ runId: 'r1', raw: '做一件事，截止 三天 完成' });
    expect(goal.constraints.some((c) => c.kind === 'deadline')).toBe(true);
  });

  it('抽出排除项', () => {
    const { goal } = parseGoal({ runId: 'r1', raw: '做一件事，不要 广告' });
    expect(goal.constraints.some((c) => c.kind === 'avoid')).toBe(true);
  });

  it('描述过短 → 标记为信息不足，不硬猜', () => {
    const { goal, missingFields } = parseGoal({ runId: 'r1', raw: '做个' });
    expect(missingFields).toContain('goal.detail');
    expect(needsClarification(goal)).toBe(true);
  });

  it('requireConstraints：一个约束都没有 → 追问', () => {
    const { missingFields } = parseGoal(
      { runId: 'r1', raw: '这是一段足够长的目标描述' },
      { requireConstraints: true },
    );
    expect(missingFields).toContain('constraint.generic');
  });

  it('默认不强制追问', () => {
    const { missingFields } = parseGoal({ runId: 'r1', raw: '这是一段足够长的目标描述' });
    expect(missingFields).toEqual([]);
  });
});

describe('clarify', () => {
  it('按缺失字段生成问题', () => {
    const { goal } = parseGoal({ runId: 'r1', raw: '做个' });
    const questions = buildClarifyQuestions(goal);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0].id).toBe('clarify:goal.detail');
    expect(questions[0].options.length).toBeGreaterThan(0);
  });

  it('回答后缺失字段被清除', () => {
    const { goal } = parseGoal({ runId: 'r1', raw: '做个' });
    const next = applyAnswers(goal, { 'clarify:goal.detail': 'skip' });
    expect(next.missingFields).toEqual([]);
    expect(needsClarification(next)).toBe(false);
  });

  it('预算回答会写进约束', () => {
    const { goal } = parseGoal({ runId: 'r1', raw: '做一件事' });
    const withMissing = { ...goal, missingFields: ['constraint.budget'] };
    const next = applyAnswers(withMissing, { 'clarify:constraint.budget': '500' });
    expect(next.constraints).toContainEqual({
      kind: 'budget',
      value: '500',
      raw: 'budget<=500',
    });
    expect(next.resources.budgetCNY).toBe(500);
  });

  it('纯函数：不改动入参', () => {
    const { goal } = parseGoal({ runId: 'r1', raw: '做个' });
    const snapshot = JSON.stringify(goal);
    applyAnswers(goal, { 'clarify:goal.detail': 'skip' });
    expect(JSON.stringify(goal)).toEqual(snapshot);
  });
});

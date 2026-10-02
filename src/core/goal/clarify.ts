/**
 * 目标澄清 —— 纯函数，领域无关。
 *
 * 信息不足时**不硬猜**（C0-01）：生成内核通用的澄清问题与候选选项，
 * 由 `ClarifyOptions` 组件呈现给用户点选。
 */
import {
  zClarifyQuestion,
  type ClarifyQuestion,
  type Goal,
  type GoalConstraint,
} from '@/shared/plan/types';

/** 缺失字段 → 澄清问题模板。文案全部内核通用，不含领域语义。 */
const QUESTION_TEMPLATES: Record<
  string,
  { prompt: string; options: Array<{ id: string; label: string; description?: string }> }
> = {
  'goal.detail': {
    prompt: '这个目标描述得还不够具体，希望我按哪种方式继续？',
    options: [
      { id: 'provide', label: '我来补充描述', description: '你再补一句具体要达成什么' },
      { id: 'skip', label: '就这样，先出一版计划', description: '我先给一版，你再改' },
    ],
  },
  'constraint.generic': {
    prompt: '还缺少约束条件，先告诉我最要紧的那一项？',
    options: [
      { id: 'budget', label: '有预算上限', description: '我会把成本当成硬约束' },
      { id: 'deadline', label: '有完成期限', description: '我会把时间当成硬约束' },
      { id: 'none', label: '没有额外约束', description: '按默认口径出一版' },
    ],
  },
  'constraint.budget': {
    prompt: '这件事的预算上限是多少？',
    options: [
      { id: 'none', label: '不设上限' },
      { id: '100', label: '≤ ¥100' },
      { id: '500', label: '≤ ¥500' },
      { id: '2000', label: '≤ ¥2000' },
    ],
  },
  'constraint.deadline': {
    prompt: '希望什么时候之前完成？',
    options: [
      { id: 'none', label: '不设期限' },
      { id: '1d', label: '今天内' },
      { id: '7d', label: '一周内' },
      { id: '30d', label: '一个月内' },
    ],
  },
};

/** 依据缺失字段生成澄清问题（最多 3 条，避免追问轰炸）。 */
export function buildClarifyQuestions(goal: Goal): ClarifyQuestion[] {
  const fields = goal.missingFields.length > 0 ? goal.missingFields : [];
  return fields.slice(0, 3).flatMap((field) => {
    const template = QUESTION_TEMPLATES[field] ?? QUESTION_TEMPLATES['constraint.generic'];
    if (!template) return [];
    return [
      zClarifyQuestion.parse({
        id: `clarify:${field}`,
        prompt: template.prompt,
        options: template.options,
        multi: false,
      }),
    ];
  });
}

/** 回答 → 约束的映射（只认 optionId，不解析自由文本）。 */
function answerToConstraint(field: string, optionId: string): GoalConstraint | null {
  if (optionId === 'skip' || optionId === 'none' || optionId === 'provide') return null;
  if (field === 'constraint.budget') {
    const value = Number(optionId);
    if (!Number.isFinite(value)) return null;
    return { kind: 'budget', value: String(value), raw: `budget<=${value}` };
  }
  if (field === 'constraint.deadline') {
    return { kind: 'deadline', value: optionId, raw: `deadline:${optionId}` };
  }
  if (field === 'constraint.generic') {
    if (optionId === 'budget') return { kind: 'budget', value: '', raw: 'budget:unknown' };
    if (optionId === 'deadline') return { kind: 'deadline', value: '', raw: 'deadline:unknown' };
  }
  return null;
}

/**
 * 把用户的回答写回 Goal。**纯函数**：返回新对象，不改动入参。
 * 回答 'skip' / 'none' 表示用户放弃补充，对应字段从 `missingFields` 中移除。
 */
export function applyAnswers(goal: Goal, answers: Record<string, string>): Goal {
  const constraints = goal.constraints.slice();
  const remainingMissing: string[] = [];

  for (const field of goal.missingFields) {
    const questionId = `clarify:${field}`;
    const optionId = answers[questionId];
    if (!optionId) {
      remainingMissing.push(field);
      continue;
    }
    const constraint = answerToConstraint(field, optionId);
    if (constraint) constraints.push(constraint);
  }

  return {
    ...goal,
    constraints,
    missingFields: remainingMissing,
    resources: {
      ...goal.resources,
      ...(() => {
        const budget = constraints.find((c) => c.kind === 'budget' && c.value !== '');
        return budget ? { budgetCNY: Number(budget.value) } : {};
      })(),
    },
  };
}

/** 是否还需要继续追问。 */
export function needsClarification(goal: Goal): boolean {
  return goal.missingFields.length > 0;
}

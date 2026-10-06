/**
 * 目标澄清 —— 纯函数，领域无关。
 *
 * 信息不足时**不硬猜**（C0-01）：生成内核通用的澄清问题与候选选项，
 * 由 `ClarifyOptions` 组件呈现给用户点选。
 *
 * ★ 领域注入（`clarify` 槽位）：内核只认"缺哪个字段"，**不知道该问什么领域问题**。
 * 因此澄清问题有一个**领域优先**的来源：`DomainClarifyContribution`（见 `shared/domain/types`）。
 * 领域有话说 → 用它的（通常是 `fields` 表单，一次收集齐）；
 * 领域返回 null / 没这个槽位 → 回落到本文的内核模板（旧的扁平选项）。
 * 这条优先序是本文件唯一新增的分支，两条路径的产物都是合法的 `ClarifyQuestion`，
 * 下游（引擎、组件、传输层）**完全不需要区分**。
 */
import {
  zClarifyQuestion,
  type ClarifyQuestion,
  type Goal,
  type GoalConstraint,
} from '@/shared/plan/types';
import type { DomainClarifyContribution } from '@/shared/domain/types';

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

/* ------------------------------------------------------------------ *
 * 领域注入点（领域优先，内核模板兜底）
 * ------------------------------------------------------------------ */

/**
 * 领域是否已经消费掉本轮的答案 → 是则**用领域的目标**（`missingFields` 可能已被摘掉）。
 *
 * ★ 顺序很重要：必须**先**让领域落地答案，**再**判定要不要继续追问。
 * 反过来（先 `needsClarification` 再问领域）的话，领域永远拿不到运行机会 ——
 * 内核已经在 `engine.ts` 的 `needsClarification` 分支里 early-return 了，
 * 工具澄清（领域下发的表单）根本没机会跑。这正是本函数存在的原因。
 *
 * ★ 领域实现有 bug（消费了值却没摘 `missingFields`）时，本函数**不会**替它兜底：
 * 那属于领域 bug，应该在领域自己的测试里红；内核悄悄替它摘字段反而会掩盖问题。
 */
export function applyDomainAnswers(
  goal: Goal,
  answers: Record<string, string>,
  contribution?: DomainClarifyContribution,
): Goal {
  if (!contribution?.applyAnswers) return goal;
  const applied = contribution.applyAnswers(goal, answers);
  // 防御：领域若返回了非法目标（绕过 zGoal 的 undefined / null），宁可原样退回内核目标，
  // 也不能让整轮 run 崩在一个本该"只是没 clarifying"的分支上。
  if (!applied || typeof applied !== 'object') return goal;
  return applied;
}

/**
 * 取本轮要下发的澄清问题：**领域优先，内核模板兜底**。
 *
 * @param onlyField 只澄清这一个缺失字段（引擎下发 `ClarifyOptions` 时只发第一张卡）。
 */
export function buildClarifyQuestionsForField(
  goal: Goal,
  onlyField: string,
  answers: Record<string, string>,
  contribution?: DomainClarifyContribution,
): ClarifyQuestion[] {
  // ① 领域优先：领域能问出**具体字段的表单**（"几天 / 哪天出发 / 什么偏好"），
  //    比内核的"描述太短要不要补充"有用得多 —— 后者对"北京一日游"这种
  //    已经说清城市和天数、只差预算与日期的目标毫无帮助。
  const fromDomain = contribution?.buildQuestion?.({ goal, answers }) ?? null;
  if (fromDomain) {
    // 领域也要守契约：id / prompt 必填。领域包是"插件"，插件不该让整轮 run 崩掉。
    const parsed = zClarifyQuestion.safeParse(fromDomain);
    if (parsed.success) return [parsed.data];
  }

  // ② 兜底：内核通用模板（旧的扁平选项路径，保持向后兼容）。
  const template = QUESTION_TEMPLATES[onlyField] ?? QUESTION_TEMPLATES['constraint.generic'];
  if (!template) return [];
  return [
    zClarifyQuestion.parse({
      id: `clarify:${onlyField}`,
      prompt: template.prompt,
      options: template.options,
      multi: false,
    }),
  ];
}

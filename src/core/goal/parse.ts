/**
 * 目标解析 —— 纯函数，领域无关。
 *
 * 只抽取**通用资源口径**：预算 / 期限 / 数量 / 排除项。它不认识任何领域概念，
 * 因此抽出来的约束对任何领域都成立（"这件事最多花多少钱 / 什么时候前要 / 不要什么"）。
 */
import { z } from 'zod';
import {
  zGoal,
  zGoalConstraint,
  type Goal,
  type GoalConstraint,
} from '@/shared/plan/types';

export const zParseOptions = z.object({
  /** true 时：一个约束都没识别出来也算"信息不足"，先澄清再规划（C0-01）。 */
  requireConstraints: z.boolean().default(false),
  /** 低于该长度视作描述不足。 */
  minRawLength: z.number().int().nonnegative().default(6),
});
export type ParseOptions = z.infer<typeof zParseOptions>;

export interface ParsedGoal {
  goal: Goal;
  /** 需要向用户追问的字段（空数组 = 信息足够）。 */
  missingFields: string[];
}

const BUDGET_PATTERN = /(?:预算|花费|不超过|控制在|最多花|budget|cost)[^\d]{0,8}(\d+(?:\.\d+)?)\s*(元|块|rmb|cny|¥)?/i;
const DEADLINE_PATTERN = /(?:截止|期限|之前|deadline|due|before)[^\d天周月年]{0,6}(\d+\s*(?:天|周|月|年)|[^\s，,。；;]{1,12})/i;
const COUNT_PATTERN = /(\d+)\s*(?:个|条|项|步|次|份)/;
const AVOID_PATTERN = /(?:不要|避免|排除|不含|avoid|exclude|without)\s*([^\s，,。；;、]{1,20})/i;

/**
 * 把用户的自然语言目标解析成结构化 Goal。
 *
 * 失败路径优先：解析不出任何约束时**不硬猜**，而是把缺失字段写进 `missingFields`，
 * 由上层决定是先澄清还是直接规划。
 */
export function parseGoal(
  input: { runId: string; raw: string; goalId?: string; now?: Date },
  options: Partial<ParseOptions> = {},
): ParsedGoal {
  const opts = zParseOptions.parse(options);
  const now = input.now ?? new Date();
  const raw = input.raw ?? '';
  const constraints: GoalConstraint[] = [];

  const budget = BUDGET_PATTERN.exec(raw);
  if (budget) {
    constraints.push(zGoalConstraint.parse({ kind: 'budget', value: budget[1] ?? '', raw: budget[0] }));
  }

  const deadline = DEADLINE_PATTERN.exec(raw);
  if (deadline) {
    constraints.push(
      zGoalConstraint.parse({ kind: 'deadline', value: (deadline[1] ?? '').trim(), raw: deadline[0] }),
    );
  }

  const count = COUNT_PATTERN.exec(raw);
  if (count) {
    constraints.push(zGoalConstraint.parse({ kind: 'count', value: count[1] ?? '', raw: count[0] }));
  }

  const avoid = AVOID_PATTERN.exec(raw);
  if (avoid) {
    constraints.push(
      zGoalConstraint.parse({ kind: 'avoid', value: (avoid[1] ?? '').trim(), raw: avoid[0] }),
    );
  }

  const missingFields: string[] = [];
  if (raw.trim().length < opts.minRawLength) missingFields.push('goal.detail');
  else if (opts.requireConstraints && constraints.length === 0) missingFields.push('constraint.generic');

  const resources = {
    ...(budget ? { budgetCNY: Number(budget[1]) } : {}),
    ...(count ? { maxSteps: Number(count[1]) } : {}),
  };

  const goal: Goal = zGoal.parse({
    id: input.goalId ?? `goal-${input.runId}`,
    runId: input.runId,
    raw,
    summary: raw.trim().slice(0, 200),
    constraints,
    resources: Number.isNaN(resources.budgetCNY) ? {} : resources,
    successCriteria: [],
    missingFields,
    createdAt: now.toISOString(),
  });

  return { goal, missingFields };
}

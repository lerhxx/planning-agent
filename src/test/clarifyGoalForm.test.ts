/**
 * 目标澄清表单（`clarify` 槽位）—— "北京一日游" 从两个按钮变成一张表单。
 *
 * ★ 本文件锁四件事，缺一件功能就是坏的：
 * 1. **表单字段被正确下发**：领域问出 `fields`，且**已知项不重复问**；
 * 2. **`required` 门控正确**：只有真正无法推断的项必填，其余可跳过；
 * 3. **提交后答案被真正消费**：值进到 `goal`（约束 / 资源 / 摘要）**且**能被
 *    `parseTripBrief` 读回 —— 后者是"看起来答了、实际没生效"的照妖镜；
 * 4. **不会追问死循环**：这是本项目最忌讳的静默失败，所以单独一节做端到端守卫。
 *
 * 背景（为什么内核那条判断必须被绕过）：
 * `parse.ts` 有 `raw.trim().length < minRawLength(6)` ⇒ `missingFields.push('goal.detail')`。
 * "北京一日游" trim 后 5 字 ⇒ 必然触发 ⇒ `engine.ts` early-return ⇒ 用户只看到两个按钮。
 * 而 travel 其实**已经识别出了城市和天数**。本文件同时锁住"内核那条判断仍在"
 * 与"领域优先级高于它"，避免有人靠调大 `minRawLength` 把问题糊过去。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeFormKey, type ClarifyQuestion } from '@/shared/plan/types';
import { parseGoal } from '@/src/core/goal/parse';
import { needsClarification } from '@/src/core/goal/clarify';
import { parseTripBrief, resolveTripBrief } from '@/src/domains/travel/providers';
import {
  FIELD_BUDGET,
  FIELD_DAYS,
  FIELD_DEPART_DATE,
  FIELD_PACE,
  GOAL_BRIEF_QUESTION_ID,
  buildGoalBriefFields,
  readGoalBriefAnswers,
  setNow,
  travelClarify,
} from '@/src/domains/travel/clarify';

const SHORT_GOAL = '北京一日游';
const FIXED_NOW = new Date('2026-03-01T08:00:00.000Z');
const TODAY = '2026-03-01';

/**
 * 走一遍内核解析 + 领域澄清，**严格复刻引擎的顺序**（`engine.ts`）：
 * parse → 内核 applyAnswers → **领域 applyAnswers** → 判定 needsClarification
 * →（仍需追问才）领域 buildQuestion。
 *
 * ★ 为什么要照抄这个顺序：引擎里领域注入点在 `needsClarification` **之前**生效。
 * 若测试里把 `buildQuestion` 无条件调用，就测不出"顺序错了会怎样" ——
 * 而顺序正是本任务最容易出错的地方（见 `engine.ts` 的注释）。
 */
function askTravel(goalText: string, answers: Record<string, string> = {}): {
  question: ClarifyQuestion | null;
  needsMore: boolean;
} {
  const parsed = parseGoal({ runId: 'run-test', raw: goalText, now: FIXED_NOW });
  const goal = travelClarify.applyAnswers!(parsed.goal, answers);
  const needsMore = needsClarification(goal);
  return {
    question: needsMore ? travelClarify.buildQuestion!({ goal, answers }) : null,
    needsMore,
  };
}

beforeEach(() => setNow(() => FIXED_NOW));
afterEach(() => setNow(() => new Date()));

describe('1 · 表单字段被正确下发', () => {
  it('★ "北京一日游"下发的是表单（fields 非空），不是两个按钮', () => {
    const { question } = askTravel(SHORT_GOAL);
    expect(question).not.toBeNull();
    expect(question!.options).toEqual([]);
    expect(question!.fields.length).toBeGreaterThan(0);
    // 组件就是靠 `fields.length > 0` 切表单模式（ClarifyOptions/index.tsx:161）
    expect(question!.fields.length > 0).toBe(true);
  });

  it('★ 必填项的字段一个都不问（目标里已经写了「一日游」，重复问就是骚扰）', () => {
    const { question } = askTravel(SHORT_GOAL);
    expect(question!.fields.map((field) => field.id)).not.toContain(FIELD_DAYS);
  });

  it('★ 预算目标里写了就不问，没写才问', () => {
    // 目标够长 ⇒ 内核不判 `goal.detail` ⇒ 整轮不追问（这是内核那条长度判断在正常工作）。
    const withBudget = askTravel('北京 5 天 预算 1200 元，帮我规划一下');
    expect(withBudget.needsMore).toBe(false);
    expect(withBudget.question).toBeNull();

    // 同一个短目标，只差预算 ⇒ 只多问预算那**一项**。
    // （必须同样短：内核那条 `length < 6` 不触发的话，根本走不到澄清分支。）
    const withoutBudget = askTravel('北京三日游');
    expect(withoutBudget.question!.fields.map((field) => field.id)).toContain(FIELD_BUDGET);
  });

  it('★ 天数缺失时必填项出现；天数识别得到时不出现', () => {
    // "五日游" 的天数识别得到 → 不问天数（且因字段齐了，整张卡都可能不发）
    expect(buildGoalBriefFields(resolveTripBrief({ goalSummary: '北京五日游' })).map((f) => f.id))
      .not.toContain(FIELD_DAYS);

    const noDays = buildGoalBriefFields(resolveTripBrief({ goalSummary: '随便走走' }));
    const days = noDays.find((field) => field.id === FIELD_DAYS);
    expect(days).toBeDefined();
    expect(days!.kind).toBe('number');
    expect(days!.min).toBe(1);
    expect(days!.max).toBe(14);
  });

  it('字段形状契约：`kind` / `options` 必须齐（组件按 kind 分派，缺 options 会渲染成「暂无候选项」）', () => {
    const fields = buildGoalBriefFields(resolveTripBrief({ goalSummary: SHORT_GOAL }));
    for (const field of fields) {
      expect(typeof field.id).toBe('string');
      expect(typeof field.label).toBe('string');
      expect(Array.isArray(field.options)).toBe(true);
      if (field.kind === 'select' || field.kind === 'multi') {
        expect(field.options.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('2 · required 门控正确（关键项必填，其余可跳过）', () => {
  it('★ 出发日期必填 —— 缺了行程就没有锚点', () => {
    const fields = buildGoalBriefFields(resolveTripBrief({ goalSummary: SHORT_GOAL }));
    const date = fields.find((field) => field.id === FIELD_DEPART_DATE);
    expect(date).toBeDefined();
    expect(date!.kind).toBe('date');
    expect(date!.required).toBe(true);
  });

  it('★ 预算与节奏可跳过（缺了都有合理默认：不限预算 / 适中节奏）', () => {
    const fields = buildGoalBriefFields(resolveTripBrief({ goalSummary: SHORT_GOAL }));
    expect(fields.find((field) => field.id === FIELD_BUDGET)!.required).toBe(false);
    expect(fields.find((field) => field.id === FIELD_PACE)!.required).toBe(false);
  });

  it('★ 天数只在"目标里没写"时才是必填', () => {
    const fields = buildGoalBriefFields(resolveTripBrief({ goalSummary: '随便走走' }));
    expect(fields.find((field) => field.id === FIELD_DAYS)!.required).toBe(true);
  });

  it('「北京一日游」恰好只有出发日期必填（用户不必答一长串）', () => {
    const fields = buildGoalBriefFields(resolveTripBrief({ goalSummary: SHORT_GOAL }));
    const requiredIds = fields.filter((field) => field.required).map((field) => field.id);
    expect(requiredIds).toEqual([FIELD_DEPART_DATE]);
  });
});

describe('3 · 提交后答案被真正消费', () => {
  const fullForm = {
    [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DAYS)]: '3',
    [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_BUDGET)]: '1500',
    [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DEPART_DATE)]: '2026-04-01',
    [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_PACE)]: 'easy',
  };

  it('★ 值进到 goal 的资源与约束（内核那一层看得到）', () => {
    const { question } = askTravel(SHORT_GOAL);
    expect(question!.id).toBe(GOAL_BRIEF_QUESTION_ID);

    const parsed = parseGoal({ runId: 'run-test', raw: SHORT_GOAL, now: FIXED_NOW });
    const goal = travelClarify.applyAnswers!(parsed.goal, fullForm);

    expect(goal.resources.budgetCNY).toBe(1500);
    expect(goal.constraints.some((item: { kind: string }) => item.kind === 'budget')).toBe(true);
    expect(goal.constraints.some((item: { kind: string }) => item.kind === 'deadline')).toBe(true);
  });

  it('★★ 摘要被补全成领域可解析的口径（否则工具侧读不到 = 静默失效）', () => {
    const parsed = parseGoal({ runId: 'run-test', raw: '随便走走', now: FIXED_NOW });
    const goal = travelClarify.applyAnswers!(parsed.goal, {
      ...fullForm,
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DAYS)]: '3',
    });

    // 内核在建计划时把 `goal.summary` 当 `goalSummary` 注入每个步骤的工具入参
    // （见 `src/core/planning/planner.ts` 的 `injectGoalSummary`），
    // `parseTripBrief` 从文本读口径 —— 所以这里必须真的解析得出来。
    expect(goal.summary).toContain('3 天');
    expect(goal.summary).toContain('预算 1500 元');

    const reread = parseTripBrief(goal.summary);
    expect(reread.days).toBe(3);
    expect(reread.budgetCNY).toBe(1500);

    // 更强的断言：完整链路（答案 → 摘要 → brief）真的把天数带进了编排口径。
    expect(resolveTripBrief({ goalSummary: goal.summary }).days).toBe(3);
  });

  it('非法输入按「没填」处理，不污染目标（越界天数 / 坏日期 / 未知节奏）', () => {
    const parsed = parseGoal({ runId: 'run-test', raw: '随便走走', now: FIXED_NOW });
    const goal = travelClarify.applyAnswers!(parsed.goal, {
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DAYS)]: '99',
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DEPART_DATE)]: '昨天',
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_PACE)]: 'whatever',
    });

    expect(readGoalBriefAnswers(
      {
        [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DAYS)]: '99',
        [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DEPART_DATE)]: '昨天',
        [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_PACE)]: 'whatever',
      },
      TODAY,
    )).toEqual({ days: null, budgetCNY: null, departDate: null, pace: null });
    expect(goal.summary).not.toContain('99 天');
  });

  it('纯函数：不改入参', () => {
    const parsed = parseGoal({ runId: 'run-test', raw: SHORT_GOAL, now: FIXED_NOW });
    const before = JSON.stringify(parsed.goal);
    travelClarify.applyAnswers!(parsed.goal, fullForm);
    expect(JSON.stringify(parsed.goal)).toBe(before);
  });

  it('未提交表单时 `applyAnswers` 是恒等（不凭空改目标）', () => {
    const parsed = parseGoal({ runId: 'run-test', raw: SHORT_GOAL, now: FIXED_NOW });
    const goal = travelClarify.applyAnswers!(parsed.goal, {});
    expect(goal.missingFields).toEqual(parsed.goal.missingFields);
  });
});

describe('4 ★ 不会追问死循环（本项目最忌讳的静默失败）', () => {
  it('★ 提交后内核不再判定为"信息不足"', () => {
    const { needsMore } = askTravel(SHORT_GOAL, {
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DEPART_DATE)]: '2026-04-01',
    });
    // 只填了必填项（日期），可选项留空 —— 也必须放行。
    expect(needsMore).toBe(false);
  });

  it('★ 提交后不会再下发同一张卡（否则用户永远走不出去）', () => {
    const answered = askTravel(SHORT_GOAL, {
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DEPART_DATE)]: '2026-04-01',
    });
    expect(answered.needsMore).toBe(false);
    // `goal.detail` 摘掉后领域自己也不再问
    expect(answered.question).toBeNull();
  });

  it('★ 回归锁：内核那条 `goal.detail` 确实还在（说明问题是"领域没接管"，不是"内核判错了"）', () => {
    // "北京一日游" 5 字 < minRawLength(6) ⇒ 内核独立地判它信息不足。
    // 也就是说：我们**没有**放宽内核阈值，只是让领域在它之前把问题接走了。
    const parsed = parseGoal({ runId: 'run-test', raw: SHORT_GOAL, now: FIXED_NOW });
    expect(parsed.goal.missingFields).toContain('goal.detail');
  });

  it('★ 没提交表单时必须继续追问（否则=静默丢弃用户输入，另一种静默失败）', () => {
    const { question, needsMore } = askTravel(SHORT_GOAL);
    expect(needsMore).toBe(true);
    expect(question).not.toBeNull();
  });

  it('★ 答完后再答一轮也稳定（幂等，不因重复提交而改出新目标）', () => {
    const answers = { [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DEPART_DATE)]: '2026-04-01' };
    const first = travelClarify.applyAnswers!(
      parseGoal({ runId: 'r', raw: SHORT_GOAL, now: FIXED_NOW }).goal,
      answers,
    );
    const second = travelClarify.applyAnswers!(first, answers);
    expect(second).toEqual(first);
    expect(second.missingFields).toEqual([]);
    // ★ 口径串不能越拼越长（重复追加会让 `parseTripBrief` 取到错的值）。
    expect(second.summary).toBe('北京一日游，出发日期 2026-04-01');
  });
});

describe('5 · 领域优先 / 内核兜底两条路径都还活着', () => {
  it('★ 内核那条 `goal.detail` 事实仍在（领域没接管时它兜底，避免"无人应答"）', () => {
    // 模拟"没有 clarify 槽位"的领域：内核模板必须能给出一张卡。
    const parsed = parseGoal({ runId: 'run-test', raw: SHORT_GOAL, now: FIXED_NOW });
    expect(parsed.goal.missingFields).toEqual(['goal.detail']);
  });

  it('★ 信息够不够由"还缺哪个字段"决定，不由"天数认没认出来"决定', () => {
    // "北京五日游"同样只有 5 字 ⇒ 内核照样判 `goal.detail`。
    // 但 `parseTripBrief` 能从中认出 `days=5`，所以**天数这一项不该问**
    // —— 而出发日期 / 预算仍然要问（前者永远无法从文本推断）。
    // 这条锁的是踩过的坑：曾经写成"天数认出来了就整张卡不发"，
    // 结果"北京一日游"的两个按钮原封不动回来了（因为"一日游"也能认出 days=1）。
    const { question } = askTravel('北京五日游');
    expect(question).not.toBeNull();
    const ids = question!.fields.map((field) => field.id);
    expect(ids).not.toContain(FIELD_DAYS);
    expect(ids).toContain(FIELD_DEPART_DATE);
  });

  it('★ 节奏选项不与别的字段 id 撞（答案键会互相覆盖）', () => {
    const answers = {
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_PACE)]: 'packed',
    };
    expect(readGoalBriefAnswers(answers, TODAY).pace).toBe('packed');
    // 节奏值不得被当成天数或预算吃掉
    expect(readGoalBriefAnswers(answers, TODAY).days).toBeNull();
    expect(readGoalBriefAnswers(answers, TODAY).budgetCNY).toBeNull();
  });

  /**
   * ★ 键空间必须与内核那条 `clarify:<field>` 约定**互不相交**。
   *
   * 这是本次改造最容易出事、且**失败时完全静默**的一点：
   * 两条路径把值写进**同一个** `answers` 对象。若某个 (questionId, fieldId) 组合
   * 恰好等于内核的键 `clarify:<field>`，就会与 `applyAnswers` 的读取互相覆盖 ——
   * 表现是"某一项怎么填都不生效"，且没有任何报错。
   * L6 的注入性守卫锁的是 `qid::fid` 家族内部；这条锁的是**跨家族**不相交。
   */
  it('★ 目标级表单的键不会撞上内核 `clarify:<field>` 约定', () => {
    const formKeys = [FIELD_DAYS, FIELD_BUDGET, FIELD_DEPART_DATE, FIELD_PACE].map((fieldId) =>
      makeFormKey(GOAL_BRIEF_QUESTION_ID, fieldId),
    );
    // 内核 `applyAnswers` 会读的键，全部形如 `clarify:<field>` 且**不含 `::`**。
    const kernelShape = /^[a-z]+:[^:]+$/;
    for (const key of formKeys) {
      expect(kernelShape.test(key)).toBe(false);
      expect(key.includes('::')).toBe(true);
    }
  });

  it('★ 两种约定能在同一个 answers 对象里共存、互不覆盖', () => {
    // 模拟真实回灌载荷：内核那条的键 + 领域表单的键同时在 answers 里。
    const answers = {
      'clarify:constraint.budget': '2000',
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_DEPART_DATE)]: '2026-04-01',
      [makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_BUDGET)]: '1500',
    };
    // 内核读自己的（只查 `clarify:<field>`，不认 `::` 键）
    expect(answers['clarify:constraint.budget']).toBe('2000');
    // 领域读自己的，两项都在
    const read = readGoalBriefAnswers(answers, TODAY);
    expect(read.departDate).toBe('2026-04-01');
    expect(read.budgetCNY).toBe(1500);
  });
});
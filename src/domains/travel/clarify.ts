/**
 * travel 领域的目标澄清（`clarify` 槽位）—— **"北京一日游"这类目标的唯一入口**。
 *
 * ★★ 为什么需要这个文件（问题的根）：
 * 内核的 `parseGoal` 有一条**与领域无关**的兜底：`raw.trim().length < minRawLength(6)`
 * ⇒ `missingFields.push('goal.detail')`。"北京一日游" trim 后 5 字 ⇒ 必然触发。
 * 而 travel 侧其实**已经识别出了城市（北京）和天数（1 天）** —— 内核那一句是孤立的、
 * 且与领域重复的判断。它唯一的作用是拦下整轮 run，让用户点两个**毫无信息量**的按钮
 * （"我来补充描述" / "就这样，先出一版计划"）。
 *
 * 所以这里做的事只有一件：**把内核那一句笼统的"描述太短"，换成一张领域真正需要信息的表单。**
 * 已知项（城市 / 天数）绝不重复问；缺什么问什么；关键项必填、其余可跳过。
 *
 * ★ 三条纪律（都是踩过的坑，改代码前请读完）：
 *
 * ① **表单答案必须被真正消费**（否则死循环且不报错）。
 *    `answers` 的键是 `makeFormKey(GOAL_BRIEF_QUESTION_ID, fieldId)`（`qid::fid`），
 *    内核的 `applyAnswers` **只查 `answers['clarify:' + field]`**，一个都认不出来。
 *    所以本文件必须在自己的 `applyAnswers` 里做两件事：
 *    把值写进 `goal`（约束 / 资源），**并把 `goal.detail` 从 `missingFields` 里摘掉**。
 *    漏掉第二步 ⇒ 每轮都重新下发同一张卡 ⇒ 用户永远走不出去，且**没有任何报错**
 *    （`tools.ts` 的 `readAnswers` 长注释记录的就是这类静默失败）。
 *
 * ② **不要复用 `BRIEF_QUESTION_ID`**（`tools.ts:53`）。
 *    那张卡语义是"目标里没写天数"（工具澄清），键被 `tools.ts:336` 以
 *    `makeFormKey(BRIEF_QUESTION_ID, 'days')` 读走。语义混在一起后，
 *    "目标级问的天数"和"工具级问的天数"会互相覆盖，且无法分别追溯。
 *    故另开 `GOAL_BRIEF_QUESTION_ID`。
 *
 * ③ **不要往内核写领域语义**。"天数 / 出发日期 / 预算"这类词只能出现在本目录；
 *    `src/core/**` 与 `shared/**` 只认"槽位"，不认内容（破 0 判据 `v2IndependentVerify` 会扫）。
 *
 * 答完之后值怎么真正影响产出：见 `applyAnswers` 的注释 —— 关键是把答案**同时**写进
 * `goal.constraints` / `goal.resources` 和 `goal.raw + summary`，因为
 * `MockRuntime` 把 `goal.summary` 当作 `goalSummary` 灌进每个工具的入参
 * （`src/core/runtime/mock/script.ts:97`），而 `parseTripBrief` 是**从文本里**读口径的。
 * 只写约束不补文本 ⇒ 工具侧照样读不到 ⇒ "看起来答了，实际没生效"，同样是静默失败。
 */
import { makeFormKey, type ClarifyField, type ClarifyQuestion, type Goal, type GoalConstraint } from '@/shared/plan/types';
import type { DomainClarifyContribution } from '@/shared/domain/types';
import {
  MAX_TRIP_DAYS,
  parseTripBrief,
  resolveTripBrief,
  type TripBrief,
} from './providers';

/**
 * 目标级澄清的 questionId。
 *
 * ★ 与 `BRIEF_QUESTION_ID`（工具级，问天数）语义隔离，见文件头纪律 ②。
 * ★ `clarifyForm.test.ts` 的 L6 词表守卫会检查 id 里不含贴分隔符的冒号 ——
 *   本 id 只含单个 `:`，安全；**将来新增 id 请一并登记进那张表**。
 */
export const GOAL_BRIEF_QUESTION_ID = 'clarify:travel.goal-brief';

/** 表单字段 id。语义与 `parseTripBrief` 能识别的口径**一一对应**（不另造词汇）。 */
export const FIELD_DAYS = 'days';
export const FIELD_BUDGET = 'budget_cny';
export const FIELD_DEPART_DATE = 'depart_date';
export const FIELD_PACE = 'pace';

/** 出行节奏的选项。`easy` 少排、`packed` 多排 —— 真的会改变编排结果的取值。 */
const PACE_OPTIONS = [
  { id: 'easy', label: '轻松', description: '每天少排一点，留出休息时间' },
  { id: 'balanced', label: '适中', description: '早晚各一段，节奏不赶' },
  { id: 'packed', label: '紧凑', description: '尽量多看几个地方' },
];

/** 出发日期的最小可选日：今天。领域不替用户决定"哪天"，只保证不给出过去的日子。 */
function todayISO(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 宽松读一个数值字段：空串 / 非数字 / 越界一律视为"没填"。 */
function readNumber(
  answers: Record<string, string>,
  questionId: string,
  fieldId: string,
  options: { min?: number; max?: number } = {},
): number | null {
  const raw = answers[makeFormKey(questionId, fieldId)];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return null;
  if (options.min !== undefined && value < options.min) return null;
  if (options.max !== undefined && value > options.max) return null;
  return value;
}

/** 宽松读一个日期字段：必须是 `YYYY-MM-DD`，且不早于今天。 */
function readDate(
  answers: Record<string, string>,
  questionId: string,
  fieldId: string,
  today: string,
): string | null {
  const raw = answers[makeFormKey(questionId, fieldId)];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  // 字典序对 `YYYY-MM-DD` 等价于时间序，因此直接比字符串即可（不引 `Date` 解析，避免时区坑）。
  return value >= today ? value : null;
}

/**
 * 依据目标现状算出"还缺什么"，并据此下发字段。
 *
 * ★ **已知项绝不重复问**：`parseTripBrief` 已经认出城市 / 天数 / 预算，就不再问它们。
 * 这是本文件与内核兜底最本质的差别 —— 内核那句 `length < 6` 是**纯长度**判断，
 * 完全不看领域已经识别出了什么。
 *
 * @param brief 从目标原话解析出的口径（`daysFromGoal` 为 null 表示目标里没写天数）。
 */
export function buildGoalBriefFields(brief: TripBrief): ClarifyField[] {
  const fields: ClarifyField[] = [];

  // ① 天数：目标里写了就不问（`daysFromGoal !== null` 即"已识别"）。
  //    没写才问，且**必填** —— 天数直接决定编排出几天，没有默认值可猜。
  if (brief.daysFromGoal === null) {
    fields.push({
      id: FIELD_DAYS,
      kind: 'number',
      label: '这次出行想安排几天？',
      description: `1 ~ ${MAX_TRIP_DAYS} 天`,
      required: true,
      options: [],
      min: 1,
      max: MAX_TRIP_DAYS,
    });
  }

  // ② 出发日期：**唯一必填的"关键项"**。
  //    为什么必填而其他项不必填：其他项缺了都有**合理默认**（预算缺失就不设上限、
  //    节奏缺失就按适中），但"哪天出发"缺了，产出的行程是一份**无锚点**的日程 ——
  //    无法判断景点是否开放、也无法排天气倒序。这是真正"无法推断"的项。
  fields.push({
    id: FIELD_DEPART_DATE,
    kind: 'date',
    label: '哪天出发？',
    description: '用来核对景点开放与当日安排',
    required: true,
    options: [],
    // `min` 不是 `zClarifyField` 的字段（契约里只有 description 能带这句话），
    // 因此下界由 `readDate` 在消费侧保证，不在这里假装契约支持。
  });

  // ③ 预算：目标里写了就不问；没写**可跳过**（跳过 = 不设上限，`budgetCNY` 留 null）。
  if (brief.budgetCNY === null) {
    fields.push({
      id: FIELD_BUDGET,
      kind: 'number',
      label: '这次出行的总预算大约多少？',
      description: '单位：元。可留空 —— 留空表示暂不设预算上限',
      required: false,
      options: [],
      min: 0,
    });
  }

  // ④ 节奏：始终可跳过。它会真的改变编排密度，所以给出候选项而不是自由文本。
  fields.push({
    id: FIELD_PACE,
    kind: 'select',
    label: '希望的出行节奏？',
    description: '可留空，默认按「适中」编排',
    required: false,
    options: PACE_OPTIONS,
  });

  return fields;
}

/**
 * 把 `goal` 的原文**补全成一句领域可解析的口径**。
 *
 * ★ 这是"答案被真正消费"里最容易被漏掉、也最要命的一环。
 * 引擎把 `goal.summary` 当 `goalSummary` 灌进每个工具的入参
 * （`script.ts:97`），而 `parseTripBrief` **只从文本里**读城市 / 天数 / 预算。
 * 所以只往 `goal.constraints` 里塞值是不够的 —— 工具侧读不到，
 * 于是表现为"用户明明填了表单，产出的行程却还是老样子"，且不报错。
 *
 * 追加的口径串刻意复用领域已有的解析口径（`parseTripBrief` 的正则）：
 * - 天数 → `3 天`（命中 `DAYS_ARABIC_PATTERN`）
 * - 预算 → `预算 1200 元`（命中 `BUDGET_PATTERN`）
 * 这样**不需要改 `parseTripBrief`**，也就不会动到既有单测的断言。
 */
function composeEnrichedSummary(
  original: string,
  answered: { days: number | null; budgetCNY: number | null; departDate: string | null; pace: string | null },
): string {
  const parts: string[] = [];
  // ★ 每一项都要判"文本里是不是已经有了"再决定追加 —— 否则**重复提交同一份答案**
  // 会把口径串越拼越长（"出发日期 X，出发日期 X"）。
  // 这不只是难看：`parseTripBrief` 取的是**首个**匹配，重复段一旦顺序变化
  // （比如第二次追加的预算排在原文本预算之前）就会读到错的值 —— 又是一种静默失效。
  // 因此这里的幂等性是正确性要求，不是洁癖。
  const parsed = parseTripBrief(original);
  if (answered.days !== null && parsed.days === null) parts.push(`${answered.days} 天`);
  if (answered.budgetCNY !== null && parsed.budgetCNY === null) {
    parts.push(`预算 ${answered.budgetCNY} 元`);
  }
  // 日期 / 节奏 `parseTripBrief` 不解析，只能按"文本里是否已含该值"判重。
  if (answered.departDate !== null && !original.includes(answered.departDate)) {
    parts.push(`出发日期 ${answered.departDate}`);
  }
  if (answered.pace !== null && !original.includes(`节奏 ${answered.pace}`)) {
    parts.push(`节奏 ${answered.pace}`);
  }
  if (parts.length === 0) return original;
  return `${original}${original.length > 0 ? '，' : ''}${parts.join('，')}`;
}

/** 读出本轮表单答案；未填的项一律为 `null`（区别于 `0` / 空串 —— `0 天` 是非法输入）。 */
export function readGoalBriefAnswers(
  answers: Record<string, string>,
  today: string,
): { days: number | null; budgetCNY: number | null; departDate: string | null; pace: string | null } {
  const paceRaw = answers[makeFormKey(GOAL_BRIEF_QUESTION_ID, FIELD_PACE)];
  const pace =
    typeof paceRaw === 'string' && PACE_OPTIONS.some((option) => option.id === paceRaw.trim())
      ? paceRaw.trim()
      : null;
  return {
    days: readNumber(answers, GOAL_BRIEF_QUESTION_ID, FIELD_DAYS, { min: 1, max: MAX_TRIP_DAYS }),
    budgetCNY: readNumber(answers, GOAL_BRIEF_QUESTION_ID, FIELD_BUDGET, { min: 0 }),
    departDate: readDate(answers, GOAL_BRIEF_QUESTION_ID, FIELD_DEPART_DATE, today),
    pace,
  };
}

/**
 * 领域澄清的两个纯函数。
 *
 * ★ `now` 只用于给日期字段做下界（今天）。默认 `new Date()`，
 *   测试可通过 `setNow` 注入固定时间，避免"跨午夜跑测试"这类偶发失败。
 */
let nowProvider: () => Date = () => new Date();
/** 测试专用：固定"今天"，让日期下界断言可复现。 */
export function setNow(next: () => Date): void {
  nowProvider = next;
}

export const travelClarify: DomainClarifyContribution = {
  /**
   * 产出目标级澄清表单。
   *
   * ★ 判定口径：**"还有 genuinely 缺的字段吗"**，而不是"目标里有没有天数"。
   * 踩过的坑：一开始这里写成 `if (brief.daysFromGoal !== null) return null`
   * （"天数识别到了就算够"），结果 `parseTripBrief('北京一日游')` 能从"一日游"里
   * 认出 `days=1` ⇒ 直接返回 null ⇒ **两个按钮原封不动地又回来了**。
   * 教训：天数只是 `parseTripBrief` 能识别的三件事之一，
   * **"天数识别到了" ≠ "信息够了"** —— 出发日期永远不可能从文本里认出来。
   *
   * ★ 因此本函数只在"一个字段都不剩"时才返回 null（实际由 `depart_date` 兜住，
   *   恒不成立）。保留这个 guard 是为了将来若把 `depart_date` 也改成条件字段时，
   *   不会退化成"下发一张空表单"（空 `fields` 会让组件回落到选项模式，
   *   也就是**悄悄变回两个按钮** —— 又是一种无声的退化）。
   */
  buildQuestion({ goal }): ClarifyQuestion | null {
    const brief = resolveTripBrief({ goalSummary: goal.raw });
    const fields = buildGoalBriefFields(brief);
    if (fields.length === 0) return null;

    return {
      id: GOAL_BRIEF_QUESTION_ID,
      prompt: '这次出行还想确认几项，补齐后我就能出计划（带 * 的必填）',
      options: [],
      fields,
      multi: false,
    };
  },

  /**
   * 把表单答案写回目标。**纯函数**，返回新对象。
   *
   * ★★★ 本函数是死循环防线的执行点（文件头纪律 ①）：
   * 只要用户**提交过一次**表单（`clarify:travel.goal-brief::*` 有任一键），
   * 就必须把 `goal.detail` 从 `missingFields` 里摘掉。
   * 为什么是"提交过就摘"而不是"每个必填项都合法才摘"：
   * 组件侧已经按 `required` 门控了提交按钮（`ClarifyOptions` 的 `missingRequired`），
   * 走到这里的表单**必然**已满足必填。若内核在这里再校验一遍并因"某字段没填"继续追问，
   * 用户看到的就是"我明明点了提交，它又问我一遍" —— 同样是无声的死循环。
   * 所以：**以"收到提交"为终止信号**，值不合法时按"没填"处理（走默认值），而不是继续拦。
   */
  applyAnswers(goal: Goal, answers: Record<string, string>): Goal {
    const submitted = Object.keys(answers).some((key) =>
      key.startsWith(`${GOAL_BRIEF_QUESTION_ID}::`),
    );
    if (!submitted) return goal;

    const today = todayISO(nowProvider());
    const answered = readGoalBriefAnswers(answers, today);

    const constraints: GoalConstraint[] = [...goal.constraints];
    if (answered.budgetCNY !== null && !constraints.some((item) => item.kind === 'budget')) {
      constraints.push({
        kind: 'budget',
        value: String(answered.budgetCNY),
        raw: `budget<=${answered.budgetCNY}`,
      });
    }
    if (answered.departDate !== null && !constraints.some((item) => item.kind === 'deadline')) {
      constraints.push({
        kind: 'deadline',
        value: answered.departDate,
        raw: `depart:${answered.departDate}`,
      });
    }

    const summary = composeEnrichedSummary(goal.raw, answered);

    return {
      ...goal,
      constraints,
      // 预算同步进 `resources`：内核的预算约束校验（`applyAnswers` 里那段）读的是这里，
      // 只写 `constraints` 会让内核那一层看不到。
      resources: {
        ...goal.resources,
        ...(answered.budgetCNY !== null ? { budgetCNY: answered.budgetCNY } : {}),
      },
      // ★ 摘要同步补全：工具侧（`parseTripBrief`）是从文本读口径的，见 `composeEnrichedSummary`。
      summary,
      raw: summary,
      // ★★★ 摘掉 `goal.detail` —— 这一行就是死循环防线的落点。
      missingFields: goal.missingFields.filter((field) => field !== 'goal.detail'),
    };
  },
};
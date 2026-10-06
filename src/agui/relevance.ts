/**
 * 离题拦截（红线路由）—— 判断用户目标是否属于旅游规划范畴。
 *
 * ★ 混合判定（用户选定 2026-10-04）：
 *   1. 明显旅游关键词命中 → 相关（零成本、确定性）；
 *   2. 明显离题词命中 → 离题（零成本）；
 *   3. 灰区（两类都没命中）→ 交给注入的 `classify`（模型兜底）；
 *      若没注入分类器（默认 mock 模式没配真模型）→ 灰区**默认引导**，
 *      避免把模糊输入当目标硬规划（也避免"你好"触发规划）。
 *
 * ★ 与运行时解耦：本文件**不含任何模型基础设施**（不 import `@mastra/*`）。
 *   模型兜底通过 `resolveRelevance` 的可选 `classify` 参数注入；
 *   而"旅游范畴"的具体语义（见下方 `TRAVEL_CLASSIFY_INSTRUSTRUCTION` / `TRAVEL_AFFIRMATIVE`）
 *   由本文件以纯字符串 / 正则形式给出，由 `app/api/agui/route.ts` 喂给
 *   `src/core/runtime/mastra` 的**通用** `createTextClassifier`（该模块不含领域词，守得住红线 8）。
 *
 * ★ 红线 2 的精神同样适用：模型分类结果只决定"放不放行进规划"，影响面小；
 *   真正的 schema 校验仍在 `parse.ts`。这里对模型输出不做任何语义信任。
 */

/**
 * 旅游相关关键词（命中即视为 related，零成本、确定性）。
 * 收录两类信号：
 * - 明确的旅游动作/实体：行程、攻略、机票、酒店、签证……
 * - 口语化的出游意图：出去、转转、散心、想去、周末、假期……
 * 灰区（没命中这些也没命中离题词）交给模型兜底，不在这里硬凑。
 */
const TRAVEL_KEYWORDS: readonly string[] = [
  '旅游', '旅行', '出游', '出行', '行程', '攻略', '路线', '目的地', '景点',
  '玩', '玩儿', '度假', '机票', '航班', '飞机', '高铁', '火车', '租车', '自驾',
  '邮轮', '游轮', '民宿', '酒店', '住宿', '客栈', '签证', '护照', '落地签',
  '跟团', '自由行', '背包客', '徒步', '露营', '海岛', '沙滩', '滑雪', '登山',
  '研学', '亲子游', '蜜月', '毕业旅行', '周边游', '周末游', '出去', '转转',
  '散心', '放松', '逛', '溜达', '想去', '打算去', '准备去', '周末', '假期',
  '年假', '周边', '打卡', '特产', '纪念品', '时差', '货币', '换汇', '最佳季节',
  '最佳时间', '几天', '几日', '几晚', '预算', '去哪', '去哪里', '去哪儿',
];

/**
 * 明显离题词（命中即视为 offtopic，优先于灰区默认，避免误规划）。
 * 这些词基本只会出现在非旅游语境：编程、股票、影视、游戏、医疗……
 */
const OFF_TOPIC_HINTS: readonly string[] = [
  '编程', '代码', '程序', 'bug', '股票', '基金', '理财', '投资', '做饭', '菜谱',
  '电影', '电视剧', '综艺', '音乐', '歌曲', '游戏', '数学', '作业', '考试', '论文',
  '翻译', '健身', '减肥', '医疗', '看病', '医生', '法律', '律师', '恋爱', '心理',
  '星座', '运势', '算命', '足球', '篮球',
];

export type RelevanceMethod =
  | 'keyword'
  | 'offtopic-hint'
  | 'model'
  | 'neutral-default';

export interface RelevanceResult {
  /** 是否属于旅游规划范畴（true = 放行进规划）。 */
  related: boolean;
  /** 命中的判定路径，便于调试与日志。 */
  method: RelevanceMethod;
}

/** 纯启发式：返回三态，不触碰任何模型，零成本、确定性、可单测。 */
export function heuristicRelevance(goal: string): 'related' | 'offtopic' | 'neutral' {
  const text = goal.trim();
  if (text.length === 0) return 'neutral';

  // 1) 明确命中旅游关键词 → 相关。
  if (TRAVEL_KEYWORDS.some((keyword) => text.includes(keyword))) return 'related';

  // 2) 命中明显离题词 → 离题（即使没命中旅游词，也优先判定离题，避免误规划）。
  if (OFF_TOPIC_HINTS.some((keyword) => text.includes(keyword))) return 'offtopic';

  // 3) 灰区：既无旅游词也无离题词（如"你好""帮我写个东西"）。
  return 'neutral';
}

/**
 * 混合判定入口。
 *
 * @param goal 用户目标文本。
 * @param classify 可选模型兜底；不传（或调用抛错）时，灰区按 `neutral-default`
 *   处理——即**引导**而非规划，避免把模糊输入当目标硬规划。
 */
export async function resolveRelevance(
  goal: string,
  classify?: (goal: string) => Promise<boolean>,
): Promise<RelevanceResult> {
  const heuristic = heuristicRelevance(goal);
  if (heuristic === 'related') return { related: true, method: 'keyword' };
  if (heuristic === 'offtopic') return { related: false, method: 'offtopic-hint' };

  // 灰区：交给模型兜底；没模型或模型失败 → 保守引导。
  if (classify) {
    try {
      const related = await classify(goal);
      return { related, method: 'model' };
    } catch (error) {
      // 分类器失败（网络/超时/限流）：保守引导，不强行规划；记日志便于排查。
      console.warn('[relevance] 模型分类失败，灰区按引导处理', error);
    }
  }
  return { related: false, method: 'neutral-default' };
}

/**
 * 离题时下发的小助手引导文案（旅游规划小助手人设）。
 * 不含 emoji（保持纯文本、可机翻、可审计）。
 */
export const DEFAULT_GUIDANCE =
  '我是你的旅游规划小助手，专门帮你做旅行相关的规划——行程安排、目的地推荐、' +
  '机票酒店、签证攻略、预算把控等。\n\n' +
  '你刚才聊的内容好像和旅行没太相关。想聊聊去哪儿玩、怎么安排行程，' +
  '或者需要一份详细的旅行攻略吗？告诉我你的出发地、时间和偏好，我来帮你规划！';

/**
 * 模型兜底用的分类指令（旅游规划范畴）。
 *
 * ★ 领域语义只在本文件出现：`src/agui` **不在**内核领域词守卫的扫描范围
 *   （`src/core/**` + `shared/**`），所以这里的旅游词汇不会破坏红线 8。
 *   本字符串只是 `createTextClassifier` 的一个参数，由 route 喂给通用分类器。
 */
export const TRAVEL_CLASSIFY_INSTRUCTION =
  '你是旅游规划助手的意图分类器。判断用户消息是否属于"旅游/旅行规划"范畴。' +
  '属于的范畴包括：行程/路线规划、目的地与景点推荐、机票/酒店/住宿、签证护照、' +
  '交通出行、游玩活动、旅游预算、攻略与度假安排等。' +
  '只回答一个字：属于回答"是"，不属于回答"否"。不要任何解释或标点。';

/** 模型输出以这些词开头视为"属于"（相关）；其余一律视为离题。 */
export const TRAVEL_AFFIRMATIVE = /^(是|yes|related|travel|旅游|相关)/i;

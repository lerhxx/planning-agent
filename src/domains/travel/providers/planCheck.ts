/**
 * 领域段 ③ · 子模块 ④：`planCheck.ts` —— **计划级校验**。
 *
 * 边界（设计 §5.2）：
 * - **做**：拿到整份 `Plan` 做跨步骤约束（溯源 / 结构 / 天数 / 过满 / 超预算 / 事实丢弃）；
 * - **不做**：取数（→ `poi.ts` / `vision.ts`）、编排（→ `compose.ts`）。
 *
 * ★ 为什么这一段是独立文件而不是塞回数据源：
 * 8 段里**只有 `createValidator` 能拿到整份 `Plan`**（`planning.validateStep` 只拿单个 `Step`），
 * 所以跨步骤约束天然会往这里聚。v2 的 `IMAGE_*` 规则同样落在这里（下一批，等契约 landed）。
 *
 * 依赖方向：`planCheck.ts` → `compose.ts` + `poi.ts`（+ `shared/**`）；**禁止反向**（设计 §5.3）。
 */
import { z } from 'zod';
import type { ValidationResult } from '@/shared/domain/types';
import type { Plan } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import {
  MAX_ITEMS_PER_DAY,
  composeItinerary,
} from './compose';
import {
  TRIP_CATEGORIES,
  clampTripDays,
  resolveTripBrief,
  zFactDerivedPoi,
  zTripCategory,
  type TripBrief,
  type TripCategory,
  type TripPoi,
} from './poi';

export const VALIDATOR_ID = 'travel.validator';

/** 图片理解步骤的 step.type（与 `planning.ts` 的常量同源语义，这里不 import 避免 planning↔providers 环）。 */
export const IMAGE_UNDERSTAND_STEP_TYPE = 'image_understand';
export const ITINERARY_COMPOSE_STEP_TYPE = 'itinerary_compose';

/** 已进入终态、不会再变的步骤状态（"澄清无果"的判定前提）。 */
const SETTLED_STEP_STATUSES: readonly string[] = ['done', 'failed', 'skipped', 'cancelled'];

/**
 * 图片理解步骤的产出（**单一真源**：K5 —— 领域只读 `result.data`，不读 `answers`）。
 *
 * 用宽松 schema：字段缺失要能被识别出来而不是让整条校验炸掉。
 */
export const zImageUnderstandData = z.object({
  identified: z
    .array(z.object({ assetId: z.string().default(''), identifiedName: z.string().optional() }))
    .default([]),
  unresolved: z.array(z.string()).default([]),
  skippedAssetIds: z.array(z.string()).default([]),
  mentions: z
    .object({
      unresolvedTokens: z.array(z.string()).default([]),
      ambiguousTokens: z.array(z.string()).default([]),
    })
    .optional(),
});
export type ImageUnderstandData = z.infer<typeof zImageUnderstandData>;

/** 编排步骤产出的覆盖度（由 `compose.ts` 计算，这里只读不重算）。 */
const zComposeCoverage = z.object({
  missingAssetIds: z.array(z.string()).default([]),
  skippedAssetIds: z.array(z.string()).default([]),
});

const zComposeData = z.object({ coverage: zComposeCoverage.optional() });

/* ------------------------------------------------------------------ *
 * 从 Plan 还原口径
 * ------------------------------------------------------------------ */

/** 从计划里各步骤的 `intent.input` 还原口径（盘输入来自 Planner，一律 `safeParse`）。 */
export const zLooseStepInput = z.object({
  goalSummary: z.string().optional(),
  city: z.string().optional(),
  category: zTripCategory.optional(),
  days: z.number().optional(),
  budgetCNY: z.number().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  limitPerCategory: z.number().int().positive().optional(),
});

export function readPlanBrief(
  plan: Plan,
): { brief: TripBrief; declaredDays: number | null } {
  let goalSummary = '';
  let city: string | undefined;
  let days: number | undefined;
  let budgetCNY: number | undefined;
  let limitPerCategory: number | undefined;

  for (const step of plan.steps) {
    const parsed = zLooseStepInput.safeParse(step.intent?.input ?? {});
    if (!parsed.success) continue;
    const data = parsed.data;
    if (goalSummary.length === 0 && typeof data.goalSummary === 'string') {
      goalSummary = data.goalSummary;
    }
    city = city ?? data.city;
    days = days ?? data.days;
    budgetCNY = budgetCNY ?? data.budgetCNY;
    limitPerCategory = limitPerCategory ?? data.limitPerCategory ?? data.limit;
  }

  return {
    brief: resolveTripBrief({ goalSummary, city, days, budgetCNY, limitPerCategory }),
    declaredDays: days === undefined ? null : clampTripDays(days),
  };
}

/* ------------------------------------------------------------------ *
 * 已完成事实的收集与归拢
 * ------------------------------------------------------------------ */

/**
 * 步骤结果里的事实记录用**宽松** schema 解析：缺 source 也要能被识别出来（而不是被丢掉）。
 *
 * `city` / `address` 一并带过来（上游通常有），但不强求 —— 重算成本只需要
 * `category` / `priceCNY`，缺了这两项才影响判定。
 */
const zLoosePoiRecord = z.object({
  name: z.string().optional(),
  category: zTripCategory.optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  priceCNY: z.number().nonnegative().optional(),
  source: z.string().optional(),
});

const zLoosePoiPayload = z.object({
  pois: z.array(zLoosePoiRecord).default([]),
});

export interface CompletedFacts {
  records: z.infer<typeof zLoosePoiRecord>[];
  /** 产出了事实但没有 SourceRef 的步骤 —— 反幻觉硬违规。 */
  missingRefStepIds: string[];
  hasAnyFactStep: boolean;
}

/**
 * 收集计划里**已完成**的事实步骤产出的记录。**纯函数**。
 *
 * ★ `result.ok !== true` 的步骤必须跳过（K12）：
 * `ok:false` 的澄清步骤若已写入 `result`（工具返回 `needsClarification` 时引擎会落盘 result），
 * 它的记录会被当成**事实**计入成本重算 —— 那是"把用户还没确认的东西当成已发生的事实"，
 * 与 P1（悄悄换城）/ dropped（悄悄丢事实）/ zod strip（悄悄丢字段）同属**静默**这一失败类型。
 */
export function collectCompletedFacts(plan: Plan): CompletedFacts {
  const records: z.infer<typeof zLoosePoiRecord>[] = [];
  const missingRefStepIds: string[] = [];
  let hasAnyFactStep = false;

  for (const step of plan.steps) {
    if (step.intent?.producesFacts !== true) continue;
    hasAnyFactStep = true;
    const result = step.result;
    if (!result) continue;
    // ★ 只认 ok:true 的结果：ok:false 的是"未完成 / 待澄清"，其 data 不是事实。
    if (result.ok !== true) continue;
    if ((result.sourceRefs ?? []).length === 0) missingRefStepIds.push(step.id);
    const parsed = zLoosePoiPayload.safeParse(result.data ?? {});
    if (parsed.success) records.push(...parsed.data.pois);
  }

  return { records, missingRefStepIds, hasAnyFactStep };
}

/**
 * 按类别归拢后的事实桶。**同时携带 `dropped`（被丢弃的条数）**。
 *
 * ★ `dropped` 是刻意外露的，不是内部细节：
 *
 * 1. **静默丢弃 = 悄悄把成本算低**。被丢掉的条目不进桶，它的 `priceCNY` 就不计入总价，
 *    而总价越低越容易通过预算校验 —— 于是"丢数据"会变成"放行超预算"的暗门。
 * 2. **这与 P1 是同一类失败模式**。P1 的教训是"悄悄换城市不给标注"，把反幻觉防线
 *    变成了造假装置；"悄悄丢掉一部分事实不给任何提示"是同一个错误的另一面。
 *    这个项目的整个反幻觉主张就是**不可静默**，所以丢弃必须可观测。
 */
export type FactBuckets = Record<TripCategory, TripPoi[]> & { dropped: number };

/** 把散落的事实按类别归拢（用于「按真实取回的数据」重算成本）。 */
export function groupFactsByCategory(
  records: readonly z.infer<typeof zLoosePoiRecord>[],
): FactBuckets {
  const buckets: Record<TripCategory, TripPoi[]> = { attraction: [], restaurant: [], hotel: [] };
  let dropped = 0;

  records.forEach((record, index) => {
    if (!record.category || !record.name || !record.source) {
      dropped += 1;
      return;
    }
    // ★ safeParse + 丢弃：用宽松 schema（`zFactDerivedPoi`）。
    // 绝不能抛异常 —— 这个函数跑在 `validateCurrent(candidate)` 里，抛出去就是整条 run 的
    // INTERNAL_ERROR；也绝不能硬填空串去喂严格的 `zTripPoi`（city/address 都是 min(1)）。
    // 但**丢弃必须计数**（`dropped`），由调用方转成一条 warning 说出去 —— 见 `validateTripPlan`。
    const candidate = zFactDerivedPoi.safeParse({
      id: `${record.category}-${index}`,
      name: record.name,
      city: record.city ?? '',
      category: record.category,
      rating: 0,
      priceLevel: 1,
      priceCNY: record.priceCNY ?? 0,
      address: record.address ?? '',
      tags: [],
      source: record.source,
    });
    if (!candidate.success) {
      dropped += 1;
      return;
    }
    buckets[record.category].push(candidate.data);
  });

  // 保持 `Record<TripCategory, TripPoi[]>` 的形状（调用方可以直接当 pois 用），
  // 只是额外挂一个 `dropped` —— 这样既有调用点不用改，丢弃量又不再是不可见的。
  return { ...buckets, dropped };
}

/* ------------------------------------------------------------------ *
 * 计划校验
 * ------------------------------------------------------------------ */

interface TravelViolation {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  suggestion?: string;
}

/**
 * ★ 行程计划校验。**纯函数**，供 `createValidator` 与单测复用。
 *
 * 违规只暴露 `severity`；`code` / `message` / `suggestion` 是给**人与日志**看的，
 * 内核按契约不会去读它们（红线 9/10）。
 *
 * @param ctx 可选。给了才知道"本轮有没有带图片"，用于判定「澄清路径不可用」。
 */
export function validateTripPlan(plan: Plan, ctx?: RunContext): ValidationResult {
  const violations: TravelViolation[] = [];
  const { brief, declaredDays } = readPlanBrief(plan);

  /* ① 反幻觉：事实必须可溯源 */
  const facts = collectCompletedFacts(plan);
  for (const stepId of facts.missingRefStepIds) {
    violations.push({
      severity: 'error',
      code: 'SOURCE_MISSING',
      message: `步骤 ${stepId} 产出了事实但没有带来源引用，结果不可信`,
      suggestion: '重新向 Provider 取数，不得由模型补全',
    });
  }
  const unsourced = facts.records.filter(
    (record) => typeof record.source !== 'string' || record.source.length === 0,
  );
  if (unsourced.length > 0) {
    violations.push({
      severity: 'error',
      code: 'SOURCE_MISSING',
      message: `有 ${unsourced.length} 条候选缺少来源，无法保证不是编造的`,
      suggestion: '丢弃无来源条目后重新编排',
    });
  }

  /* ② 结构：检索步骤必须被编排步骤消费 */
  const searchSteps = plan.steps.filter((step) => step.type === 'poi_search');
  const composeSteps = plan.steps.filter((step) => step.type === 'itinerary_compose');
  if (searchSteps.length > 0 && composeSteps.length === 0) {
    violations.push({
      severity: 'error',
      code: 'COMPOSE_STEP_MISSING',
      message: '计划里有检索步骤却没有编排步骤，检索结果不会被使用',
      suggestion: '补一个由检索步骤推导出来的编排步骤',
    });
  }
  if (composeSteps.length > 1) {
    violations.push({
      severity: 'warning',
      code: 'COMPOSE_STEP_DUPLICATED',
      message: '出现多个编排步骤，可能产生互相冲突的行程',
    });
  }
  for (const compose of composeSteps) {
    const dependsOnSearch = compose.dependsOn.some((id) =>
      searchSteps.some((step) => step.id === id),
    );
    if (!dependsOnSearch) {
      violations.push({
        severity: 'error',
        code: 'COMPOSE_STEP_ORPHAN',
        message: `编排步骤 ${compose.id} 没有依赖任何检索步骤`,
        suggestion: '让编排步骤依赖至少一个检索步骤',
      });
    }
  }

  /* ③ 行程天数与目标不一致 → error */
  if (declaredDays !== null && brief.daysFromGoal !== null && declaredDays !== brief.daysFromGoal) {
    violations.push({
      severity: 'error',
      code: 'DAYS_MISMATCH',
      message: `计划按 ${declaredDays} 天编排，但目标写的是 ${brief.daysFromGoal} 天`,
      suggestion: '把编排天数改成与目标一致，或让用户确认改期',
    });
  }

  /* ④ 过满（warning）与超预算（error）：优先用真实事实，没有事实时用 fixture 估算同一口径 */
  // ★ 把**全部**已产出的事实交给 groupFactsByCategory（不再先按 category/source 预筛一遍）：
  // 预筛会让"缺字段的记录"连被计数的机会都没有，`dropped` 就失去意义了。
  const grouped = groupFactsByCategory(facts.records);
  const usableFacts = TRIP_CATEGORIES.reduce(
    (total, category) => total + grouped[category].length,
    0,
  );
  const itinerary = composeItinerary({
    city: brief.city,
    days: brief.days,
    limitPerCategory: brief.limitPerCategory,
    // 一条可用事实都没有时回落到 fixture 估算 —— 绝不能用"空桶"算出 ¥0 从而放行超预算。
    ...(usableFacts > 0 ? { pois: grouped } : {}),
  });

  const packedDays = itinerary.days.filter((day) => day.items.length > MAX_ITEMS_PER_DAY);
  if (packedDays.length > 0) {
    violations.push({
      severity: 'warning',
      code: 'OVERPACKED_DAY',
      message: `第 ${packedDays.map((day) => day.day).join('、')} 天安排超过 ${MAX_ITEMS_PER_DAY} 项，行程偏满`,
      suggestion: '把部分条目挪到相邻日期，或增加一天',
    });
  }

  if (brief.budgetCNY !== null && itinerary.totalCostCNY > brief.budgetCNY) {
    violations.push({
      severity: 'error',
      code: 'BUDGET_OVERRUN',
      message: `按当前安排，${brief.days} 天预计花费 ¥${itinerary.totalCostCNY}，超过目标里的 ¥${brief.budgetCNY} 预算上限`,
      suggestion: '降低住宿档次、减少付费景点，或让用户上调预算',
    });
  }

  /* ⑤ 事实被丢弃 → warning（不阻断，但必须说出口） */
  // 被丢弃的条目不进成本重算 → 总价偏低 → 校验更容易通过。
  // 这与"悄悄换城市"是同一类失败模式：**静默就是造假**。所以哪怕不阻断也要报出来。
  if (grouped.dropped > 0) {
    violations.push({
      severity: 'warning',
      code: 'FACTS_DROPPED',
      message: `有 ${grouped.dropped} 条已产出的事实因字段缺失（名称 / 类别 / 来源）未计入成本重算，当前总价 ¥${itinerary.totalCostCNY} 可能偏低`,
      suggestion: '检查上游 Provider 的返回完整性；缺来源的条目不得参与编排',
    });
  }

  /* ⑥ 图片流程：★ 只在 image_understand 进入**终态**后才校验（§3.2 口径 2） */
  // "未覆盖即 error"若不限定终态，首轮校验时该步骤还没执行 → 每个 run 开局就被拦，一步都跑不了。
  const imageSteps = plan.steps.filter((step) => step.type === IMAGE_UNDERSTAND_STEP_TYPE);
  const imageStep = imageSteps[0];
  const imageKindCount = (ctx?.attachments ?? []).filter((item) => item.kind === 'image').length;

  if (imageStep) {
    const settled = SETTLED_STEP_STATUSES.includes(imageStep.status);
    if (settled) {
      const data = zImageUnderstandData.safeParse(imageStep.result?.data ?? {});
      const unresolved = data.success ? data.data.unresolved : [];
      const skipped = new Set(data.success ? data.data.skippedAssetIds : []);
      // ★ 已显式跳过的不再算未决：用户做过决策了，不该再把他拦下来。
      const stillUnresolved = unresolved.filter((id) => !skipped.has(id));

      // ① 澄清无果（步骤已 done 而 unresolved 仍非空）或 ② 澄清路径不可用（该步骤 failed）
      if (stillUnresolved.length > 0 || imageStep.status === 'failed') {
        violations.push({
          severity: 'error',
          code: 'IMAGE_UNRESOLVED',
          message:
            imageStep.status === 'failed'
              ? `图片理解步骤 ${imageStep.id} 已失败，无法确认图片内容`
              : `还有 ${stillUnresolved.length} 张图片没认出来，也没有被跳过`,
          suggestion: '补充图片信息，或显式选择跳过这几张',
        });
      }

      // `@` 提及 0 命中且步骤已终态 → 走 error（PRD §3.4 的备选路径：澄清无果后兜底）
      const mentionTokens = data.success ? (data.data.mentions?.unresolvedTokens ?? []) : [];
      if (imageStep.status === 'done' && mentionTokens.length > 0) {
        violations.push({
          severity: 'error',
          code: 'IMAGE_MENTION_UNRESOLVED',
          message: `有 ${mentionTokens.length} 处 @提及没有匹配到任何图片，说明没有被关联到图上`,
          suggestion: '改成一个已上传图片的名字，或删掉这段提及',
        });
      }
    }
    // ★ 步骤仍在 pending / running / awaiting_user → 一律不报（用户还在决策，不能替他判定）。
  } else if (imageKindCount > 0) {
    // ② 澄清路径不可用：本轮带了图片，计划里却没有图片理解步骤。
    violations.push({
      severity: 'error',
      code: 'IMAGE_UNRESOLVED',
      message: `本轮带了 ${imageKindCount} 张图片，但计划里没有图片理解步骤，图片内容不会被使用`,
      suggestion: '补一个图片理解步骤，或去掉图片后重新规划',
    });
  }

  /* ⑦ 覆盖度：漏排 → error，但**数值**走 props（§3.2 口径 4：覆盖率不靠违规通道可见） */
  for (const step of plan.steps.filter((item) => item.type === ITINERARY_COMPOSE_STEP_TYPE)) {
    if (step.status !== 'done') continue;
    const parsed = zComposeData.safeParse(step.result?.data ?? {});
    const coverage = parsed.success ? parsed.data.coverage : undefined;
    const missing = (coverage?.missingAssetIds ?? []).filter(
      (id) => !(coverage?.skippedAssetIds ?? []).includes(id),
    );
    if (missing.length > 0) {
      violations.push({
        severity: 'error',
        code: 'IMAGE_COVERAGE_MISSING',
        message: `行程漏排了 ${missing.length} 张已识别的图片，未满足"行程须涵盖所有图片"`,
        suggestion: '把这批图片对应的条目排进行程，或让用户显式跳过',
      });
    }
  }

  return {
    ok: !violations.some((violation) => violation.severity === 'error'),
    violations,
  };
}

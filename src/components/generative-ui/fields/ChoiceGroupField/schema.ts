import { z } from 'zod';

/**
 * ChoiceGroupField 的自包含 props 契约（zod → z.infer，不依赖任何框架/领域类型）。
 *
 * 与 `shared/plan/types.ts` 的 `zFieldKind` 语义对齐：
 * - 单选组 ↔ `select`（含 `image-ref` 的「从候选里挑一个」语义）；
 * - 多选组 ↔ `multi`。
 * 选项结构沿用 `zClarifyOption` 的 id / label / description 三元组词汇，
 * 另加 `emoji`（参考图 IMG_2232 每行左侧的图标）与 `hint`（灰色括号补充说明）。
 */

/** 一个选项：emoji 图标 + 标签 + 灰色补充说明。 */
export const zChoiceOption = z.object({
  id: z.string().min(1),
  emoji: z.string().min(1).optional(),
  label: z.string().min(1),
  /** 渲染为标签后的灰色「（hint）」；留空则不显示。 */
  hint: z.string().optional(),
});

/** 一道题：题干 + 单/多选 + 选项列表。 */
export const zChoiceGroup = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  multi: z.boolean().default(false),
  options: z.array(zChoiceOption).min(1),
});

/** 数据 props（zod 校验面）。确认结果为 `Record<groupId, optionId[]>`。 */
export const zChoiceGroupFieldProps = z.object({
  groups: z.array(zChoiceGroup).default([]),
  /** 初始选中态：`Record<groupId, optionId[]>`（单选组至多 1 个）。 */
  initialSelections: z.record(z.string(), z.array(z.string())).default({}),
  /** 题干前是否自动加「1. 2. 3.」序号（参考图带序号）。 */
  showIndex: z.boolean().default(true),
  /** 可多选题题干后的后缀标记。 */
  multiSuffix: z.string().default('（可多选）'),
  confirmLabel: z.string().min(1).default('确认'),
  /** 传入则渲染次要跳过按钮（同 CalendarField 的「暂不设置日期」位）。 */
  skipLabel: z.string().min(1).optional(),
  /** 为 true 时：所有题都至少选一项才能确认（未传 required 的题也会被拦）。 */
  requireAll: z.boolean().default(false),
});
export type ChoiceGroupFieldDataProps = z.infer<typeof zChoiceGroupFieldProps>;

/** 组件完整 props = 数据 props + 回灌回调（组件内不发请求）。 */
export type ChoiceGroupFieldProps = ChoiceGroupFieldDataProps & {
  onConfirm?: (selections: Record<string, string[]>) => void;
  onSkip?: () => void;
};

import { z } from 'zod';

/**
 * CalendarField 的自包含 props 契约（zod → z.infer，不依赖任何框架/领域类型）。
 *
 * 与 `shared/plan/types.ts` 的 `zFieldKind` 语义对齐：本组件覆盖
 * `date` 字段 —— 精确日期（single）、日期区间（range）与「灵活的天数」三种取值形态，
 * 输出统一收敛为 `CalendarValue`（string key `YYYY-MM-DD`，可直接回灌 `answers`）。
 */

/** 本地日期 key：`YYYY-MM-DD`（不带时区后缀，避免 Date 序列化偏移一天）。 */
export const zDateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期须为 YYYY-MM-DD 格式');

/** 顶部分段切换的页签。 */
export const zCalendarTab = z.enum(['date', 'flexible']);
export type CalendarTab = z.infer<typeof zCalendarTab>;

/**
 * 确认时的取值（判别联合）：
 * - `single`：精确某天；
 * - `range`：闭区间 [start, end]；
 * - `flexible`：只要天数，不要具体日期。
 */
export const zCalendarValue = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('single'), date: zDateKey }),
  z.object({ mode: z.literal('range'), start: zDateKey, end: zDateKey }),
  z.object({ mode: z.literal('flexible'), days: z.number().int().min(1).max(365) }),
]);
export type CalendarValue = z.infer<typeof zCalendarValue>;

/** 数据 props（zod 校验面）。回调挂在组件 props 上，不进 schema。 */
export const zCalendarFieldProps = z.object({
  /** 展示哪些页签，默认两个都展示（与参考图 IMG_2231 一致）。 */
  tabs: z.array(zCalendarTab).min(1).default(['date', 'flexible']),
  defaultTab: zCalendarTab.default('date'),
  /** 日历取值形态：点一天（single）或点起止两天（range）。 */
  calendarMode: z.enum(['single', 'range']).default('single'),
  /** 初始展示月份，`YYYY-MM`；缺省用今天所在月份。 */
  initialMonth: z.string().regex(/^\d{4}-\d{2}$/, '月份须为 YYYY-MM 格式').optional(),
  initialDate: zDateKey.optional(),
  initialRange: z.object({ start: zDateKey, end: zDateKey }).optional(),
  initialDays: z.number().int().min(1).max(365).default(3),
  confirmLabel: z.string().min(1).default('确认'),
  skipLabel: z.string().min(1).default('暂不设置日期'),
  showSkip: z.boolean().default(true),
  /**
   * 是否渲染自带的「跳过 / 确认」按钮。**默认 true**（独立使用行为不变）。
   *
   * 被别的容器（`ClarifyOptions`）当**纯选值控件**内嵌时要传 `false` ——
   * 否则会出现两个确认按钮，且两套提交门控打架。
   */
  showActions: z.boolean().default(true),
});
export type CalendarFieldDataProps = z.infer<typeof zCalendarFieldProps>;

/** 组件完整 props = 数据 props + 回灌回调（组件内不发请求）。 */
export type CalendarFieldProps = CalendarFieldDataProps & {
  onConfirm?: (value: CalendarValue) => void;
  onSkip?: () => void;
  /**
   * 每次选值变化**立即**回传当前取值（`CalendarValue | null` 中的非 null 值）。
   *
   * ★ 只是**旁路通知**，不是把组件改成受控组件：内部仍保留自己的本地 state，
   * `showActions` 为 true 时照样能独立工作。两种用法互不干扰。
   * 取值为 `range` / `flexible` 时由**调用方**自行决定是否接受 ——
   * 本组件不替调用方做取舍（那会变成静默丢）。
   */
  onChange?: (value: CalendarValue) => void;
};

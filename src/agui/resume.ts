/**
 * 把「本次 run 没交代的 pending interrupt」补成 `cancelled`。
 *
 * ## 为什么需要这个（用户实测出来的阻断性 bug）
 *
 * `@ag-ui/client` 的 `AbstractAgent.onInitialize` 在每次 run 开始前做校验：
 * 线程上只要还有 pending interrupt，且它没出现在本次 `resume` 里，就**直接抛错**，
 * 请求根本发不出去：
 *
 *     Thread has 1 pending interrupt(s) not addressed by resume: clarify:…
 *
 * 用户流程：跑出澄清卡片 → **不点选项，直接在输入框发新问题** → 这次 run 不带 resume
 * → 被硬拦 → 界面上什么都没发生。属于"用户正常操作把系统打死"。
 *
 * ## 为什么补 `cancelled` 是正解
 *
 * 1. 用户直接发新消息 = 选择不回答上一个问题、直接问新的 —— 新消息天然覆盖旧问题；
 * 2. SDK 自己在**另一条**错误分支的文案就是
 *    「Interrupt … expired … can no longer be answered. **Cancel** it to continue the thread.」，
 *    说明 `cancelled` 是它认可的"放弃并继续"出口；
 * 3. 服务端 `src/agui/translate.ts` 的 `mergeResumeAnswers` 只消费 `status === 'resolved'`
 *    的条目，`cancelled` 不产生任何 answers —— 正好就是"这次不带答案，重新跑"。
 */

/** 只需要 `id` —— AG-UI 的 `Interrupt` 满足这个形状，测试里也能用更轻的假对象。 */
export interface PendingInterruptLike {
  id: string;
}

/** 只需要 `interruptId` —— AG-UI 的 `ResumeEntry` 满足。 */
export interface ResumeEntryLike {
  interruptId: string;
}

/** 放弃某个中断、但不带答案的 resume 条目。`payload` 在协议里是可选的。 */
export type CancelledResumeEntry = {
  interruptId: string;
  status: 'cancelled';
};

/**
 * 计算本次 run 真正要发的 `resume`。
 *
 * 规则：
 * - `pending` 为空 → **原样返回** `resume`（连引用都不换），不凭空产出 `resume: []`；
 * - 已经交代过的中断**原样保留** —— 绝不能再给它补一条 `cancelled`：
 *   SDK 对同一 interruptId 出现两条时后写的会覆盖前面的，那会把用户刚点的选项冲掉；
 * - 只有**没被交代**的那些才补 `cancelled`，追加在原有条目之后。
 *
 * @returns 有补条目时为新数组；无需任何变更时为传入的 `resume`（可能是 `undefined`）。
 */
export function buildResumeWithCancelled<TResume extends ResumeEntryLike>(
  pending: readonly PendingInterruptLike[],
  resume: readonly TResume[] | undefined,
): readonly (TResume | CancelledResumeEntry)[] | undefined {
  if (pending.length === 0) return resume;

  const addressed = new Set((resume ?? []).map((entry) => entry.interruptId));
  const missing = pending.filter((interrupt) => !addressed.has(interrupt.id));
  if (missing.length === 0) return resume;

  return [
    ...(resume ?? []),
    ...missing.map(
      (interrupt): CancelledResumeEntry => ({
        interruptId: interrupt.id,
        status: 'cancelled',
      }),
    ),
  ];
}

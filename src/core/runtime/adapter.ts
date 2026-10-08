/**
 * ★ RuntimeAdapter —— **内核唯一可见的执行接口**（红线 13：内核只依赖接口，不依赖实现）。
 *
 * 模型能力（规划 / 重规划）与工具执行都收在这里。M1 只有 `MockRuntime`（连模型也 mock，零网络）。
 * 将来的 `MastraRuntime` 必须实现同一个接口，内核一行不改。
 *
 * 本文件位于 `src/core/**`：禁止出现任何领域词。
 */
import { z } from 'zod';
import {
  zGoal,
  zStep,
  zStepDraft,
  type Goal,
  type Step,
  type StepDraft,
} from '@/shared/plan/types';
import {
  zPlanTemplate,
  zStepTypeDescriptor,
  type ToolResult,
} from '@/shared/domain/types';
import { zRunContext, type RunContext } from '@/shared/run/types';
import { zReplanTrigger } from '@/src/core/replan/policy';

/* ------------------------------------------------------------------ *
 * 工具清单（**给模型看的**，不是执行契约）
 * ------------------------------------------------------------------ */

/**
 * ★ 规划请求携带的"可用工具"清单条目 —— **这是给模型看的清单，不是执行契约**。
 *
 * ## 为什么不复用 `zToolSpecMeta`
 *
 * `zToolSpecMeta`（`shared/domain/types.ts`）是**执行期**契约：它带 `inputSchema`
 * 之外的 `idempotent` / `timeoutMs` / `retryable` 这些**内核与 runtime 之间**才需要的字段，
 * 而 `ToolSpec` 还要挂 `execute` 实现。这些对模型不仅无用，还会误导 ——
 * 模型会去猜 `timeoutMs` 能不能当"耗时"填进 `estimate.durationMs`。
 *
 * 而模型**真正需要**的三样是：注册名（必须逐字照抄）、用途说明、重试上限。
 * 缺的第三样（`label`）领域工具侧本来就没有 —— 它的等价物是 `stepType`，
 * 而 `stepType` 的 `maxAttempts` 已经挂在 `zStepTypeDescriptor` 上了。
 *
 * ## 边界
 *
 * - 本清单**只读**：模型看得见，但内核不拿它当授权依据（授权由
 *   `planner.ts` 的 `buildSteps` 拿 `intent.toolName` 去注册表核对）；
 * - 清单为**空**是合法状态（领域没注册任何工具），
 *   此时 prompt 必须明确要求模型把 `intent` 设成 `null`。
 */
/* ------------------------------------------------------------------ *
 * 工具入参的 JSON Schema（**从zod 现场推导**，不是手抄的枚举表）
 * ------------------------------------------------------------------ */

/**
 * ★ 只保留"值为数字"的约束关键字（`maximum` / `minLength` / …）。
 *
 * 为什么单独列出来而不是把整个 JSON Schema 塞进清单：模型在工具清单里
 * 真正会用到的数值约束就这几个；`$schema` / `additionalProperties` /
 * `propertyNames` 之类是给校验器看的，渲染进 prompt 只会稀释注意力
 * （prompt 里每多一行无关信息，模型对那几行真正约束的注意力就少一分）。
 */
const NUMERIC_CONSTRAINT_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'multipleOf',
] as const;

/** 单个入参字段的约束（给模型看的最小充分集）。 */
export const zToolInputField = z.object({
  /** JSON Schema 的 `type`（`string` / `integer` / `number` / `boolean` / `array` / `object`）。 */
  type: z.string().default(''),
  /**
   * 枚举的合法取值。**这是本段存在的头号理由**：模型看不见它就会照着
   * description 里的自然语言标签填，而工具只认机器取值 —— 一次静默的错位。
   */
  enum: z.array(z.string()).default([]),
  /** 数值/长度约束（键名沿用 JSON Schema 原词，便于模型对照理解）。 */
  bounds: z.record(z.string(), z.number()).default({}),
});

/** 一个工具的入参约束：`fields` 是字段名 → 约束，`required` 是必须由调用方给出的字段。 */
export const zToolInputSchema = z.object({
  fields: z.record(z.string(), zToolInputField).default({}),
  required: z.array(z.string()).default([]),
});
export type ToolInputSchema = z.infer<typeof zToolInputSchema>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * ★ 从领域真实的 `inputSchema` 推导"给模型看的入参约束"。
 *
 * ## 为什么必须现场推导、不能手抄
 *
 * 手抄的枚举表**必然脱节**：领域改一次 schema，prompt 里的清单还写着旧值，
 * 于是模型照旧填旧值、工具照旧拒收，**且没有任何报错指向真正的原因**。
 * 现场推导让"清单"与"真实契约"在结构上不可能分叉。
 *
 * ## 用 zod 自带的 `z.toJSONSchema`，而不是 `zod-to-json-schema`
 *
 * 本仓zod 是 4.x，`toJSONSchema` 是**zod 自己的 API**（实测 `zod@4.1.8` 存在）。
 * 仓库里那个 `zod-to-json-schema` 包是别的依赖带进来的（面向 zod 3 写的），
 * 用它等于引入第二套版本假设 —— 那是"脱节"的另一种形式。
 *
 * ## 三个参数各自的原因（都是实测出来的，不是猜的）
 *
 * - `io: 'input'`：**按"调用方要填什么"而不是"解析后是什么"导出**。
 *   带 `.default()` 的字段在 input 视角下**不是 required**（实测确认）——
 *   这正是我们要告诉模型的："这些字段你可以不填"。用默认的 output 视角，
 *   所有带默认值的字段都会变成"必填"，模型于是被迫去编造本来不必填的东西。
 * - `unrepresentable: 'any'`：遇到 zod 认为无法表示成 JSON Schema 的类型
 *   （如 `z.date()`）时**降级成 `{}` 而不是抛错**。抛错会让整个
 *   `plan`/`replan` 挂掉 —— 为了渲染一段prompt 文案而搞崩规划，是本末倒置。
 *   这类字段在清单里就没有取值约束，如实呈现"这里没约束"，而不是编一个。
 * - 不传 `target`：用默认 draft 2020-12。清单是**给人读的**，不需要某个特定 draft。
 *
 * ## 失败时为什么只`console.warn` 而不抛
 *
 * 这一段是 prompt 文案，不是执行契约。推导不出来时清单里就没有入参行，
 * 其余信息（工具名 / 说明 / 重试上限）仍然可用 —— 让 prompt 少一段，
 * 比让整轮规划失败好。但**必须出声**：静默少一段与"静默降级成默认值"
 * 是同一类毛病，下一个人会以为清单本来就长这样。
 */
export function toolInputJsonSchema(schema: z.ZodType): ToolInputSchema {
  let json: unknown;
  try {
    json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    console.warn(
      '[toolInputJsonSchema] 入参 schema 无法导出成 JSON Schema，工具清单将不渲染该工具的入参行',
    );
    return { fields: {}, required: [] };
  }

  const root = asRecord(json);
  const properties = asRecord(root?.['properties']);
  if (!properties) return { fields: {}, required: [] };

  const required = Array.isArray(root?.['required'])
    ? root['required'].filter((name): name is string => typeof name === 'string')
    : [];

  const fields: Record<string, z.infer<typeof zToolInputField>> = {};
  for (const [name, rawField] of Object.entries(properties)) {
    const field = asRecord(rawField);
    // 非对象的字段定义（理论上不该出现）直接跳过：如实少一条，好过渲染一个错的。
    if (!field) continue;

    const bounds: Record<string, number> = {};
    for (const key of NUMERIC_CONSTRAINT_KEYS) {
      const value = field[key];
      if (typeof value === 'number') bounds[key] = value;
    }

    fields[name] = {
      type: typeof field['type'] === 'string' ? field['type'] : '',
      enum: Array.isArray(field['enum'])
        ? field['enum'].filter((item): item is string => typeof item === 'string')
        : [],
      bounds,
    };
  }

  return { fields, required };
}

export const zToolBrief = z.object({
  /** 领域注册表里的注册名。`intent.toolName` 必须与它**逐字**相等。 */
  name: z.string().min(1),
  /** 一句话用途（取自 `ToolSpec.description`，给模型读的）。 */
  description: z.string().default(''),
  /**
   * 失败时最多尝试几次。★ 工具自己**不**声明这个上限，它随 `step.type` 走
   * （与 `buildSteps` 的 `maxAttemptsFor` 同一来源），所以由内核在装配清单时填。
   */
  maxAttempts: z.number().int().positive().default(2),
  /**
   * ★ 入参的 **JSON Schema**（由 `ToolSpec.inputSchema` 现场推导，见 `toolInputJsonSchema`）。
   *
   * ## 为什么必须有它
   *
   * 清单此前只渲染 `name` / `description` / `maxAttempts`，模型看不到 `intent.input` 的形状，
   * 于是只能照着 description 猜**字段的取值**。真实故障：工具说明写的是人类可读的类别标签，
   * 模型就把那个标签填进了枚举字段 —— 而枚举只认机器取值，工具执行期直接判失败，
   * 步骤全挂、耗尽重排次数，用户看到的报错与真实病因完全无关。
   *
   * 也就是说「工具名」那一类是**清单缺字段**，「工具入参取值」是**同一类缺字段**，
   * 只是发生在更深一层：不补上，模型只能猜。
   *
   * ## 为什么是 JSON Schema 而不是 zod
   *
   * 清单要跨进程/跨语言给模型看，也进prompt 文本；zod schema 只能活在进程里。
   * 更重要的是**单一真源**：由 `tool.inputSchema` 现场推导（`z.toJSONSchema`），
   * 领域改 schema 时 prompt 自动跟着变，**永不脱节** —— 手抄一份枚举是抄不过来的。
   *
   * 取值范围见 `toolInputJsonSchema` 的注释（那里说明了为什么剥掉若干关键字）。
   */
  inputSchema: zToolInputSchema,
});
export type ToolBrief = z.infer<typeof zToolBrief>;

/* ------------------------------------------------------------------ *
 * 规划请求 / 返回
 * ------------------------------------------------------------------ */

export const zPlanRequest = z.object({
  goal: zGoal,
  /** 领域声明的 step.type 白名单（内核透传，不解析其语义）。 */
  stepTypes: z.array(zStepTypeDescriptor).default([]),
  /**
   * ★ 领域注册过的全部工具（给模型看的清单）。
   * 曾长期**缺失**：prompt 的硬性约束写着"只能使用下方『可用工具』里列出的 toolName"，
   * 而请求里根本没有这个字段、prompt 里也没有这一节 —— 模型只能猜工具名，
   * 猜错就撞上 `工具未在当前领域注册`，步骤全失败后耗尽重排次数。
   *
   * ★ **optional 而不是必填**（重排请求一侧同理，见 `zReplanRequest.tools`）：
   * 权威来源是 `RunContext.domainId` 对应的注册表，`MastraRuntime` 会在调用模型前
   * 用 `getToolBriefs(ctx.domainId)` **覆盖**这个字段。让每个调用方都手填一份
   * 必然被覆盖的清单，只会让"该填什么"变成一件需要猜的事（填错即静默失效），
   * 也会逼着所有调用点（包括编排层）各自import 装配逻辑。
   * 真正的硬约束在**校验侧**：`planner.ts` 的 `buildSteps` 直接读注册表。
   */
  tools: z.array(zToolBrief).optional(),
  templates: z.array(zPlanTemplate).default([]),
  signals: z.array(z.string()).default([]),
  revision: z.number().int().nonnegative().default(1),
});
export type PlanRequest = z.infer<typeof zPlanRequest>;

export const zPlanDraft = z.object({
  summary: z.string().default(''),
  steps: z.array(zStepDraft).default([]),
});
export type PlanDraft = z.infer<typeof zPlanDraft>;

/* ------------------------------------------------------------------ *
 * 重规划请求
 * ------------------------------------------------------------------ */

export const zReplanRequest = z.object({
  goal: zGoal,
  revision: z.number().int().nonnegative(),
  trigger: zReplanTrigger,
  /** 失败的步骤 id（种子）。 */
  failedStepIds: z.array(z.string()).default([]),
  /** 反向收集到的受影响子树（已完成步骤已被剔除）。 */
  impactedStepIds: z.array(z.string()).default([]),
  /** 被保留的步骤快照（含已完成步骤），供 runtime 重写依赖。 */
  retainedSteps: z.array(zStep).default([]),
  /** 将被替换的步骤快照。 */
  impactedSteps: z.array(zStep).default([]),
  stepTypes: z.array(zStepTypeDescriptor).default([]),
  /**
   * ★ 与 `zPlanRequest.tools` 同一个字段、同一份清单、同样的 optional 理由。
   * 重排路径**同样**要校验新步骤的 `toolName`（`planner.ts` 的 `applyReplanDraft`），
   * 所以 prompt 也必须在这里拿到真实清单 —— 否则重排就是"凭空重发一个同样的错名字"。
   * 注意重排请求是由编排层 `src/core/run/engine.ts` 组装的，它拿得到 `domainId`，
   * 却不必（也不该）知道 prompt 需要什么素材。
   */
  tools: z.array(zToolBrief).optional(),
  templates: z.array(zPlanTemplate).default([]),
});
export type ReplanRequest = z.infer<typeof zReplanRequest>;

/* ------------------------------------------------------------------ *
 * 工具调用
 * ------------------------------------------------------------------ */

export const zToolCall = z.object({
  stepId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  /** `${runId}:${stepId}:${attempt}` */
  idempotencyKey: z.string().default(''),
  attempt: z.number().int().nonnegative().default(0),
  timeoutMs: z.number().int().positive().default(10_000),
  /** 来自 ToolSpec.producesFacts：为 true 时返回必须带 SourceRef。 */
  producesFacts: z.boolean().default(false),
});
export type ToolCall = z.infer<typeof zToolCall>;

export type ToolOutcome<T = unknown> = ToolResult<T>;

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

export interface RuntimeAdapter {
  /** 人类可读的实现标识（'mock' / 'mastra'）。 */
  readonly id: string;

  /** Goal → 计划草稿（模型调用，Mock 下为脚本化 fixture）。 */
  plan(request: PlanRequest, ctx: RunContext): Promise<PlanDraft>;

  /** 受影响子树 → 新草稿。**已完成 step 的 id 由内核保留，runtime 不得复用已完成 id。** */
  replan(request: ReplanRequest, ctx: RunContext): Promise<PlanDraft>;

  /** 执行单个工具调用。 */
  runTool(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
}

export type { RunContext, Goal, Step, StepDraft };
export { zRunContext };

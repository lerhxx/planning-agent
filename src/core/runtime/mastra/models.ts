/**
 * 模型与密钥的**唯一声明处**（CLAUDE.md 红线 6：禁止硬编码模型名）。
 *
 * 本文件位于 `src/core/**`：禁止出现任何领域词。
 * 这里出现的"模型"是执行资源，不是业务语义，因此不违反红线 8。
 *
 * ★ 为什么所有取值都从环境变量读、且**不给默认值**：
 *   缺配置时**抛错**而不是悄悄退化成某个默认模型。默认值是最危险的形态 ——
 *   用户以为在跑 A 模型，实际跑的是 B 模型，产出质量差异无人察觉。
 *   这是本仓红线精神（禁止静默失败）在模型配置上的直接落地。
 *
 * ★ 密钥绝不能用 `NEXT_PUBLIC_` 前缀：那会被打进客户端 bundle。
 *   本文件只在服务端被引用（经 `app/api/**` → `factory.ts` → 本文件）。
 */
import type { OpenAICompatibleConfig } from '@mastra/core/llm';

/** 缺少模型配置。**启动期抛出**，不等到用户点运行才炸。 */
export class MissingModelConfigError extends Error {
  /** 缺失的环境变量名，便于运维直接定位。 */
  readonly variable: string;

  constructor(variable: string) {
    super(
      `MissingModelConfigError: 缺少环境变量 ${variable}。` +
        '真模型运行必须显式配置端点与密钥；本仓不提供默认模型（见 models.ts 顶部注释）。',
    );
    this.name = 'MissingModelConfigError';
    this.variable = variable;
  }
}

/** 读一个必填环境变量，缺失即抛。 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new MissingModelConfigError(name);
  }
  return value.trim();
}

/**
 * 读取一组"provider / model / 端点 / 密钥"四元组，拼成 OpenAI 兼容配置。
 *
 * ★ `id` 必须是 `` `${string}/${string}` `` —— Mastra 用**模板字面量类型**强制要求
 *   斜杠（`node_modules/@mastra/core/dist/llm/model/shared.types.d.ts:24-29`）。
 *   写 `'qwen-max'` 这类不含斜杠的字面量会**编译报错**，所以这里用模板串拼。
 *
 * 国产模型（通义千问 / 豆包 / DeepSeek）都提供 OpenAI 兼容端点，
 * 因此统一走这一种配置形态，不需要为每家写适配器。
 */
function readModelConfig(prefix: string): OpenAICompatibleConfig {
  return {
    id: `${requireEnv(`${prefix}_PROVIDER`)}/${requireEnv(`${prefix}_MODEL`)}`,
    url: requireEnv(`${prefix}_BASE_URL`),
    apiKey: requireEnv(`${prefix}_API_KEY`),
  };
}

/** 文本模型：规划 / 重规划用。 */
export function textModel(): OpenAICompatibleConfig {
  return readModelConfig('MASTRA_TEXT');
}

/**
 * 视觉模型：识别输入的图片用。
 *
 * 内核不感知"视觉"这个能力维度（红线 8），它只是执行资源的一种；
 * 是否需要由领域包的能力声明决定。
 */
export function visionModel(): OpenAICompatibleConfig {
  return readModelConfig('MASTRA_VISION');
}

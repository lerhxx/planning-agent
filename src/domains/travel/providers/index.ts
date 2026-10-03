/**
 * 领域段 ③ · 桶：`providers/index.ts` —— 只做**装配**，不含任何业务规则（设计 §5.2）。
 *
 * 原 `providers.ts`（827 行）按职责拆成 5 个子模块（设计 §5.2 / §5.3）：
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `poi.ts` | POI fixture 数据源 + 城市/目标口径解析 |
 * | `vision.ts` | 图片理解数据源（本轮占位） |
 * | `compose.ts` | 编排口径 |
 * | `planCheck.ts` | 计划级校验 |
 * | `mentions.ts` | `@` 三态解析 |
 *
 * ★ 迁移方式：`providers.ts` → `providers/index.ts`（目录），因此
 * `from './providers'` 的 import 路径**一个字都不用改**（设计 §5.4）。
 * 本文件用 `export *` 把全部公共导出原样透出，保证既有调用点与单测零改动。
 *
 * ⚠️ 依赖方向只能从上往下（index → 子模块 → shared），**禁止反向与循环**。
 */
import type {
  DomainProviders,
  ProviderAdapter,
  ValidatingProvider,
  ValidationResult,
} from '@/shared/domain/types';
import type { Plan } from '@/shared/plan/types';
import type { RunContext } from '@/shared/run/types';
import { POI_PROVIDER_ID, SOURCE_NAMESPACE, createPoiProvider, type TripPoi } from './poi';
import { VALIDATOR_ID, validateTripPlan } from './planCheck';

// —— 子模块整体透出（既有 `from './providers'` 的调用点与单测不受拆分影响）——
export * from './poi';
export * from './compose';
export * from './planCheck';
export * from './mentions';
export * from './vision';

/**
 * travel 的 DomainProviders 装配。
 *
 * ★ 本轮 `create()` 只注册 `travel.poi` —— 与拆分前**逐字节同行为**（纯重构）。
 * `travel.vision` 的注册留到第二批（`tools.ts` / `planning.ts` 的 `image_understand` 一并落地）。
 */
export function createTripProviders(): DomainProviders {
  return {
    namespace: SOURCE_NAMESPACE,

    create(_ctx: RunContext): Record<string, ProviderAdapter> {
      const poi: ProviderAdapter<Record<string, unknown>, TripPoi> = createPoiProvider();
      return { [POI_PROVIDER_ID]: poi };
    },

    /**
     * 校验型 Provider：只为内核提供 `ok` 与 `violations[].severity` 两个信号。
     * `code` / `message` / `suggestion` 写得再领域化也安全 —— 内核按契约不会去读。
     */
    createValidator(_ctx: RunContext): ValidatingProvider {
      return {
        id: VALIDATOR_ID,
        validate(plan: Plan): ValidationResult {
          return validateTripPlan(plan);
        },
      };
    },
  };
}

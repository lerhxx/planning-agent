/**
 * travel 领域包的**服务端注册**入口（供 `src/domains/index.ts` 桶文件调用）。
 *
 * 注册是**幂等的**：重复调用只会覆盖同 id 的包。
 * 注册失败会明确抛出 —— 缺段就是缺段，不静默降级。
 */
import { registerDomainPack } from '@/src/core/registry/domainRegistry';
import { TRAVEL_DOMAIN_ID } from './meta';
import { travelPack } from './pack';

export function registerTravelDomain(): string {
  const result = registerDomainPack(travelPack);
  if (!result.ok) {
    throw new Error(
      `travel Domain Pack 注册失败：missing=[${result.missing.join(',')}] issues=[${result.issues.join('; ')}]`,
    );
  }
  return travelPack.meta.id;
}

export { travelPack };
export const travelDomainId: string = TRAVEL_DOMAIN_ID;

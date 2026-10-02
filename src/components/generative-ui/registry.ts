/**
 * 生成式 UI 组件注册表。
 *
 * 三段式查找：内核通用组件（`core:*`）→ 领域组件（`<domainId>:<name>`）→ 无（降级）。
 * `ComponentRenderer` 只通过本表取 schema 与懒加载入口，**不在别处硬编码组件名**。
 */
import type { ComponentDefinition } from '@/shared/domain/types';

export type RegisteredComponent = ComponentDefinition;

const coreComponents = new Map<string, RegisteredComponent>();
const domainComponents = new Map<string, Map<string, RegisteredComponent>>();

export function registerCoreComponents(definitions: RegisteredComponent[]): void {
  for (const definition of definitions) {
    coreComponents.set(definition.name, definition);
  }
}

export function registerCoreComponent(definition: RegisteredComponent): void {
  coreComponents.set(definition.name, definition);
}

/** 领域组件的懒加载入口由前端补齐（`load` 是可选的）。 */
export function registerDomainComponents(
  domainId: string,
  definitions: RegisteredComponent[],
): void {
  const bucket = domainComponents.get(domainId) ?? new Map<string, RegisteredComponent>();
  for (const definition of definitions) {
    bucket.set(definition.name, definition);
  }
  domainComponents.set(domainId, bucket);
}

/** 先查领域，再回落到内核通用组件。 */
export function resolveComponent(domainId: string, name: string): RegisteredComponent | undefined {
  return domainComponents.get(domainId)?.get(name) ?? coreComponents.get(name);
}

export function listCoreComponents(): string[] {
  return [...coreComponents.keys()];
}

export function listDomainComponents(domainId: string): string[] {
  return [...(domainComponents.get(domainId)?.keys() ?? [])];
}

/** 组件是否"渲染就绪"：既有 schema 又有懒加载入口。 */
export function isRenderable(definition: RegisteredComponent | undefined): boolean {
  return definition !== undefined && definition.load !== undefined;
}

/** 测试专用。 */
export function clearComponentRegistry(): void {
  coreComponents.clear();
  domainComponents.clear();
}

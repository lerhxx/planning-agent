/**
 * 领域包的**服务端唯一入口**（桶文件）。
 *
 * ★ 反向剥离的落点：内核（`src/core/**`、 `shared/**`）与传输层只认识本文件导出的
 * `registerAllDomains()`；新增领域包时**只改这里**，引用点数量不变。
 *
 * ★ 为什么 UI 注册不在这个文件里：`registerAllUI()` 会触及 `'use client'` 的 React 组件，
 * 若从服务端 `route.ts` 连带 import 进服务端模块图，会把组件代码拖进服务端包体。
 * 因此客户端入口单独放在 `./ui`（`page.tsx` 引它，`route.ts` 不引）。
 */
import { registerDemoDomain } from './demo/register';

/**
 * 注册全部领域包。**幂等**：重复调用只会覆盖同 id 的包。
 *
 * @returns 已注册的领域 id 列表（第一个为默认领域）。
 */
export function registerAllDomains(): string[] {
  return [registerDemoDomain()];
}

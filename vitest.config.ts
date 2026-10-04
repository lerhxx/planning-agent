import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('./', import.meta.url));

/*
 * 两个 project，刻意分开：**既有测试的运行环境一格都不许变**。
 *
 * - `unit`（node）：include 与改造前完全一致（`src/**` + `shared/**`），
 *   环境、CSS 处理、依赖内联规则全部沿用默认 —— 现有 35 个文件的行为不受影响。
 * - `shell`（jsdom）：只装 `app/**` 下的外壳层集成测试（当前只有
 *   `app/_lib/attachmentWait.test.tsx`）。它需要三样 unit 用不到的东西：
 *     1. jsdom —— 要真的挂载 React 组件树；
 *     2. `css: false` —— `@copilotkit/react-core/v2` 的模块图里带一个 `index.css`
 *        副作用导入，Node 的 ESM loader 不认 `.css` 扩展名（报 Unknown file extension）；
 *     3. `server.deps.inline` —— 让 vite 去转换 `@copilotkit` / `@ag-ui`，
 *        而不是交给 Node 的 ESM loader 直接解析。
 *   这三样全部**只作用于 shell project**，不会渗到 unit。
 *
 * 为什么用 projects 而不是 `environmentMatchGlobs`：后者只能切环境，切不了
 * `css` / `server.deps.inline`，而这两样才是加载 CopilotKit 的真正前提；
 * 而且 `environmentMatchGlobs` 在 vitest 3 已废弃（每次运行都会告警）。
 */
export default defineConfig({
  resolve: {
    alias: { '@': root },
  },
  test: {
    reporters: ['default'],
    projects: [
      {
        resolve: { alias: { '@': root } },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'shared/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: { '@': root } },
        test: {
          name: 'shell',
          environment: 'jsdom',
          include: ['app/**/*.test.tsx', 'app/**/*.test.ts'],
          testTimeout: 30_000,
          css: false,
          server: { deps: { inline: [/@copilotkit/, /@ag-ui/] } },
        },
      },
    ],
  },
});

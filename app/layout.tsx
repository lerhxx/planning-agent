import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// 顺序有意为之：先加载 CopilotKit v2 的自带样式，再用我们自己的 globals 覆盖其语义变量。
// （覆盖之所以稳赢，是因为 globals.css 里的规则是 unlayered，详见 globals.css 内注释。）
import '@copilotkit/react-core/v2/styles.css';
import './globals.css';

import Providers from './providers';

export const metadata: Metadata = {
  title: 'planning-agent · 目标驱动的规划型 Agent 基座',
  description:
    '给一个目标 → 产出可见可编辑可中断的计划 → 逐步执行 → 遇失败动态重规划。领域通过 Domain Pack 接入，内核零改动。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // 明亮主题：这里**不要**加 `className="dark"` —— CopilotKit v2 的默认变量就是明亮的，
    // 挂上 `.dark` 会把整套组件切到暗色分支（见 app/globals.css 顶部注释）。
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

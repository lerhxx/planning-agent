import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'planning-agent · 目标驱动的规划型 Agent 基座',
  description:
    '给一个目标 → 产出可见可编辑可中断的计划 → 逐步执行 → 遇失败动态重规划。领域通过 Domain Pack 接入，内核零改动。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

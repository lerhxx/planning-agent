import type { NextConfig } from 'next';

/**
 * `serverExternalPackages` 是给 MastraRuntime（M2 之后）预留的。
 * M1 不安装 `@mastra/*`，但这一行必须先写上，否则将来接入时打包会炸。
 * @see README.md §6
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['@mastra/*'],
  reactStrictMode: true,
};

export default nextConfig;

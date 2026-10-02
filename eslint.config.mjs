/**
 * ESLint 9 flat config（CLAUDE.md 要求仓库带 lint 门禁）。
 *
 * 刻意**不开** type-aware 规则（不接 `projectService`）：
 * 类型问题由 `npm run typecheck` 负责，lint 只管"不需要全量类型信息"的一致性，
 * 这样 `npm run lint` 能在 1 秒内跑完，适合当提交门禁。
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: '19' },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      // ---- 代码风格与可读性 ----
      eqeqeq: ['error', 'smart'],
      curly: ['error', 'multi-line'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // ---- TypeScript ----
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 内核里大量 `byId.get(id)!` 都是在显式存在性检查之后使用，禁用反而是噪音。
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',

      // ---- React ----
      'react/jsx-key': 'error',
      'react/no-unescaped-entities': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 测试文件：允许非空断言（夹具里到处都是"一定有值"的断言）。
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    // 内核红线：src/core 与 shared 里不允许出现 process.env / 网络调用。
    files: ['src/core/**/*.ts', 'shared/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '内核与 shared 禁止直接发网络请求：一律走 RuntimeAdapter。' },
      ],
    },
  },
);

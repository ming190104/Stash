import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'demo-library/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'vite.config.ts'],
    languageOptions: {
      // 类型感知：no-floating-promises 需要类型信息才能判断「这条语句是不是漏了 await / catch」
      // vite.config.ts 由 tsconfig.node.json 提供类型
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 本项目的 Tauri 事件载荷 / DOM 强转大量刻意使用 any，逐处标注没有收益
      '@typescript-eslint/no-explicit-any': 'off',
      // 漏掉的 .catch / 漏写的 void 是真实踩过的坑（String(err) → [object Object] 同源）
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 浏览器环境：全局由 TS 的 lib 声明负责，ESLint 不重复判
      'no-undef': 'off',
    },
  },
  {
    // 构建配置与脚本：Node 环境，全局变量由 @types/node 声明（tsconfig.node.json 会做 checkJs）
    files: ['scripts/**/*.{cjs,mjs}'],
    rules: { 'no-undef': 'off' },
  },
  {
    // 冒烟脚本是 CommonJS，require 是唯一可用的加载方式
    files: ['scripts/**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // 测试文件里允许直接丢 Promise（断言失败由 vitest 报）
    files: ['src/__tests__/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off', '@typescript-eslint/no-unused-expressions': 'off' },
  },
);

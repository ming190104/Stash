/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// 前端为原生 TS（无框架）：DOM 直接操作 + 模块单例状态，故不挂任何框架插件。
// 热更新与 120fps 焦点移动都靠原生模块 + CSS 变量，避免框架重渲染。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // tools/fake-game/target 会被 cargo 重写 exe，Vite 监听它会直接 EBUSY 崩掉 dev
      ignored: ["**/src-tauri/**", "**/tools/fake-game/target/**", "**/demo-library/**"],
    },
  },
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
  // 前端单测只覆盖逻辑与少量 DOM 骨架；覆盖率门槛放在 test:coverage，不拖慢日常 verify
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/mock.ts", "src/types.ts"],
      // 门槛略低于当前实测（64.1 / 56.0 / 62.1 / 67.4），用于阻止覆盖率继续下滑；
      // 提升测试后请同步上调，而不是让它长期贴着地板。
      thresholds: { statements: 63, branches: 55, functions: 61, lines: 66 },
    },
  },
});

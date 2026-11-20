/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// 版本号只有一个来源：package.json（Tauri 打包时同步读同一份）。界面里不再手写，
// 否则发版漏改就会出现「文件版本 1.3.0、关于页 1.2.5」这种自相矛盾。
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// 前端为原生 TS（无框架）：DOM 直接操作 + 模块单例状态，故不挂任何框架插件。
// 热更新与 120fps 焦点移动都靠原生模块 + CSS 变量，避免框架重渲染。
export default defineConfig({
  clearScreen: false,
  // 构建期常量：源码里写 __APP_VERSION__，由这里替换成当前包版本（vitest 同样生效）
  define: { __APP_VERSION__: JSON.stringify(version) },
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
    rollupOptions: {
      onwarn(warning, warn) {
        // 核心状态层（nav / overlay / quick / 面板）刻意用动态 import 载入 screens/*，
        // 以避免 nav ↔ screens 的静态环（见 src/overlay.ts 顶部导入规则）；
        // 而 main.ts 又必须静态载入同一批屏幕，Rollup 因此必然提示「无法分包」。
        // 该提示只关乎分包，不影响按需求值，这里只屏蔽这一种告警。
        if (
          warning.code === "PLUGIN_WARNING" &&
          warning.plugin === "vite:reporter" &&
          warning.message.includes("dynamic import will not move module into another chunk")
        ) {
          return;
        }
        warn(warning);
      },
    },
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
      // 门槛贴着当前实测（67.2 / 57.4 / 64.7 / 70.4）设，只留 0.2~0.4pp 余量：
      // 原来留 1pp 的「地板」等于允许覆盖率悄悄回退而不报警。补测试后请同步上调。
      thresholds: { statements: 67, branches: 57, functions: 64, lines: 70 },
    },
  },
});

/// <reference types="vite/client" />

/** 构建期注入的包版本（见 vite.config.ts 的 define）：唯一来源是 package.json */
declare const __APP_VERSION__: string;

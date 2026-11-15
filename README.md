# Stash

Windows 掌机与桌面上的本地 Galgame 游戏库前端。

库以手动添加游戏主程序为主，也支持扫描本地游戏库目录与 Steam 已安装条目；不接任何平台账号，数据全部留在本机。

## 功能

- **入库**：选择 exe + 标题即可入库，也可在应用内浏览文件、扫描游戏库目录或 Steam；自动识别引擎、会社、年份与标签，封面缺失时可从 Bangumi / 萌娘百科 / 批评空间 / 鲲 Galgame / SteamGridDB 补全
- **浏览**：经典轨道、网格、列表、海报墙四种视图；网格用于筛选与多选管理，海报墙用于沉浸浏览；多套主题、可调字号、竖排原名
- **详情**：背景图自动匹配与候选自选、封面替换、END 清单、评分、备注、自定义标签、游玩时长与场次
- **启动**：转区启动（Locale Emulator）、ISO 挂载、启动参数
- **操作**：键盘 / 鼠标 / 手柄全链路可用；手柄键位、AB 互换、死区、重复率、鼠标速度都能在设置里调
- **离线优先**：除在线元数据外，其余功能不需要网络

## 运行环境

- Windows 10 / 11 x64，需 WebView2 Runtime
- 设计基准 1280×720（7 寸 1080p 掌机 @150% 缩放），桌面大屏按 16:9 等比放大

## 目录结构

```
stash/
  src/          前端（原生 TypeScript + Vite，无框架）
  src-tauri/    后端（Rust / Tauri v2）
```

## 使用

从 Releases 下载安装包（`Stash_x.y.z_x64-setup.exe`）安装，或直接运行便携版 `Stash.exe`。

- 数据目录：`%APPDATA%\Stash`（库索引、设置、封面缓存）
- 日志目录：`%APPDATA%\Stash\logs`（按天滚动，保留 7 天）

## 从源码构建

需要 Node 20+、Rust stable（MSVC 工具链）、Visual Studio C++ Build Tools 与 WebView2 Runtime。

```powershell
cd stash
npm install
npm run tauri dev     # 开发模式
npx tauri build       # 产出 NSIS 安装包与可执行文件
```

## 更新检查

设置 → 关于 → 检查更新：读取 GitHub 最新 Release 版本并与当前版本比较，只做提示，下载交由系统浏览器完成，不会静默安装。

## 第三方组件

- [Locale Emulator](https://github.com/xupefei/Locale-Emulator)（LGPL-3.0）：转区启动，许可证原文随二进制放在 `stash/src-tauri/binaries/locale-emulator/`
- 元数据来自 Bangumi、萌娘百科、批评空间、鲲 Galgame、SteamGridDB

## License

尚未声明开源许可证。

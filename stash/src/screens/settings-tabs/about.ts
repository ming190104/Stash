/** 关于页签：品牌块 + 数据 / 日志 / 诊断 / 快捷键入口 + 最近问题（内容由 loadLogIssues 填充）。 */
export function aboutHTML(): string {
  return `
    <h2 class="sh">关于</h2>
    <div class="spanel"><div class="about">
      <div class="big"><div class="mark logo" aria-hidden="true"><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="vnmkTile" x1="40" y1="40" x2="984" y2="984" gradientUnits="userSpaceOnUse">
            <stop stop-color="#2d2029"/><stop offset="1" stop-color="#0f0a10"/>
          </linearGradient>
          <radialGradient id="vnmkGlow" cx=".5" cy=".5" r=".5">
            <stop stop-color="#ff96aa" stop-opacity=".2"/>
            <stop offset=".55" stop-color="#ff96aa" stop-opacity=".09"/>
            <stop offset="1" stop-color="#ff96aa" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="vnmkBook" x1="340" y1="320" x2="690" y2="790" gradientUnits="userSpaceOnUse">
            <stop stop-color="#ffa0be"/><stop offset="1" stop-color="#ffc99c"/>
          </linearGradient>
          <linearGradient id="vnmkPlank" x1="0" y1="745" x2="0" y2="799" gradientUnits="userSpaceOnUse">
            <stop stop-color="#684c5a"/><stop offset="1" stop-color="#342630"/>
          </linearGradient>
        </defs>
        <rect x="40" y="40" width="944" height="944" rx="214" fill="url(#vnmkTile)"/>
        <ellipse cx="512" cy="585" rx="235" ry="235" fill="url(#vnmkGlow)"/>
        <rect x="44" y="44" width="936" height="936" rx="210" fill="none" stroke="#ffd0a8" stroke-opacity=".17" stroke-width="5"/>
        <g transform="translate(512 520) scale(1.14) translate(-512 -520)">
          <g transform="translate(603 560) rotate(25)">
            <rect x="-90" y="-227" width="180" height="454" rx="36" fill="#130c12"/>
            <rect x="-83" y="-220" width="166" height="440" rx="30" fill="url(#vnmkBook)"/>
            <rect x="37" y="-200" width="26" height="400" rx="13" fill="#fff" fill-opacity=".345"/>
            <rect x="-85" y="-204" width="28" height="408" rx="14" fill="#762a3c" fill-opacity=".204"/>
          </g>
          <g transform="translate(421 560) rotate(-25)">
            <rect x="-90" y="-227" width="180" height="454" rx="36" fill="#130c12"/>
            <rect x="-83" y="-220" width="166" height="440" rx="30" fill="url(#vnmkBook)"/>
            <rect x="-63" y="-200" width="26" height="400" rx="13" fill="#fff" fill-opacity=".345"/>
            <rect x="57" y="-204" width="28" height="408" rx="14" fill="#762a3c" fill-opacity=".204"/>
          </g>
          <rect x="272" y="745" width="480" height="54" rx="27" fill="url(#vnmkPlank)"/>
          <path d="M306 748H718" stroke="#ffc99c" stroke-opacity=".52" stroke-width="6"/>
        </g>
      </svg></div><div><b style="font-size:17px;letter-spacing:3px">STASH</b><br/><span style="font-size:10.5px;letter-spacing:2px">本地游戏库前端</span></div></div>
      <span>版本 1.0.3 · 正式版</span>
      <span>Tauri v2 · WebView2 · Rust</span>
      <span>目标设备 · 掌机 1280×720 @120Hz / 桌面大屏等比放大（≤2×）</span>
      <span>元数据源 · Bangumi / 萌娘百科 / 批评空间（EGS）/ 鲲 Galgame</span>
      <span>图片源 · SteamGridDB；本地 meta.json 可补原名、会社、标签、简介与通关进度</span>
    </div></div>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>数据目录</b><span>库索引 / 设置 / 封面缓存<br/>%APPDATA%\\Stash</span></div>
        <span class="mini" data-act="opendata">打开</span></div>
      <div class="srow"><div class="lab"><b>日志目录</b><span>按天滚动 · 保留 7 份 · 单份 5MB<br/>出问题时先看这里</span></div>
        <span class="mini" data-act="openlogs">打开</span></div>
      <div class="srow"><div class="lab"><b>诊断报告</b><span>版本 / 环境 / 设置（凭据脱敏）/ 库统计 / 最近问题<br/>导成一份文本，便于反馈问题</span></div>
        <span class="mini" data-act="diagnostics">导出</span></div>
      <div class="srow"><div class="lab"><b>检查更新</b><span id="updTip">从 GitHub 读取最新 Release（当前 1.0.3）</span></div>
        <span class="mini" id="updBtn">检查</span></div>
      <div class="srow"><div class="lab"><b>快捷键总览</b><span>手柄键位（含截图，默认 Select）都在「键位」页签里改</span></div>
        <span class="mini" id="openHelpBtn">查看</span></div>
    </div>
    <div class="spanel" id="logBox">
      <div class="srow"><div class="lab"><b>最近的问题</b><span>加载中…</span></div></div>
    </div>`;
}

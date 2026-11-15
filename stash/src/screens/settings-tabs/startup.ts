/** 启动页签：开机自启 / 转区启动 / 转区工具。 */
import type { Settings } from '../../types';
import { esc } from '../../ui';
import { basename } from './common';

export function startupHTML(s: Settings): string {
  return `
    <h2 class="sh">启动</h2>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>开机自启</b><span>登录 Windows 后自动启动 · 写入当前用户启动项，任务管理器里可收回</span></div><button class="tg${s.autostart ? ' on' : ''}" id="tgBoot"></button></div>
      <div class="srow"><div class="lab"><b>转区启动</b><span>Shift-JIS 老引擎经工具以日文区域启动 · 不改系统设置</span></div><button class="tg${s.locale.launch ? ' on' : ''}" id="tgLocale"></button></div>
      <div class="srow"><div class="lab"><b>转区工具</b><span>安装包已内置 Locale Emulator · 也可另选 LEProc.exe / Ntleas.exe · 作品有 le.config 时按其配置启动，否则用 LEConfig.xml 第一条配置</span></div><span class="mini" id="pickLocale">${s.locale.toolPath ? esc(basename(s.locale.toolPath)) : '选择…'}</span></div>
    </div>`;
}

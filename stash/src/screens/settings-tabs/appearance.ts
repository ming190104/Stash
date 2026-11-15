/** 外观页签：主题 / 布局 / 动效 / 字号 / 竖排原名 / 音效。 */
import { state } from '../../state';
import type { Settings } from '../../types';
import { esc, normalizeFontScale, normalizeAnimSpeed, normalizeBootAnim } from '../../ui';
import { layoutMode } from '../library';
import { segHTML, THEME_LABEL } from './common';

export function appearanceHTML(s: Settings): string {
  return `
    <h2 class="sh">外观</h2>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>主题</b><span>界面配色 · 只影响前端，不改游戏与存档；背景氛围仍随封面变化</span></div>
        <span class="mini" id="pickTheme">${esc(THEME_LABEL[s.theme] ?? THEME_LABEL.cinema)} ▾</span></div>
      <div class="srow"><div class="lab"><b>界面布局</b><span>经典 = 大海报 + 封面轨道；列表 = 左列快速浏览 + 右侧大图；海报墙 = 大封面网格，方向键上下整排移动</span></div>
        ${segHTML('segLayout', [{ v: 'classic', label: '经典' }, { v: 'list', label: '列表' }, { v: 'wall', label: '海报墙' }], layoutMode())}</div>
      <div class="srow"><div class="lab"><b>动效强度</b><span>焦点弹跳与轨道滑动的幅度 · 与帧率档位正交</span></div>
        ${segHTML('segMotion', [{ v: '0', label: '标准' }, { v: '1', label: '柔和' }], String(state.motion))}</div>
      <div class="srow"><div class="lab"><b>启动与转场速度</b><span>启动跃迁与全屏切换的时长 · 不改变库内动效</span></div>
        ${segHTML('segAnimSpeed', [{ v: '0.5', label: '0.5×' }, { v: '1', label: '1×' }, { v: '1.5', label: '1.5×' }, { v: '2', label: '2×' }], String(normalizeAnimSpeed(s.animSpeed)))}</div>
      <div class="srow"><div class="lab"><b>启动动画</b><span>核心启动 = 仪器自检 3.0s；流光跃迁 = 光丝穿梭 2.2s；关闭 = 直接进库 · 下次启动生效，全屏切换固定用核心压缩段</span></div>
        ${segHTML('segBootAnim', [{ v: 'core', label: '核心启动' }, { v: 'warp', label: '跃迁' }, { v: 'off', label: '关闭' }], normalizeBootAnim(s.bootAnim))}</div>
      <div class="srow"><div class="lab"><b>界面字号</b><span>只放大文字，版式 / 封面 / 轨道几何不变</span></div>
        ${segHTML('segFont', [{ v: '0.9', label: '小' }, { v: '1', label: '标准' }, { v: '1.12', label: '大' }, { v: '1.25', label: '特大' }], String(normalizeFontScale(s.fontScale)))}</div>
      <div class="srow"><div class="lab"><b>竖排原文名</b><span>封面与背景水印显示日文原名</span></div><button class="tg${state.verticalTitle ? ' on' : ''}" id="tgVt"></button></div>
      <div class="srow"><div class="lab"><b>交互音效</b><span>移动 / 确认 / 返回 / 开关 / 截图 / 启动游戏的提示音 · 全部本地合成，不打包音频文件</span></div><button class="tg${s.sound.enabled ? ' on' : ''}" id="tgSound"></button></div>
      <div class="srow"><div class="lab"><b>音效音量</b><span>只影响本应用的提示音，与系统音量独立</span></div>
        ${segHTML('segSound', [{ v: '0.35', label: '小' }, { v: '0.6', label: '中' }, { v: '0.85', label: '大' }], String(s.sound.gain))}</div>
    </div>`;
}

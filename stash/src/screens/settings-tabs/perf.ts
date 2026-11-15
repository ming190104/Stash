/** 性能页签：全屏 / 帧率 / 排序 / FPS 面板 / 基线测试 / 60Hz。
 *  手柄相关的键位映射已独立成「键位」页签（在「外观」之下）。 */
import { SORT_MODES, state } from '../../state';
import type { Settings } from '../../types';
import { FPS_MODES, segHTML } from './common';

export function perfHTML(s: Settings): string {
  return `
    <h2 class="sh">性能</h2>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>全屏模式</b><span>立即全屏铺满（无边框），启动时保持 · 随时可关；手柄键位见「键位」页签</span></div>
        <button class="tg${s.fullscreen ? ' on' : ''}" id="tgFullMode"></button></div>
      <div class="srow"><div class="lab"><b>帧率档位</b><span>Auto：交互 120fps，静止自动降档；手动档全程恒定</span></div>
        ${segHTML('segFps', FPS_MODES.map((m) => ({ v: m, label: m === 'auto' ? 'Auto' : m })), s.fpsMode)}</div>
      <div class="srow"><div class="lab"><b>排序方式</b><span>轨道与网格共用同一排序</span></div>
        ${segHTML('segSort', SORT_MODES, state.sortBy)}</div>
      <div class="srow"><div class="lab"><b>FPS 信息面板</b><span>显示 FPS / 档位</span></div><button class="tg${localStorage.getItem('fpsPanel') === '1' ? ' on' : ''}" id="tgFps"></button></div>
      <div class="srow"><div class="lab"><b>平台基线测试</b><span>B1 空转 rAF + B2 合成动画</span></div><span class="mini" data-act="baseline">运行测试</span></div>
      <div class="srow"><div class="lab"><b>锁 60Hz 省电</b><span>切换系统刷新率，约省 1–2W · 切换时黑屏 1–2 秒，退出应用自动还原</span></div><button class="tg${s.power60 ? ' on' : ''}" id="tgPower"></button></div>
    </div>`;
}

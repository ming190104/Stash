/** 性能页签接线：帧率 / 排序 / FPS 面板 / 全屏 / 60Hz。
 *  手柄键位映射（含 A-B 互换 / 映射鼠标）已移到「键位」页签。 */

import type { FpsMode, SortMode } from '../../../types';
import { state } from '../../../state';
import { toast, esc, applyFullscreenUI } from '../../../ui';
import { setFullscreen, setPower60 } from '../../../ipc';
import { togglePanel } from '../../../fps';
import { renderRail } from '../../library';
import { renderGrid } from '../../grid';
import { persist } from '../persist';
import { warpToggle, warpBusy } from '../../../splash';

export function wirePerf(body: HTMLElement): void {
  // 帧率档位
  body.querySelectorAll('#segFps b').forEach((b) => {
    b.addEventListener('click', () => {
      const v = (b as HTMLElement).dataset.v as FpsMode;
      if (state.settings) {
        state.settings.fpsMode = v;
        persist()
          .then(() => toast(`帧率档位 · ${v === 'auto' ? 'Auto' : v + 'fps'}`))
          .catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
      }
      body.querySelectorAll('#segFps b').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  // 排序（落盘：总案 10.2 的 settings.sort，重启后仍生效）
  body.querySelectorAll('#segSort b').forEach((b) => {
    b.addEventListener('click', () => {
      state.sortBy = (b as HTMLElement).dataset.v as SortMode;
      state.focus = 0;
      body.querySelectorAll('#segSort b').forEach((x) => x.classList.toggle('on', x === b));
      renderRail();
      renderGrid();
      if (state.settings) {
        state.settings.sort = state.sortBy;
        persist().catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
      }
      toast('已重新排序');
    });
  });
  // FPS 面板开关
  body.querySelector('#tgFps')?.addEventListener('click', (e) => {
    togglePanel();
    (e.currentTarget as HTMLElement).classList.toggle('on', localStorage.getItem('fpsPanel') === '1');
  });
  // 全屏模式：先切窗口，成功才落盘（失败保持原状态，避免设置显示已开但实际没切）
  body.querySelector('#tgFullMode')?.addEventListener('click', (e) => {
    if (!state.settings) return;
    // 转场还没结束就再来一次：直接忽略。否则同一按键的第二次投递会在动画播完后
    // 把刚进入的全屏又切回去（「只按了一次 A 却进出各一次」）。
    if (warpBusy()) return;
    // 诊断：detail>1 是快速连点，isTrusted=false 是脚本合成（手柄 A 走 ringActivate）
    const me = e as MouseEvent;
    console.debug('[settings] 全屏开关点击', { detail: me.detail, trusted: me.isTrusted });
    const on = !state.settings.fullscreen;
    const btn = e.currentTarget as HTMLElement;
    // 立刻记下目标状态：连点两次时第二次才能正确算出反向，而不是重复「进入全屏」
    state.settings.fullscreen = on;
    btn.classList.toggle('on', on);
    // 进入 / 退出都播压缩段核心启动（1.0s），换边藏在锁定闪光下
    warpToggle(() => setFullscreen(on), true, { dropIfBusy: true })
      .then(() => {
        applyFullscreenUI(on);
        return persist();
      })
      .then(() => toast(`全屏模式 · ${on ? '已开启' : '已关闭'}`))
      .catch((err) => {
        state.settings!.fullscreen = !on;
        btn.classList.toggle('on', !on);
        toast(esc(String((err as { message?: string })?.message ?? err)), true);
      });
  });
  // P3 · 锁 60Hz 省电：先切显示模式，成功才落盘（失败保持原状）
  body.querySelector('#tgPower')?.addEventListener('click', (e) => {
    if (!state.settings) return;
    const on = !state.settings.power60;
    const btn = e.currentTarget as HTMLElement;
    setPower60(on)
      .then((hz) => {
        state.settings!.power60 = on;
        btn.classList.toggle('on', on);
        return persist().then(() => hz);
      })
      .then((hz) => toast(on ? '已锁 60Hz 省电 · 退出应用自动还原' : `已还原刷新率 · 当前 ${hz}Hz`))
      .catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
  });
}

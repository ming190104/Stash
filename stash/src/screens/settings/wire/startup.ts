/** 启动页签接线：开机自启 / 转区启动 / 转区工具。 */

import { state } from '../../../state';
import { toast, esc } from '../../../ui';
import { setAutostart, pickLocaleTool } from '../../../ipc';
import { basename } from '../../settings-tabs/common';
import { persist } from '../../../settings-persist';

export function wireStartup(body: HTMLElement): void {
  // P3 · 开机自启：写注册表，成功才落盘
  body.querySelector('#tgBoot')?.addEventListener('click', (e) => {
    if (!state.settings) return;
    const on = !state.settings.autostart;
    const btn = e.currentTarget as HTMLElement;
    setAutostart(on)
      .then(() => {
        state.settings!.autostart = on;
        btn.classList.toggle('on', on);
        return persist();
      })
      .then(() => toast(`开机自启 · ${on ? '已开启' : '已关闭'}`))
      .catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
  });
  // P4 · 转区启动：没有工具路径时先弹选择框；取消就保持原状（不给「开了却没生效」的假状态）
  body.querySelector('#tgLocale')?.addEventListener('click', async (e) => {
    if (!state.settings) return;
    const btn = e.currentTarget as HTMLElement;
    const on = !state.settings.locale.launch;
    if (on && !state.settings.locale.toolPath) {
      const p = await pickLocaleTool();
      if (!p) {
        toast('需先选择 LEProc.exe 或 Ntleas.exe');
        return;
      }
      state.settings.locale.toolPath = p;
      const lbl = document.getElementById('pickLocale');
      if (lbl) { lbl.textContent = basename(p); lbl.title = p; }
    }
    state.settings.locale.launch = on;
    // 开启转区启动时同时保留提示：两者不冲突（提示面向用户，启动面向进程）
    state.settings.locale.warnOnly = true;
    btn.classList.toggle('on', on);
    try {
      await persist();
      toast(`转区启动 · ${on ? '开（仅 Shift-JIS 引擎）' : '关（仅提示）'}`);
    } catch (err) {
      toast(esc(String((err as { message?: string })?.message ?? err)), true);
    }
  });
  // P4 · 转区工具：选择路径并落盘；已开启转区启动时立即换用新工具
  body.querySelector('#pickLocale')?.addEventListener('click', async () => {
    if (!state.settings) return;
    const p = await pickLocaleTool();
    if (!p) return;
    state.settings.locale.toolPath = p;
    const lbl = document.getElementById('pickLocale');
    if (lbl) { lbl.textContent = basename(p); lbl.title = p; }
    try {
      await persist();
      // toast 走 innerHTML：用户自选的路径（文件名可能含 < & 等）必须转义
      toast(`转区工具 · ${esc(basename(p))}`);
    } catch (err) {
      toast(esc(String((err as { message?: string })?.message ?? err)), true);
    }
  });
}

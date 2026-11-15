/** 设置落盘：失败时从磁盘重读设置，回滚内存与界面，避免「显示已改、实际没存」。 */

import { state } from '../../state';
import { getSettings, updateSettings } from '../../ipc';
import { applyTheme, applyLayout } from '../../ui';
import { renderRail } from '../library';
import { renderGrid } from '../grid';
import { rerender } from './ui';

export async function persist(): Promise<void> {
  if (!state.settings) return;
  try {
    await updateSettings(state.settings);
  } catch (e) {
    const prev = state.settings;
    state.settings = await getSettings().catch(() => prev);
    // 主题 / 布局已经写进 html + localStorage，必须按磁盘值一起回退，否则下次启动会闪回
    if (state.settings) {
      applyTheme(state.settings.theme);
      applyLayout(state.settings.layout);
      renderRail();
      renderGrid();
    }
    rerender();
    throw e;
  }
}

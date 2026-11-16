/** 设置落盘：整份覆盖写串行执行；失败时按磁盘值回滚全部运行时镜像。 */

import type { Settings } from '../../types';
import { state } from '../../state';
import { getSettings, updateSettings } from '../../ipc';
import {
  applyAnimSpeed,
  applyBootAnim,
  applyFontScale,
  applyLayout,
  applyMotion,
  applyTheme,
} from '../../ui';
import { applySoundSettings } from '../../sfx';
import { renderRail } from '../library';
import { renderGrid } from '../grid';
import { rerender } from './ui';

/** 写入链：连续修改排队提交，避免旧快照后到把新值覆盖回旧值。 */
let chain: Promise<void> = Promise.resolve();

/** 把当前设置整份落盘。
 *  排队轮到执行时才读取 state.settings：等待期间用户继续改动会合并进同一次提交。 */
export function persist(): Promise<void> {
  const run = chain.then(save);
  // 一次失败不阻断后续写入：各调用方收到各自的失败
  chain = run.catch(() => {});
  return run;
}

async function save(): Promise<void> {
  if (!state.settings) return;
  // 深拷贝本次快照：invoke 序列化前用户继续改 state.settings 也不影响已提交内容
  const next = JSON.parse(JSON.stringify(state.settings)) as Settings;
  try {
    await updateSettings(next);
  } catch (e) {
    await rollback();
    throw e;
  }
}

/** 失败回滚：主题 / 布局 / 排序 / 动效 / 字号 / 竖排 / 动画 / 音效都已即时生效，
 *  必须按磁盘值全部退回，否则会出现「显示已改、实际没存」。 */
async function rollback(): Promise<void> {
  const prev = state.settings;
  const disk = await getSettings().catch(() => prev);
  if (!disk) {
    rerender();
    return;
  }
  state.settings = disk;
  state.sortBy = disk.sort;
  state.motion = disk.motion;
  state.verticalTitle = disk.verticalTitle !== false;
  applyTheme(disk.theme);
  applyLayout(disk.layout);
  applyMotion(disk.motion === 1);
  applyFontScale(disk.fontScale);
  applyAnimSpeed(disk.animSpeed);
  applyBootAnim(disk.bootAnim);
  applySoundSettings(disk);
  renderRail();
  renderGrid();
  rerender();
}

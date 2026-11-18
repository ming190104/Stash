/** 设置落盘：整份覆盖写串行执行；失败时按磁盘值回滚全部运行时镜像。
 *
 *  放在核心层（而不是 screens/settings 下）：筛选面板 / 快捷菜单这些核心模块也要落盘，
 *  从核心反向 import 屏幕会形成循环依赖。回滚后的重绘由入口通过 `setSettingsAppliedHook`
 *  注册，核心层不感知具体屏幕。 */

import type { Settings } from './types';
import { state, SORT_MODES } from './state';
import { getSettings, updateSettings } from './ipc';
import {
  applyAnimSpeed,
  applyBootAnim,
  applyFontScale,
  applyFullscreenUI,
  applyLayout,
  applyMotion,
  applyTheme,
} from './ui';
import { applySoundSettings } from './sfx';

/** 写入链：连续修改排队提交，避免旧快照后到把新值覆盖回旧值。 */
let chain: Promise<void> = Promise.resolve();

/** 回滚后按磁盘值重建界面的钩子（入口注册：库屏 / 网格 / 设置页）。 */
let appliedHook: () => void = () => {};

export function setSettingsAppliedHook(fn: () => void): void {
  appliedHook = fn;
}

/** 把一份设置同步到全部运行时镜像（主题 / 布局 / 排序 / 动效 / 字号 / 竖排 / 动画 / 音效 / 全屏）。
 *  落盘失败回滚与「启动读设置失败后重试」共用：两处都必须退到同一份磁盘真值，
 *  否则会出现「设置页显示 A、窗口/缓存还是 B」。 */
export function applySettingsToRuntime(s: Settings): void {
  if (SORT_MODES.some((m) => m.v === s.sort)) state.sortBy = s.sort;
  state.motion = s.motion === 1 ? 1 : 0;
  state.verticalTitle = s.verticalTitle !== false;
  applyTheme(s.theme);
  applyLayout(s.layout);
  applyMotion(state.motion === 1);
  applyFontScale(s.fontScale);
  applyAnimSpeed(s.animSpeed);
  applyBootAnim(s.bootAnim);
  // 全屏也要回放：快捷菜单先改窗口再落盘，失败时界面/缓存不能停在「全屏」
  applyFullscreenUI(!!s.fullscreen);
  applySoundSettings(s);
}

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
    await rollback(next);
    throw e;
  }
}

/** 失败回滚：主题 / 布局 / 排序 / 动效 / 字号 / 竖排 / 动画 / 音效都已即时生效，
 *  必须按磁盘值全部退回，否则会出现「显示已改、实际没存」。
 *
 *  只退「提交后用户没再动过」的字段：整份替换会把失败等待期间的新改动一起冲掉——
 *  设置页连点几下（主题 → 音效 → 动效）时几乎必然出现这种情况，
 *  用户看到的是自己刚选的选项被弹回上一次的磁盘值。 */
async function rollback(submitted: Settings): Promise<void> {
  const disk = await getSettings().catch(() => null);
  if (!disk) {
    appliedHook();
    return;
  }
  const merged = JSON.parse(JSON.stringify(disk)) as Settings;
  const cur = state.settings as Settings;
  const newer = (k: keyof Settings): boolean =>
    JSON.stringify(cur[k]) !== JSON.stringify(submitted[k]);
  let dirty = false;
  for (const k of Object.keys(submitted) as (keyof Settings)[]) {
    // 内存里的值与提交快照不同 = 这是失败之后用户的新改动，留着等下一次提交
    if (newer(k)) {
      Reflect.set(merged, k, cur[k]);
      dirty = true;
    }
  }
  // 没有更新的改动：直接用磁盘对象本身（其余调用方按引用比较设置是否被换过）
  state.settings = dirty ? merged : disk;
  applySettingsToRuntime(state.settings);
  appliedHook();
}

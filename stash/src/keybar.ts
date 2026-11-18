/** 底栏键位提示：连接手柄后整条换成手柄键位，拔出立刻回到键盘键位。
 *  键帽文字跟随设置页的自定义映射（改键后立刻刷新）。
 *  只列手柄真能做到的操作——Q/E 切网格、F 筛选、M 多选这些没有手柄映射的
 *  条目不显示，避免提示一个按不出来的键。多选用手柄固定的 Select 键。 */

import { state } from './state';
import { setRawHTML } from './html';
import { PAD_DEFAULT, padGlyph } from './padmap';
import type { PadMap } from './types';

const KK = (k: string, extra = ''): string => `<span class="kk pad${extra}">${k}</span>`;

const KG = (keys: string, label: string): string => `<span class="kg">${keys}${label}</span>`;

function mapOf(): PadMap {
  return state.settings?.padMap ?? PAD_DEFAULT;
}

/** 动作 → 当前绑定的键帽文字（按手柄布局换成 Xbox / PS / Nintendo glyph） */
function key(a: keyof PadMap): string {
  return padGlyph(mapOf()[a], state.padKind);
}

/** 多选入口固定为物理 Select（不参与改键映射），多选态下再提示 X 批量 */
const multiHint = (): string =>
  state.gridMulti
    ? KG(KK(key('x')), '批量操作')
    : KG(KK(padGlyph('select', state.padKind)), '多选');

/** 设置屏当前焦点区：页签列 / 面板。两套操作不同，底栏提示必须跟着换——
 *  否则「←→ 进入 / 调值」在面板里按 ← 会退出，在页签列按 ← 又什么都不做。 */
let settingsZone: 'nav' | 'panel' = 'nav';
/** 面板是否是「左右两列」：单列页签（性能 / 启动 / 网络）显示「换列」会误导，
 *  因为那个方向根本没有第二个控件（评审 C）。由 ui.applyRing 按几何判断后写入。 */
let settingsMulti = true;
/** 整页没有可聚焦控件（只读内容页）：底栏只提示滚动。焦点不会离开最后一项，
 *  所以这是「页级只读」，不是滚过末尾的模式。 */
let settingsReadOnly = false;

/** 设置屏焦点区变化时刷新底栏（导航类高频调用，值没变直接返回） */
export function setSettingsZone(z: 'nav' | 'panel'): void {
  if (settingsZone === z) return;
  settingsZone = z;
  if (connected) applyPadHints(true);
}

export function setSettingsLayout(multi: boolean, readOnly: boolean): void {
  if (settingsMulti === multi && settingsReadOnly === readOnly) return;
  settingsMulti = multi;
  settingsReadOnly = readOnly;
  if (connected) applyPadHints(true);
}

/** 四屏手柄键位条（每次调用都按当前映射生成，改键后刷新即可） */
function padBars(): Record<string, string> {
  return {
    library: [
      KG(KK('✚'), '切换'),
      KG(KK(key('accept'), ' acc'), '启动游戏'),
      KG(KK(key('y')), '详情'),
      multiHint(),
      KG(KK(key('menu')), '快捷菜单'),
    ].join(''),
    grid: [
      KG(KK('✚'), '移动'),
      KG(KK(key('accept'), ' acc'), '详情'),
      multiHint(),
      KG(`${KK(key('lb'))}${KK(key('r'))}`, '分类'),
      KG(KK(key('y')), '筛选'),
      KG(KK(key('back')), '返回轨道'),
    ].join(''),
    detail: [
      KG(KK('✚'), '选择'),
      KG(`${KK('←')}${KK('→')}`, '版本'),
      KG(KK(key('accept'), ' acc'), '启动游戏'),
      KG(KK(key('menu')), '快捷菜单'),
      KG(KK(key('y')), '结局标记'),
      KG(KK(key('r')), '收藏'),
      KG(KK(key('back')), '返回'),
    ].join(''),
    // 设置屏：页签列与面板的操作不同，分开写，避免提示与实际行为对不上
    settings:
      settingsZone === 'nav'
        ? [
            KG(`${KK('↑')}${KK('↓')}`, '切换页签'),
            // A 在前：原来「→ A 进入面板」读起来像「先按 → 再按 A」
            KG(`${KK(key('accept'), ' acc')}${KK('→')}`, '进入面板'),
            KG(KK(key('back')), '返回'),
          ].join('')
        : settingsReadOnly
          ? [
              KG(`${KK('↑')}${KK('↓')}`, '滚动内容'),
              KG(KK(key('back')), '回页签'),
            ].join('')
          : [
              KG(`${KK('↑')}${KK('↓')}`, '同列移动'),
              settingsMulti ? KG(`${KK('←')}${KK('→')}`, '换列') : '',
              KG(KK(key('accept'), ' acc'), '确认'),
              KG(KK(key('back')), '回页签'),
            ].join(''),
    files: [
      KG(KK('✚'), '选择'),
      KG(KK(key('accept'), ' acc'), '进入 / 入库'),
      KG(KK(key('back')), '返回'),
      KG(KK(key('x')), '入库'),
      KG(KK(key('y')), '整目录入库'),
      KG(KK(key('lb')), '隐藏文件'),
      KG(KK(key('r')), '刷新'),
    ].join(''),
  };
}

/** 键盘键位原始 HTML：首次切换前抓一次，拔掉手柄时原样还回去 */
const kbBackup = new WeakMap<HTMLElement, string>();

/** 当前是否处于手柄模式（改键后刷新底栏时保持） */
let connected = false;

/** 按手柄连接状态切换四屏底栏（幂等，可重复调用） */
export function applyPadHints(on: boolean): void {
  connected = on;
  const bars = padBars();
  document.querySelectorAll<HTMLElement>('.screen').forEach((sc) => {
    const bar = sc.querySelector<HTMLElement>('.keybar');
    const pad = bars[sc.dataset.s ?? ''];
    if (!bar || !pad) return;
    let kb = kbBackup.get(bar);
    if (kb === undefined) {
      kb = bar.innerHTML;
      kbBackup.set(bar, kb);
    }
    const next = on ? pad : kb;
    if (bar.innerHTML !== next) setRawHTML(bar, next);
  });
}

/** 改键后立刻刷新底栏文案（保持当前连接态） */
export function refreshPadHints(): void {
  applyPadHints(connected);
}

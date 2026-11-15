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

/** 截图只对运行中的游戏有意义：没在跑就不提示，免得按了没反应 */
const shotHint = (): string => (state.running ? KG(KK(key('shot')), '截图') : '');

/** 多选入口固定为物理 Select（不参与改键映射），多选态下再提示 X 批量 */
const multiHint = (): string =>
  state.gridMulti
    ? KG(KK(key('x')), '批量操作')
    : KG(KK(padGlyph('select', state.padKind)), '多选');

/** 四屏手柄键位条（每次调用都按当前映射生成，改键后刷新即可） */
function padBars(): Record<string, string> {
  return {
    library: [
      KG(KK('✚'), '切换'),
      KG(KK(key('accept'), ' acc'), '启动游戏'),
      KG(KK(key('y')), '详情'),
      multiHint(),
      KG(KK(key('menu')), '快捷菜单'),
      shotHint(),
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
      shotHint(),
      KG(KK(key('back')), '返回'),
    ].join(''),
    settings: [
      KG(KK('✚'), '切换页签'),
      KG(KK('→'), '进入面板'),
      KG(KK(key('accept'), ' acc'), '确认'),
      KG(KK(key('back')), '返回'),
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

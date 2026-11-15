/** 状态层核心：层清单、可见性判定、单例开关与通用加载态。
 *  具体面板（搜索 / 筛选 / 截图 / 结局 / 空态）各自独立成模块，
 *  这里只保留被多模块共享的“层是否打开”与隐藏逻辑，避免互相 import 成环。 */

import { dismissPrompt } from './prompt';

const LAYERS = [
  'emptyState',
  'loadingState',
  'errorState',
  'searchPanel',
  'filterPanel',
  'endPanel',
  'shotPanel', // 截图查看器：计入 anyState，左右切换不会穿透到详情屏去换版本
  'bgPanel', // 背景候选卡片墙：方向键在卡片间移动，不许穿透到详情屏
  'candPanel', // 改绑条目候选墙：A 绑定 / X 取消匹配，同样不穿透到设置页
  'helpPanel', // 快捷键总览（F1 / ?）：打开时底层屏幕与快捷键一律不响应
  'qmenu', // 快捷菜单（P4）：计入 anyState，库屏快捷键不会在菜单上重复触发
  'promptLayer', // 输入弹层（P4 B10/B6）：打开时底层屏幕不抢键
  'launchLayer', // 启动/运行遮罩：游戏运行期间按键与方向键不穿透到底层库屏
];

/** 需要阻止浏览器默认行为的键（无输入焦点时） */
export const NATIVE_DEFAULT = new Set([
  'Escape',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Tab',
]);

/** 层是否可见：启动遮罩用 `on`（配合 .launch-layer.on 样式），其余统一 `show` */
function layerShown(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  return el.classList.contains(id === 'launchLayer' ? 'on' : 'show');
}

/** 有任一状态层处于打开态 */
export function anyState(): boolean {
  return LAYERS.some(layerShown);
}

/** 启动/运行遮罩是否显示中 */
export function launchShown(): boolean {
  return layerShown('launchLayer');
}

/** 除「启动遮罩」外的模态层：菜单键在游戏运行中仍要能弹快捷菜单（结束游戏在那里） */
export function modalState(): boolean {
  return LAYERS.filter((id) => id !== 'launchLayer').some(layerShown);
}

export function hideStates(): void {
  dismissPrompt(); // 输入弹层被顺带关掉时，把 Promise 以 null 收尾
  // 状态层只是 opacity:0（不是 display:none），焦点若还留在层内输入框（搜索框），
  // 它会继续接管键盘，把 / F 数字 这些全局快捷键全部吞掉——收起时统一主动失焦
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae.closest('.state')) ae.blur();
  document.querySelectorAll('.state').forEach((s) => s.classList.remove('show'));
  // 快捷菜单不是 .state（类名 qmenu），单例切换时也必须跟着收起，否则两层叠在一起
  document.getElementById('qmenu')?.classList.remove('show');
  document.querySelectorAll('#spList .sp-item.on').forEach((x) => x.classList.remove('on'));
}

/** 单例切换：任何一层打开前先关掉其余层 */
export function showState(id: string): void {
  hideStates();
  document.getElementById(id)?.classList.add('show');
}

export function emptyShown(): boolean {
  return document.getElementById('emptyState')?.classList.contains('show') ?? false;
}

/** 快捷键总览（F1 / ?）：单例状态层，Esc / B 由 handleOverlayKey 的兜底分支统一关闭 */
export function openHelp(): void {
  showState('helpPanel');
}

export function searchShown(): boolean {
  return document.getElementById('searchPanel')?.classList.contains('show') ?? false;
}

export function filterShown(): boolean {
  return document.getElementById('filterPanel')?.classList.contains('show') ?? false;
}

export function endShown(): boolean {
  return document.getElementById('endPanel')?.classList.contains('show') ?? false;
}

export function shotShown(): boolean {
  return document.getElementById('shotPanel')?.classList.contains('show') ?? false;
}

export function bgShown(): boolean {
  return document.getElementById('bgPanel')?.classList.contains('show') ?? false;
}

/** 只收起空态层（库有数据时由 updateEmpty 调用；不触碰搜索/加载/失败层） */
export function hideEmpty(): void {
  document.getElementById('emptyState')?.classList.remove('show');
}

/* ============ 加载 ============ */

export function showLoading(cap = '正在生成缩略图'): void {
  const el = document.getElementById('skCap');
  if (el) el.textContent = cap;
  showState('loadingState');
}

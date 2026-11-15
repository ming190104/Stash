/** 设置屏共享 UI 状态：页签索引、焦点区（页签列 / 面板）、手柄改键态、重渲染入口。
 *  重渲染走注册回调（由 settings.ts 注入），避免 wire / actions 反向 import 主文件成环。 */

import type { PadMap } from '../../types';
import { toast, ringEls, ringFocus, ringClear } from '../../ui';

export const sui = {
  /** 当前页签（0 性能 … 8 关于） */
  tab: 0,
  /** 焦点环所在区：左侧页签 or 右侧面板。掌机上左右键在这两层之间进出。 */
  zone: 'nav' as 'nav' | 'panel',
  /** 面板内焦点索引（每次重建面板后按新 DOM 夹紧） */
  panelIdx: 0,
  /** 正在等按键的动作（null = 不在改键态） */
  capturePad: null as keyof PadMap | null,
  /** 进入改键态的时间：吞掉「按 A 激活这一行」的同一次按压 */
  captureAt: 0,
  /** 改键会话序号：同一行反复点击时，上一枚 10 秒超时定时器不能再把新会话清掉 */
  captureSeq: 0,
  /** 上一次渲染的页签：切换页签时把面板滚回顶部，后台重渲染则保留滚动位置 */
  lastRenderedTab: -1,
};

let rerenderFn: () => void = () => {};

/** settings.ts 启动时注入真正的 renderSettings（本模块不反向依赖主文件） */
export function setRerender(fn: () => void): void {
  rerenderFn = fn;
}

/** 需要整块重建设置面板时调用 */
export function rerender(): void {
  rerenderFn();
}

/** 面板区可聚焦控件（每次 render 后 DOM 会重建，不能缓存） */
export function panelEls(): HTMLElement[] {
  const body = document.getElementById('sbody');
  return body ? ringEls(body) : [];
}

/** 只读页（统计 / 关于）面板里没有控件：进入的是「内容区」而不是焦点环，
 *  否则折在下面的图表（最近 7 天）在手柄上永远看不到。 */
export function enterRead(): void {
  sui.zone = 'panel';
  applyRing();
  toast('内容区 · ↑↓ 滚动 · B 返回页签');
}

/** 只读内容区整页滚动（一屏 82%，留一点上下文） */
export function scrollPanel(dir: 1 | -1): void {
  const body = document.getElementById('sbody');
  if (!body) return;
  body.scrollBy({ top: dir * Math.max(160, Math.round(body.clientHeight * 0.82)), behavior: 'smooth' });
}

/** 应用当前焦点环（nav 区高亮页签，panel 区高亮控件） */
export function applyRing(): void {
  const nav = document.getElementById('snav');
  const navBtns = nav ? ringEls(nav) : [];
  // 设置屏没激活时仍可挂环（.screen 只切 opacity，元素始终在布局里），
  // 但页签一旦为空集（DOM 尚未建好）就必须直接返回——ringFocus 返回 0 会把
  // tab 悄悄重置回第一页签（后台 rescan 顺带重渲染时踩过这个坑）。
  if (!navBtns.length) return;
  if (sui.zone === 'nav') {
    sui.panelIdx = Math.max(0, sui.panelIdx);
    ringClear(panelEls());
    sui.tab = ringFocus(navBtns, sui.tab);
  } else {
    ringClear(navBtns);
    sui.panelIdx = ringFocus(panelEls(), sui.panelIdx);
  }
}

/** 封面卡片（经典轨道 / 海报墙共用）：结构 + 点击语义。
 *  动作由 library.ts 注入（聚焦 / 打开详情 / 启动 / 多选），避免 card ↔ library 静态循环。 */

import type { Game } from '../types';
import { versionGroup } from '../state';
import { artHTML } from './art';
import { setRawHTML } from '../html';

export type CardActions = {
  /** 点击卡片 = 聚焦（多选态下改为勾选） */
  onFocus: (i: number) => void;
  /** 双击 = 打开详情（与网格屏一致，绝不直接启动游戏） */
  onOpen: (id: string) => void;
  /** 列表右侧大图上的「启动游戏」 */
  onLaunch: () => void;
  onToggleSel: (id: string) => void;
  /** 触摸横扫松手后短暂吞掉补发的 click */
  suppressed: () => boolean;
  multi: () => boolean;
};

let actions: CardActions = {
  onFocus: () => {},
  onOpen: () => {},
  onLaunch: () => {},
  onToggleSel: () => {},
  suppressed: () => false,
  multi: () => false,
};

/** initLibrary 时注入一次 */
export function initCard(a: CardActions): void {
  actions = a;
}

/** 卡片 / 列表行 / 海报墙标题共用的点击语义：多选态勾选，否则聚焦 */
export function activateCard(g: Game, i: number): void {
  if (actions.suppressed()) return;
  if (actions.multi()) {
    actions.onToggleSel(g.id);
    return;
  }
  actions.onFocus(i);
}

/** 双击语义：多选态 / 刚横扫完都不触发 */
export function openCard(g: Game): void {
  if (actions.suppressed() || actions.multi()) return;
  actions.onOpen(g.id);
}

/** 列表右侧大图的启动按钮 */
export function launchFromCard(): void {
  actions.onLaunch();
}

/** 列表右侧大图的「作品详情」按钮 */
export function openFromCard(id: string): void {
  actions.onOpen(id);
}

export function buildCard(g: Game, i: number, lastId: string | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.i = String(i);
  /* 「最近」与「★」同占左上 10px：同时存在时把 np 右移 28px，避免两徽标叠压 */
  const np = g.id === lastId ? `<span class="np"${g.favorite ? ' style="left:38px"' : ''}><i></i>最近</span>` : '';
  // B7：同名多版本（汉化 / 生肉 / 不同发行）在卡上标出来，详情页可切
  const multi = versionGroup(g).length;
  // NEW = 从未启动（玩过一次就消失）；旧实现用 progress===0，导致「已玩过但还没记进度」
  // 的作品永远挂着 NEW，甚至与左上角的「最近」自相矛盾。
  const isNew = !g.lastPlayed;
  setRawHTML(
    el,
    `
    ${artHTML(g)}
    <div class="dim"></div><div class="lift"></div>
    <div class="sheen"></div>
    <div class="ring"></div>
    ${g.favorite ? '<span class="fav">★</span>' : ''}
    ${np}
    ${isNew ? '<span class="new">NEW</span>' : ''}
    ${multi ? `<span class="ver">+${multi} 版</span>` : ''}
    ${g.progress > 0 ? `<div class="prog"><i style="width:${Math.round(g.progress * 100)}%"></i></div>` : ''}`,
  );
  el.dataset.id = g.id;
  el.addEventListener('click', () => activateCard(g, i));
  el.addEventListener('dblclick', () => openCard(g));
  return el;
}

/** 大库窗口化的占位：保留 170×226 与步长，只隐藏内容（不参与绘制 / 点击） */
export function buildSlot(i: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card slot';
  el.dataset.i = String(i);
  return el;
}

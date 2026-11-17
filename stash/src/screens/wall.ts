/** 海报墙布局：6 列大封面 + 单行标题；←→ 逐张、↑↓ 整排（行列入参由 library 计算）。
 *  焦点只给当前卡（不再给邻居挂 n1/n2——那套景深是轨道布局的效果）。 */

import type { Game } from '../types';
import { state, sortedGames, versionCounts } from '../state';
import { activateCard, buildCard } from './card';
import { hydrateArts } from './art';
import { setAmbient } from './hero';
import { clearHTML } from '../html';

/** 海报墙每行列数（与 app.css 的 grid-template-columns 一致） */
export const WALL_COLS = 6;

/** 海报墙索引 → [行, 列]：索引先夹进 [0, total-1]，空库与越界输入都不会算出负行 / 越列。 */
export function wallPos(i: number, cols: number, total: number): [number, number] {
  if (total <= 0) return [0, 0];
  const k = Math.max(0, Math.min(total - 1, i));
  return [Math.floor(k / cols), k % cols];
}

export function renderWall(list: Game[], lastId: string | null, animateBase: boolean): void {
  const grid = document.getElementById('wallGrid');
  if (!grid) return;
  document.getElementById('railTrack')?.replaceChildren();
  document.getElementById('listRows')?.replaceChildren();
  document.getElementById('listPreview')?.replaceChildren();
  const prevCount = grid.children.length;
  clearHTML(grid);
  // 版本角标一次建索引：整墙逐卡过滤全库是 O(N²)
  const versions = versionCounts();
  list.forEach((g, i) => {
    const cell = document.createElement('div');
    cell.className = 'wall-cell';
    cell.dataset.i = String(i);
    cell.dataset.id = g.id;
    cell.appendChild(buildCard(g, i, lastId, versions));
    const mk = document.createElement('span');
    mk.className = 'selmk';
    mk.textContent = '✓';
    cell.appendChild(mk);
    const t = document.createElement('div');
    t.className = 'wt';
    t.textContent = g.title;
    t.title = g.title;
    t.addEventListener('click', () => activateCard(g, i));
    cell.appendChild(t);
    grid.appendChild(cell);
  });
  hydrateArts(grid);
  state.focus = Math.min(state.focus, Math.max(0, list.length - 1));
  // 阶梯入场只发给「刚建出来的空墙」：库内重绘（收藏 / 排序 / 缩略图回填）不重播
  grid.classList.remove('cascade');
  if (prevCount === 0 && animateBase && list.length > 0) {
    void grid.offsetWidth;
    grid.classList.add('cascade');
    window.setTimeout(() => grid.classList.remove('cascade'), 900);
  }
  applyWallFocus();
}

export function applyWallFocus(): void {
  const grid = document.getElementById('wallGrid');
  if (!grid) return;
  grid.querySelectorAll<HTMLElement>('.wall-cell').forEach((c) => {
    const i = Number(c.dataset.i);
    c.classList.toggle('on', i === state.focus);
    const card = c.querySelector('.card');
    card?.classList.toggle('focus', i === state.focus);
    card?.classList.remove('n1', 'n2');
  });
  grid.querySelector<HTMLElement>(`.wall-cell[data-i="${state.focus}"]`)?.scrollIntoView({ block: 'nearest' });
  // 背景氛围只在经典布局的 renderHero 里更新过：切到海报墙后 focus 一变，
  // 整窗背景与舞台外留边都还停在上一次经典布局的作品上，必须在这里同步。
  const g = sortedGames()[state.focus];
  if (g) setAmbient(g);
}

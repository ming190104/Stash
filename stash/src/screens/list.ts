/** 列表布局：左列紧凑行（缩略图 / 标题）+ 右侧大图与简介。 */

import type { Game } from '../types';
import { state, sortedGames } from '../state';
import { esc, fmtRelative, fmtDuration, cnFirst } from '../ui';
import { artHTML, hydrateArts } from './art';
import { clearHTML, setRawHTML } from '../html';
import { activateCard, launchFromCard, openCard, openFromCard } from './card';
import { setAmbient } from './hero';

function buildListRow(g: Game, i: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lrow';
  row.dataset.i = String(i);
  row.dataset.id = g.id;
  const meta = [g.developer, g.year].filter(Boolean).join(' · ') || g.engineLabel;
  setRawHTML(
    row,
    `
    <div class="lthumb">${artHTML(g)}</div>
    <div class="lmain">
      <div class="lt">${esc(g.title)}</div>
      <div class="ls">${esc(meta)}</div>
    </div>
    ${g.favorite ? '<span class="lfav">★</span>' : ''}
    <span class="selmk">✓</span>`,
  );
  row.addEventListener('click', () => activateCard(g, i));
  row.addEventListener('dblclick', () => openCard(g));
  return row;
}

export function renderList(list: Game[], animateBase: boolean): void {
  const box = document.getElementById('listRows');
  if (!box) return;
  document.getElementById('railTrack')?.replaceChildren();
  document.getElementById('wallGrid')?.replaceChildren();
  // 后台刷新（缩略图回填 / 收藏）重建列表时不打断用户滚动：只在首次建表时滚到焦点行
  const prevCount = box.children.length;
  const fresh = prevCount === 0;
  const keepScroll = box.scrollTop;
  clearHTML(box);
  list.forEach((g, i) => box.appendChild(buildListRow(g, i)));
  hydrateArts(box);
  // 入场只给「刚建出来的空表」：库内重绘（收藏 / 缩略图回填）不重播
  const entering = prevCount === 0 && animateBase && list.length > 0;
  const preview = document.getElementById('listPreview');
  box.classList.remove('lenter');
  preview?.classList.remove('enter');
  if (entering) {
    box.classList.add('lenter');
    preview?.classList.add('enter');
    window.setTimeout(() => {
      box.classList.remove('lenter');
      preview?.classList.remove('enter');
    }, 950);
  }
  state.focus = Math.min(state.focus, Math.max(0, list.length - 1));
  box.scrollTop = keepScroll;
  applyListFocus(fresh);
}

let listTimer = 0;

/** 列表焦点：只切行高亮 + 防抖刷新右侧大图（快速拨过不闪） */
export function applyListFocus(scroll = false): void {
  document.querySelectorAll<HTMLElement>('#listRows .lrow').forEach((r) => {
    r.classList.toggle('on', Number(r.dataset.i) === state.focus);
  });
  if (scroll) {
    document.querySelector<HTMLElement>(`#listRows .lrow[data-i="${state.focus}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  clearTimeout(listTimer);
  const preview = document.getElementById('listPreview');
  if (!preview || !preview.children.length) {
    renderListPreview();
    return;
  }
  listTimer = window.setTimeout(renderListPreview, 110);
}

export function renderListPreview(): void {
  const box = document.getElementById('listPreview');
  if (!box) return;
  const g = sortedGames()[state.focus];
  if (!g) {
    clearHTML(box);
    return;
  }
  const tags = g.tags.length
    ? g.tags.map((t, j) => `<span class="pill${j === 0 ? ' hot' : ''}">${esc(t)}</span>`).join('')
    : `<span class="pill">${esc(g.engineLabel)}</span>`;
  setRawHTML(
    box,
    `
    <div class="lp-art">${artHTML(g)}</div>
    <div class="lp-info">
      <div class="lp-eye">${esc([g.developer, g.year, 'VISUAL NOVEL'].filter(Boolean).join(' · '))}</div>
      <h2 class="lp-t">${esc(g.title)}</h2>
      <div class="lp-jp">${esc(g.titleOriginal || g.title)}</div>
      <div class="lp-rule"></div>
      <div class="lp-pills">${tags}</div>
      <p class="lp-sum">${esc(cnFirst(g.summary ?? '') || '尚未匹配元数据——当前信息来自本地目录。可在「设置 · 元数据」里运行 Bangumi 匹配。')}</p>
      <div class="lp-meta">
        <span>${fmtRelative(g.lastPlayed)}</span><span class="lp-dot"></span>
        <span>累计 ${fmtDuration(g.playSeconds)}</span>
      </div>
      <div class="lp-cta">
        <button class="cta" id="listPlay"><span class="k">A</span>启动游戏</button>
        <button class="ghost" data-act="detail"><span class="k">Y</span>作品详情</button>
      </div>
    </div>`,
  );
  hydrateArts(box);
  // 同 applyWallFocus：列表布局没有 hero，背景氛围要跟着当前行走，否则整窗停在旧作品封面
  setAmbient(g);
  box.querySelector('#listPlay')?.addEventListener('click', () => launchFromCard());
  box.querySelector('[data-act="detail"]')?.addEventListener('click', () => openFromCard(g.id));
}

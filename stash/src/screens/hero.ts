/** 库屏 Hero：大海报 + 信息块 + 环境氛围 + 竖排水印。
 *  内容 180ms 防抖（快速拨卡不闪），并顺带预热焦点附近作品的详情背景。
 *  启动 / 进详情的动作由 library.ts 注入，避免 hero ↔ library 的静态循环依赖。 */

import type { Game } from '../types';
import { state, sortedGames, lastPlayedId } from '../state';
import { asset } from '../ipc';
import { esc, fmtRelative, fmtDuration, cnFirst, cssUrl } from '../ui';
import { placeholderArt } from '../art';
import { artHTML, hydrateArts } from './art';
import { setRawHTML } from '../html';
import { prepareDetailBg, warmDetailBg } from './detail-bg';
import { layoutMode } from './layout-mode';

type HeroActions = { launch: () => void; openDetail: (id: string) => void };
let actions: HeroActions = { launch: () => {}, openDetail: () => {} };

/** 注入 Hero 上的两个动作（启动游戏 / 打开详情）；initLibrary 时调用一次 */
export function initHero(a: HeroActions): void {
  actions = a;
}

let heroTimer = 0;
let heroSeq = 0;

/** hero 内容 180ms 防抖（总案 4.4：快速拨过时 hero 不闪烁） */
export function scheduleHero(): void {
  clearTimeout(heroTimer);
  if (layoutMode() !== 'classic') return; // 列表 / 海报墙没有大海报，信息由各自视图承担
  heroTimer = window.setTimeout(renderHero, 180);
}

function heroInfoHTML(g: Game): string {
  const pct = g.progress === 0 ? '未开始' : Math.round(g.progress * 100) + '%';
  const w = Math.round(g.progress * 100);
  // 有进度时按钮改为「继续游玩」，比统一的「启动游戏」更贴近实际动作
  const playLabel = g.progress > 0 ? '继续游玩' : '启动游戏';
  const tags = g.tags.length
    ? g.tags.map((t, j) => `<span class="pill${j === 0 ? ' hot' : ''}">${esc(t)}</span>`).join('')
    : `<span class="pill">${esc(g.engineLabel)}</span>`;
  // 从未游玩时不渲染「累计 —」：整段隐藏，避免句子中间出现占位符
  const dur = g.playSeconds > 0 ? `<span class="dot"></span><span>累计 ${fmtDuration(g.playSeconds)}</span>` : '';
  // 原名与标题相同（未匹配到日文原名）时不再重复一行
  const jp =
    g.titleOriginal && g.titleOriginal !== g.title
      ? `<div class="h-jp row">${esc(g.titleOriginal)}</div>`
      : '';
  return `
  <div class="eyebrow row">${esc([g.developer, g.year, 'VISUAL NOVEL'].filter(Boolean).join(' · '))}</div>
  <h1 class="h-cn row">${esc(g.title)}</h1>
  ${jp}
  <div class="h-rule row"></div>
  <div class="h-pills row">${tags}</div>
  <p class="h-sum row">${esc(cnFirst(g.summary ?? '') || '尚未匹配元数据——当前信息来自本地目录。可在「设置 · 元数据」里运行 Bangumi 匹配。')}</p>
  <div class="h-meta row">
    <div class="h-play"><span>${fmtRelative(g.lastPlayed)}</span>${dur}<span class="dot"></span><span>通关进度 ${pct}</span></div>
    <div class="h-bar enter"><i style="width:${w}%"></i></div>
  </div>
  <div class="h-cta row">
    <button class="cta" id="ctaPlay"><span class="k">A</span>${playLabel}</button>
    <button class="ghost" data-act="detail"><span class="k">Y</span>作品详情</button>
  </div>`;
}

/** 重新触发 CSS animation：移除 → 强制 reflow → 添加（mockup replay 同款） */
function replay(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** 水印取字：英文按词截断，中日文按字截断（mockup wmSlice 同款） */
function wmSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  if (/\s/.test(s)) {
    let out = '';
    for (const w of s.split(/\s+/)) {
      const next = out ? out + ' ' + w : w;
      if (next.length > max) break;
      out = next;
    }
    if (out) return out;
  }
  return s.slice(0, max);
}

/** 环境氛围：双 .amb 交叉溶解（mockup setAmbient 同款；有封面用图，无则渐变） */
let ambActive = 0;
let ambSeq = 0;
export function setAmbient(g: Game): void {
  const els = [document.getElementById('ambA'), document.getElementById('ambB')] as [HTMLElement, HTMLElement];
  const next = 1 - ambActive;
  // 快速连按时 asset() 可能乱序返回：旧作品的结果若写到「当前」图层，
  // 背景就会停在上一部的封面上（三次以上切换时图层索引会重新撞上）。
  const seq = ++ambSeq;
  if (g.cover || g.thumb) {
    const p = g.thumb || g.cover!;
    asset(p)
      .then((u) => {
        if (seq !== ambSeq) return;
        els[next].style.background = `${cssUrl(u)} center/cover no-repeat`;
      })
      .catch(() => {});
  } else {
    els[next].style.background = placeholderArt(g.id).bg;
  }
  els[next].classList.add('show');
  els[ambActive].classList.remove('show');
  ambActive = next;
}

export function renderHero(): void {
  const g = sortedGames()[state.focus];
  if (!g) return;
  // 预热详情背景：焦点与左右各 2 张都提前问一次（只读缓存目录，不发网络）。
  // 少一次预热就多一次「进详情才发现有背景图」，那几毫秒里只能先看封面。
  const ring = sortedGames();
  const at = ring.findIndex((x) => x.id === g.id);
  for (let k = at - 2; k <= at + 2; k++) {
    const near = ring[k];
    if (!near) continue;
    // 焦点这一张直接解码到 bgReady：进详情时切屏前就能铺图，首帧没有封面窗口；
    // 左右各 2 张只查路径，省掉多余的 1080p 解码
    if (k === at) void prepareDetailBg(near.id);
    else warmDetailBg(near.id);
  }
  const seq = ++heroSeq;

  const info = document.getElementById('heroInfo');
  const art = document.getElementById('heroArt');
  if (!info || !art) return;
  info.classList.add('swap');
  setTimeout(() => {
    if (seq !== heroSeq) return; // 期间焦点又变了，丢弃
    setRawHTML(info, heroInfoHTML(g));
    info.classList.remove('swap');
    replay(info, 'enter');
    info.querySelector('#ctaPlay')?.addEventListener('click', () => actions.launch());
    info.querySelector('[data-act="detail"]')?.addEventListener('click', () => actions.openDetail(g.id));
  }, 140);

  const isLast = g.id === lastPlayedId();
  setRawHTML(art, (isLast ? '<span class="np"><i></i>最近游玩</span>' : '') + artHTML(g));
  hydrateArts(art);
  replay(art, 'artin');

  const wmText = wmSlice(g.titleOriginal || g.title, 6);
  const wm = document.getElementById('heroWm');
  if (wm) {
    wm.textContent = wmText;
    wm.style.fontSize = `${Math.min(56, Math.floor(350 / (wmText.length * 1.28)))}px`;
    replay(wm, 'wmin');
  }

  setAmbient(g);
}

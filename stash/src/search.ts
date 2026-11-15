/** 搜索 · 排序面板（P0）：命中列表 / 拼音索引 / 历史词 / 键盘选中。
 *  层显示状态由 layers.ts 统一管理；点击结果后才动态加载详情屏，避免静态成环。 */

import type { Game } from './types';
import { state, sortedGames, SORT_MODES } from './state';
import { placeholderArt } from './art';
import { esc, clickable, toast } from './ui';
import { setRawHTML } from './html';
import { hideStates, showState, searchShown, NATIVE_DEFAULT } from './layers';
import { pinyinHay } from './pinyin';

/** 搜索折叠：NFKC（全角→半角）、忽略大小写、去分隔符、平假名→片假名。
 *  这样「せんれん」「千恋万花」「senren banka」「SENREN*BANKA」命中同一部作品。 */
function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_·・:：,，.。!！?？'"“”‘’()（）[\]【】<>《》~～*＊/\\|]+/g, '')
    .replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

export function searchList(): Game[] {
  const q = fold(state.query);
  const list = sortedGames();
  // 查询非空但折叠后为空（纯符号「***」）：语义上是「没有匹配」，不能当成空查询返回全库
  if (!q) return state.query.trim() ? [] : list;
  return list.filter((g) => haystack(g).includes(q));
}

/** 检索索引：原文字段 + 拼音全拼 / 首字母（qlwh → 千恋万花）。
 *  按 Game 对象缓存（签名含全部来源字段，原地改标题/标签也会失效），
 *  避免每次按键都对整库重算拼音。 */
const HAY_CACHE = new WeakMap<Game, { sig: string; hay: string }>();

function haystack(g: Game): string {
  const raw = [
    g.title,
    g.titleOriginal,
    g.romaji,
    g.developer,
    g.engineLabel,
    g.tags.join(' '),
    (g.userTags ?? []).join(' '),
    (g.aliases ?? []).join(' '),
  ].filter((x): x is string => !!x);
  const sig = raw.join('\u0001');
  const hit = HAY_CACHE.get(g);
  if (hit && hit.sig === sig) return hit.hay;
  const hay = fold(`${raw.join(' ')} ${raw.map(pinyinHay).join(' ')}`);
  HAY_CACHE.set(g, { sig, hay });
  return hay;
}

/* M5：搜索历史（localStorage，最近 8 条），空查询时作为快捷入口 */
const SEARCH_HIST = 'vnSearchHistory';

function readHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEARCH_HIST) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function pushSearchHistory(q: string): void {
  const t = q.trim();
  if (!t) return;
  const list = [t, ...readHistory().filter((x) => x !== t)].slice(0, 8);
  try {
    localStorage.setItem(SEARCH_HIST, JSON.stringify(list));
  } catch {
    /* 隐私模式写不进去就忽略 */
  }
}

/** 清空搜索历史（历史行末尾的「清空」chip） */
export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(SEARCH_HIST);
  } catch {
    /* 隐私模式删不掉就忽略 */
  }
  renderSearch();
}

/** 输入防抖：大库上每次按键都重绘结果 + 拼音检索会明显发涩，120ms 内的连续输入只算最后一次 */
let searchTimer: number | undefined;

export function scheduleSearchRender(): void {
  if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = undefined;
    renderSearch();
  }, 120);
}

/** 立即重绘并作废定时器：Enter / 手柄 A 会点当前候选，必须先让列表跟上最新输入 */
export function flushSearchRender(): void {
  if (searchTimer === undefined) return;
  window.clearTimeout(searchTimer);
  searchTimer = undefined;
  renderSearch();
}

export function renderSearch(): void {
  const box = document.getElementById('spList');
  if (!box) return;
  const list = searchList();
  const hist = state.query.trim() ? [] : readHistory();
  const histHtml = hist.length
    ? `<div class="sp-hist">${hist
        .map((q) => `<span class="sp-hchip" data-q="${esc(q)}">${esc(q)}</span>`)
        .join('')}<span class="sp-hchip sp-hclear" data-clear="1">清空</span></div>`
    : '';
  const listHtml = list.length
    ? list
        .slice(0, 9)
        .map(
          (g) => `
    <div class="sp-item" data-id="${esc(g.id)}">
      <div class="sp-th" style="background:${placeholderArt(g.id).bg}"></div>
      <div class="sp-tx"><div class="sp-nm">${esc(g.title)}</div><div class="sp-mt">${esc([g.developer, g.year].filter(Boolean).join(' · ')) || esc(g.engineLabel)}</div></div>
    </div>`,
        )
        .join('')
    : `<div class="sp-empty">没有匹配「${esc(state.query)}」的作品 · 试试会社名 / 标签 / 日文假名</div>`;
  setRawHTML(box, histHtml + listHtml);
  box.querySelectorAll<HTMLElement>('.sp-item').forEach((el) => {
    el.addEventListener('click', () => {
      pushSearchHistory(state.query);
      hideStates();
      const id = el.dataset.id!;
      void import('./screens/library').then((m) => m.openDetail(id));
    });
  });
  box.querySelectorAll<HTMLElement>('.sp-hchip').forEach((el) => {
    clickable(el);
    el.addEventListener('click', () => {
      if (el.dataset.clear) {
        clearSearchHistory();
        return;
      }
      const q = el.dataset.q ?? '';
      state.query = q;
      const inp = document.getElementById('spInput') as HTMLInputElement | null;
      if (inp) inp.value = q;
      renderSearch();
    });
  });
}

function renderSortSeg(): void {
  document.querySelectorAll('#spSort b').forEach((b, i) => b.classList.toggle('on', SORT_MODES[i].v === state.sortBy));
}

/** 切换排序档：搜索面板点击与手柄 ←/→ 共用同一条路径。 */
export function applySort(i: number): void {
  const mode = SORT_MODES[i];
  if (!mode) return;
  state.sortBy = mode.v;
  renderSortSeg();
  renderSearch();
  void import('./screens/library').then((m) => m.renderRail());
  void import('./screens/grid').then((m) => m.renderGrid());
  toast(`排序 · ${mode.label}`);
}

/** 手柄 ←/→：在排序档之间移动，焦点环画在当前档上。 */
export function sortStep(dir: number): void {
  const cur = Math.max(
    0,
    SORT_MODES.findIndex((m) => m.v === state.sortBy),
  );
  const next = (cur + dir + SORT_MODES.length) % SORT_MODES.length;
  applySort(next);
  document.querySelectorAll('#spSort b').forEach((b, i) => b.classList.toggle('focus', i === next));
}

export function openSearch(): void {
  state.query = '';
  const inp = document.getElementById('spInput') as HTMLInputElement | null;
  if (inp) inp.value = '';
  renderSortSeg();
  // 上次用手柄 ←/→ 留在排序档上的焦点环要清掉：面板关了它不会自己消失，
  // 重新打开时输入框已聚焦，旧环会让人误以为焦点还在排序行
  document.querySelectorAll('#spSort b').forEach((b) => b.classList.remove('focus'));
  renderSearch();
  showState('searchPanel');
  // 面板可能在 80ms 内被 B/Esc 收起：此时不能再把焦点送给隐藏的输入框，
  // 否则它会一直吞掉 / F 数字 等全局快捷键（与 prompt 的 focusTimer 同一类问题）
  setTimeout(() => {
    if (searchShown()) inp?.focus();
  }, 80);
}

/* ============ 面板键盘 ============ */

function selectResult(step: number): void {
  // 防抖窗口内先让列表跟上最新输入：否则方向键是在上一次的候选里选，Enter 会开到错误的作品
  flushSearchRender();
  const items = [...document.querySelectorAll<HTMLElement>('#spList .sp-item')];
  if (!items.length) return;
  const cur = items.findIndex((x) => x.classList.contains('on'));
  const k = cur < 0 ? (step > 0 ? 0 : items.length - 1) : (cur + step + items.length) % items.length;
  items.forEach((x, i) => {
    x.classList.toggle('on', i === k);
    // .focus 是手柄焦点环：只靠 .on 的背景在 TV 距离上几乎看不出来
    x.classList.toggle('focus', i === k);
  });
  items[k].scrollIntoView({ block: 'nearest' });
}

function activateResult(): void {
  // 防抖窗口内直接回车：先让候选列表跟上最新输入，否则会点到上一次的结果
  flushSearchRender();
  const el = document.querySelector<HTMLElement>('#spList .sp-item.on') ?? document.querySelector<HTMLElement>('#spList .sp-item');
  el?.click();
}

/** 焦点在搜索框：Esc / Enter / ↑↓ 交给候选列表，其余按键一律不触发全局快捷键 */
export function searchFieldKey(e: KeyboardEvent): boolean {
  if (e.code === 'Escape') {
    hideStates();
    e.preventDefault();
  } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    pushSearchHistory(state.query);
    activateResult();
    e.preventDefault();
  } else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
    selectResult(e.code === 'ArrowDown' ? 1 : -1);
    e.preventDefault();
  }
  return true; // 输入期间其余按键一律不触发全局快捷键（防 a / b / x / r 误触）
}

/** 面板打开且焦点不在输入框（点了排序 chip / 手柄合成事件）：A / ↑↓ / Esc 仍由面板消费 */
export function searchKey(e: KeyboardEvent): boolean {
  // 搜索框失焦时 Enter / A 仍必须能选中候选，否则手柄在搜索面板按 A 毫无反应。
  if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
    pushSearchHistory(state.query);
    activateResult();
    e.preventDefault();
    return true;
  }
  if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
    selectResult(e.code === 'ArrowDown' ? 1 : -1);
    e.preventDefault();
    return true;
  }
  // 手柄 ←/→ 切排序。键盘路径走 searchFieldKey，保留输入框内的光标移动
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    sortStep(e.code === 'ArrowRight' ? 1 : -1);
    e.preventDefault();
    return true;
  }
  if (e.code === 'Escape' || e.code === 'Backspace' || e.code === 'KeyB') {
    hideStates();
    e.preventDefault();
    return true;
  }
  if (NATIVE_DEFAULT.has(e.code)) e.preventDefault();
  return true;
}

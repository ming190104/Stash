/** 网格视图：5 列网格 + 筛选 chips（mockup buildGrid/clampGrid 零偏差迁移）。
 *  焦点夹紧到筛选后实际存在的格子；焦点卡与轨道共用 .card.focus 全套视觉。 */

import type { NavIntent } from '../types';
import { state, sortedGames, gridList, setScreen, isFinished, type GridFilter } from '../state';
import { registerHandler, isPadNavEvent } from '../nav';
import { artHTML, hydrateArts } from './art';
import { setRawHTML } from '../html';
import { openDetail, updateEmpty } from '../library-bridge';
import { esc, pressCard, toast } from '../ui';
import { showEmpty, searchShown, filterShown, hideEmpty, syncFilterChip, anyState } from '../overlay';
import { markSel, toggleSel, setMulti, openBatch } from '../multi';

const GRID_COLS = 6;
/** 上一次渲染网格时所在的屏幕：只有「从别的屏进网格」才播放阶梯涟漪，避免多选/筛选重绘时反复动 */
let lastGridScreen: string | null = null;
/** 网格 DOM 是否落后于数据：不在网格屏时不重建，等真正切进来再建一次 */
let gridDirty = true;

function buildGrid(animate = false): void {
  const wrap = document.getElementById('gridCards');
  if (!wrap) return;
  const list = gridList();
  const all = sortedGames();
  // 一次建索引：每张卡都 all.indexOf(g) 是大库里的 O(n²)（1000 部 = 百万次比较）
  const idx = new Map(all.map((g, i) => [g.id, i]));
  setRawHTML(
    wrap,
    list
    .map((g, i) => {
      // data-g 仍是「轨道（sortedGames）里的位置」，点击回查 all[gi] 的语义不变
      const gi = idx.get(g.id) ?? 0;
      const sub = [g.developer, g.year].filter(Boolean).join(' · ');
      const sel = state.gridSel.has(g.id);
      const delay = Math.min(i, 14) * 18;
      // 与轨道卡片同一套语义：只保留 NEW（从未启动）；「新」角标已移除
      const isNew = !g.lastPlayed;
      const finished = isFinished(g);
      return `
    <div class="gcell${sel ? ' sel' : ''}" data-i="${i}" data-g="${gi}" data-id="${esc(g.id)}" style="--d:${delay}ms">
      <div class="card">
        ${artHTML(g)}
        <div class="dim"></div><div class="lift"></div>
        <div class="ring"></div>
        ${g.favorite ? '<span class="fav">★</span>' : ''}
        ${isNew ? '<span class="new">NEW</span>' : ''}
        <span class="selmk">✓</span>
      </div>
      <div class="gt${finished ? ' done' : ''}">${esc(g.title)}</div>
      <div class="gs">${esc(sub)}${finished ? ' · 已通关' : ''}</div>
    </div>`;
    })
    .join(''),
  );
  hydrateArts(wrap);
  // 阶梯涟漪：强制重排后再挂 cascade，保证同一屏连续两次进入也能重播
  wrap.classList.remove('cascade');
  if (animate) {
    void wrap.offsetWidth;
    wrap.classList.add('cascade');
    window.setTimeout(() => wrap.classList.remove('cascade'), 1000);
  }
  wrap.querySelectorAll('.gcell').forEach((c) => {
    const cell = c as HTMLElement;
    const gi = Number(cell.dataset.g);
    cell.addEventListener('click', () => {
      const g = all[gi];
      if (state.gridMulti && g) {
        // 多选态：点卡片就是勾选，不再移动焦点（与游戏手柄的 A 键同义）
        toggleSel(g.id);
        return;
      }
      state.gridFocus = Number(cell.dataset.i);
      applyGridFocus();
    });
    cell.addEventListener('dblclick', () => {
      if (state.gridMulti) return;
      // 重绘后旧的 gcell 仍可能带着老 data-g（越界 → undefined）：别让双击抛异常
      const g = all[gi];
      if (g) openDetail(g.id);
    });
  });
  applyGridFocus();
  syncMultiUI();
  syncFilterChip(); // 分面筛选角标（筛选按钮上的生效个数）
  /* 筛选/搜索无结果：在网格视图内弹出「无结果」空态（库本身为空时交给空库态）。
     筛选面板开着时不弹——否则 showState 会把面板一起关掉，选到 0 结果就"闪一下消失" */
  if (!list.length) {
    if (state.screen === 'grid' && !searchShown() && !filterShown() && !state.empty) showEmpty('noresult');
  } else {
    hideEmpty();
  }
}

/* ============ 多选：勾选 / 批量操作（与三套布局共用 multi.ts） ============ */

function syncMultiUI(): void {
  document.getElementById('selBtn')?.classList.toggle('on', state.gridMulti);
  // 操作条停靠在键位栏位置：多选态让键位提示让位，否则会压住最后一排作品标题
  document.getElementById('app')?.classList.toggle('multi', state.gridMulti);
  // 网格与库屏各有一条操作条，多选态下同时可见只看当前屏那条
  for (const id of ['gselBar', 'lselBar']) {
    const bar = document.getElementById(id);
    if (bar) bar.hidden = !state.gridMulti;
  }
  markSel();
}

/** chips 统一入口：切筛选 + 焦点归位 + 重建（点 chip 与空态「清除筛选」共用） */
export function setFilter(f: GridFilter): void {
  state.gridFilter = f;
  // 手改状态筛选后，之前套用的保存视图就不再成立（筛选芯片也不再对应那个视图）
  state.viewName = null;
  document.querySelectorAll('#fchips .fchip').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.filter === f));
  state.gridFocus = 0;
  buildGrid();
}

/** LB / RB 肩键：在右上角状态 chips 之间左右切换（环绕）。
 *  只循环带 data-filter 的分类项，「筛选」「多选」是动作按钮，不参与。 */
export function cycleFilter(dir: 1 | -1): void {
  const chips = [...document.querySelectorAll<HTMLElement>('#fchips .fchip[data-filter]')];
  if (chips.length < 2) return;
  const cur = chips.findIndex((c) => c.dataset.filter === state.gridFilter);
  const next = ((cur < 0 ? 0 : cur) + dir + chips.length) % chips.length;
  const el = chips[next];
  if (!el) return;
  setFilter(el.dataset.filter as GridFilter);
}

/** 焦点夹紧（mockup clampGrid 同款）：避免落到空行空列。
 *  纯函数便于单测：cols 列、total 项，最后一行不满时回落到最后一项。 */
export function clampCell(r: number, c: number, cols: number, total: number): [number, number] {
  if (!total) return [0, 0];
  const rows = Math.ceil(total / cols);
  r = Math.max(0, Math.min(rows - 1, r));
  c = Math.max(0, Math.min(cols - 1, c));
  if (r * cols + c >= total) {
    const last = total - 1;
    r = Math.floor(last / cols);
    c = last % cols;
  }
  return [r, c];
}

function clampGrid(r: number, c: number): [number, number] {
  return clampCell(r, c, GRID_COLS, gridList().length);
}

function applyGridFocus(): void {
  const [r, c] = clampGrid(Math.floor(state.gridFocus / GRID_COLS), state.gridFocus % GRID_COLS);
  state.gridFocus = r * GRID_COLS + c;
  const sel = state.gridFocus;
  document.querySelectorAll('#gridCards .gcell').forEach((el) => {
    el.querySelector('.card')?.classList.toggle('focus', Number((el as HTMLElement).dataset.i) === sel);
  });
  // 超过 10 部时 .gwrap 可滚动：焦点必须跟到可视区内，否则第三行起「按键有效但看不见」
  document
    .querySelector<HTMLElement>(`#gridCards .gcell[data-i="${sel}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

export function renderGrid(): void {
  const entering = state.screen === 'grid' && lastGridScreen !== 'grid';
  lastGridScreen = state.screen;
  // 不在网格屏：只标脏。千部作品的网格约 8000 个节点，启动时白建一次要几十毫秒，
  // 而用户可能整场都不打开网格；切进网格时由 screen-change 补建。
  if (state.screen !== 'grid') {
    gridDirty = true;
    return;
  }
  gridDirty = false;
  buildGrid(entering);
}

export function initGrid(): void {
  // 数据在别的屏变过（收藏 / 筛选 / 缩略图回填）时，切进网格先补建一次
  window.addEventListener('screen-change', () => {
    if (state.screen === 'grid' && gridDirty) renderGrid();
  });
  // 键鼠补位：Home/End 跳首尾，PageUp/PageDown 翻两行，R 随机一部（网格 6 列）
  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'grid' || anyState()) return;
    if (e.code === 'KeyR') {
      // 与库屏 / 手柄 L3 / 快捷菜单共用同一条实现
      void import('../quick').then((m) => m.pickRandomGame());
      e.preventDefault();
      return;
    }
    const total = gridList().length;
    if (!total) return;
    if (e.code === 'Home') state.gridFocus = 0;
    else if (e.code === 'End') state.gridFocus = total - 1;
    else if (e.code === 'PageUp') state.gridFocus = Math.max(0, state.gridFocus - GRID_COLS * 2);
    else if (e.code === 'PageDown') state.gridFocus = Math.min(total - 1, state.gridFocus + GRID_COLS * 2);
    else return;
    applyGridFocus();
    e.preventDefault();
  });
  registerHandler('grid', (n: NavIntent) => {
    const list = gridList();
    if (n.intent === 'back') {
      // 多选态下 B 先退出多选，第二次才回轨道（避免误触丢选中）
      if (state.gridMulti) {
        setMulti(false);
        return;
      }
      setScreen('library');
      return;
    }
    if (n.intent === 'accept') {
      const g = list[state.gridFocus];
      if (!g) return;
      if (state.gridMulti) {
        toggleSel(g.id);
        return;
      }
      // 焦点卡先缩一下再切屏（mockup 同款 110ms），否则按压动画会被切屏盖掉
      const cell = document.querySelector<HTMLElement>(`#gridCards .gcell[data-i="${state.gridFocus}"] .card`);
      pressCard(cell);
      const idx = state.gridFocus;
      window.setTimeout(() => {
        // 这 110ms 里用户可能已经切屏或换了焦点（连按 A / 按 A 后立刻 B）：
        // 回调必须校验仍是「同一屏的同一项」，否则会把人从别的界面强行拉进详情
        if (state.screen !== 'grid' || state.gridFocus !== idx) return;
        openDetail(g.id);
      }, 110);
      return;
    }
    if (n.intent !== 'move' || !list.length) return;
    const r = Math.floor(state.gridFocus / GRID_COLS);
    const c = state.gridFocus % GRID_COLS;
    let [nr, nc] = [r, c];
    if (n.dir === 'left' && c > 0) nc = c - 1;
    if (n.dir === 'right' && c < GRID_COLS - 1) nc = c + 1;
    if (n.dir === 'up' && r > 0) nr = r - 1;
    if (n.dir === 'down') nr = r + 1;
    const [cr, cc] = clampGrid(nr, nc);
    state.gridFocus = cr * GRID_COLS + cc;
    applyGridFocus();
  });

  // 筛选 chips（mockup FILTERS 语义，含 ★收藏）
  // 只绑真正的状态 chip：`#fBtn`（「筛选」按钮）也带 .fchip 但没有 data-filter，
  // 不跳过会把用户选好的状态悄悄重置成「全部」
  document.querySelectorAll('#fchips .fchip').forEach((el) => {
    const f = (el as HTMLElement).dataset.filter;
    if (!f) return;
    el.addEventListener('click', () => setFilter(f as GridFilter));
  });

  // 多选 chip + 底部操作条
  document.getElementById('selBtn')?.addEventListener('click', () => setMulti(!state.gridMulti));
  document.getElementById('selExit')?.addEventListener('click', () => setMulti(false));
  document.getElementById('selAct')?.addEventListener('click', () => {
    void openBatch();
  });

  // 多选态变化（含库屏 / 批量完成）：只同步操作条与勾选标记。
  // 旧实现整块重建网格——进 / 出多选时把上千张卡全部重新插入并重新解码封面，
  // 还会把滚动位置与焦点环一起冲掉；勾选态本来就能靠 .sel 类原地切换。
  window.addEventListener('multi-change', () => {
    syncMultiUI();
  });

  // M 多选 / X 批量操作（keybar 声明过，实机补接）；Esc 退出多选
  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'grid' || anyState()) return;
    if (e.code === 'KeyM') {
      setMulti(!state.gridMulti);
      e.preventDefault();
    } else if (e.code === 'KeyX' && state.gridMulti) {
      void openBatch();
      e.preventDefault();
    } else if (e.code === 'KeyX') {
      // 手柄 X 不再进多选：多选入口是 Select，X 专注批量 / 主操作（键盘 X 老习惯保留）
      if (isPadNavEvent(e)) {
        toast('多选请按 Select');
        e.preventDefault();
        return;
      }
      setMulti(true);
      e.preventDefault();
    } else if (e.code === 'Escape' && state.gridMulti) {
      setMulti(false);
      // 必须截断本轮传播：nav 的 keydown（initNav 注册更晚）还会把同一个 Escape
      // 当 back 再分发一次，而那时 gridMulti 已是 false，会顺带退回库屏
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  });

  // 库变化后保持网格刷新（renderRail 内已调用 renderGrid，此处兜底空态）
  updateEmpty();
}

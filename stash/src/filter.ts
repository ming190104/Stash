/** 筛选面板（P1 + P10）：集合 / 标签 / 会社 / 发售年四列分面 + 保存视图。
 *  面板保持打开时连续调整；关闭那一刻才重建网格，避免空态在选到 0 结果时闪一下。 */

import type { Game, SavedView } from './types';
import {
  state,
  visibleGames,
  facetCount,
  collectionCtx,
  clearFacets,
  COLLECTIONS,
  collectionMatch,
  isFinished,
  type CollectionCtx,
  type GridFilter,
  type CollectionId,
} from './state';
import { esc, toast, clickable } from './ui';
import { setRawHTML } from './html';
import { persist } from './screens/settings/persist';
import { promptInput } from './prompt';
import { hideStates, showState, NATIVE_DEFAULT } from './layers';

type FacetCol = 'set' | 'tag' | 'dev' | 'year';
const COLS: FacetCol[] = ['set', 'tag', 'dev', 'year'];
const COL_TITLE: Record<FacetCol, string> = { set: '快捷分类', tag: '标签', dev: '会社', year: '发售年' };

interface Opt {
  v: string | number | null;
  label: string;
  count: number;
}

/** 面板焦点：列 + 每列的行索引 */
let fcol = 0;
const frow = [0, 0, 0, 0];

/** 状态筛选（与 gridList 同语义）：分面计数要先过这一层，否则数字没有意义 */
function statusMatch(g: Game, f: string = state.gridFilter): boolean {
  return f === 'all'
    ? true
    : f === 'playing'
      ? !!g.lastPlayed && !isFinished(g)
      : f === 'done'
        ? isFinished(g)
        : f === 'fav'
          ? g.favorite
          : !g.lastPlayed;
}

/** 标签 / 会社 / 年份这一层（不含集合）；计数时排除本列自身条件 */
function facetMatch(g: Game, skip: FacetCol | null): boolean {
  if (skip !== 'tag' && state.tagFilter && !g.tags.includes(state.tagFilter) && !(g.userTags ?? []).includes(state.tagFilter)) return false;
  if (skip !== 'dev' && state.devFilter && g.developer !== state.devFilter) return false;
  if (skip !== 'year' && state.yearFilter !== null && g.year !== state.yearFilter) return false;
  return true;
}

/** 保存视图里的条件是否命中（视图自带筛选，不依赖当前面板状态） */
function viewMatch(g: Game, v: SavedView, ctx: CollectionCtx): boolean {
  if (!statusMatch(g, v.filter)) return false;
  if (v.tag && !g.tags.includes(v.tag) && !(g.userTags ?? []).includes(v.tag)) return false;
  if (v.dev && g.developer !== v.dev) return false;
  if (v.year !== null && g.year !== v.year) return false;
  return collectionMatch(g, (v.collection as CollectionId | null) ?? null, ctx);
}

function currentOf(col: FacetCol): string | number | null {
  if (col === 'set') return state.viewName ? `view:${state.viewName}` : state.collection ? `smart:${state.collection}` : null;
  return col === 'tag' ? state.tagFilter : col === 'dev' ? state.devFilter : state.yearFilter;
}

/** 套用保存视图：状态 / 分面 / 集合 / 排序一次到位 */
function applyView(name: string): void {
  const v = (state.settings?.views ?? []).find((x) => x.name === name);
  if (!v) return;
  state.gridFilter = (v.filter || 'all') as GridFilter;
  state.tagFilter = v.tag ?? null;
  state.devFilter = v.dev ?? null;
  state.yearFilter = v.year ?? null;
  state.collection = (v.collection as CollectionId | null) ?? null;
  state.sortBy = (v.sort || 'lastPlayed') as typeof state.sortBy;
  state.viewName = name;
  document.querySelectorAll('#fchips .fchip').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.filter === state.gridFilter));
}

function choose(col: FacetCol, v: string | number | null): void {
  if (col === 'set') {
    if (v === null) {
      state.collection = null;
      state.viewName = null;
      return;
    }
    const s = String(v);
    if (s.startsWith('smart:')) {
      state.collection = s.slice(6) as CollectionId;
      state.viewName = null;
    } else if (s.startsWith('view:')) {
      applyView(s.slice(5));
    }
    return;
  }
  // 手改任一常规分面：之前套用的保存视图即失效
  state.viewName = null;
  if (col === 'tag') state.tagFilter = v as string | null;
  else if (col === 'dev') state.devFilter = v as string | null;
  else state.yearFilter = v as number | null;
}

/** 某列可选项：计数时排除本列自身条件（分面计数的通行做法，选中项不会自己把自己算成 0）。
 *  计数只要集合不要顺序，所以走 visibleGames 而不是 sortedGames：
 *  面板每动一步要算四列，重排全库在这儿纯属浪费。 */
function options(col: FacetCol): Opt[] {
  const all = visibleGames();
  const ctx = collectionCtx();
  if (col === 'set') {
    // 集合列：本列不参与「排除自身」——每个集合都要看全量池子里的命中数
    const pool = all.filter((g) => statusMatch(g) && facetMatch(g, null));
    const list: Opt[] = [{ v: null, label: '全部', count: pool.length }];
    for (const c of COLLECTIONS) {
      list.push({ v: `smart:${c.v}`, label: c.label, count: pool.filter((g) => collectionMatch(g, c.v, ctx)).length });
    }
    for (const v of state.settings?.views ?? []) {
      list.push({ v: `view:${v.name}`, label: `视图 · ${v.name}`, count: pool.filter((g) => viewMatch(g, v, ctx)).length });
    }
    return list;
  }
  const pool = all.filter((g) => {
    if (!statusMatch(g)) return false;
    if (state.collection && !collectionMatch(g, state.collection, ctx)) return false;
    return facetMatch(g, col);
  });
  const n = new Map<string | number, number>();
  for (const g of pool) {
    if (col === 'tag') for (const t of [...g.tags, ...(g.userTags ?? [])]) n.set(t, (n.get(t) ?? 0) + 1);
    if (col === 'dev' && g.developer) n.set(g.developer, (n.get(g.developer) ?? 0) + 1);
    if (col === 'year' && g.year) n.set(g.year, (n.get(g.year) ?? 0) + 1);
  }
  const list = [...n.entries()]
    .sort((a, b) =>
      col === 'year' ? Number(b[0]) - Number(a[0]) : b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh'),
    )
    .map(([v, count]) => ({ v, label: col === 'year' ? `${v} 年` : String(v), count }));
  // 「全部」= 不设本列条件，数量取当前池子
  return [{ v: null, label: '全部', count: pool.length }, ...list];
}

/** 筛选按钮角标：未启用显示「筛选」，启用后显示个数并高亮 */
export function syncFilterChip(): void {
  const b = document.getElementById('fBtn');
  if (!b) return;
  const n = facetCount();
  b.textContent = n ? `筛选 · ${n}` : '筛选';
  b.classList.toggle('on', n > 0);
}

export function renderFilter(): void {
  const box = document.getElementById('fltCols');
  if (!box) return;
  setRawHTML(
    box,
    COLS.map((col, ci) => {
    const opts = options(col);
    const sel = currentOf(col);
    frow[ci] = Math.min(Math.max(0, frow[ci]), opts.length - 1);
    return `<div class="flt-col${ci === fcol ? ' on' : ''}">
      <div class="flt-lab">${COL_TITLE[col]}<b>${opts.length - 1}</b></div>
      ${col === 'set' ? '<div class="flt-note">短篇按参考时长（≤10h）统计，与「短篇」标签口径不同；0 项分类已置灰</div>' : ''}
      <div class="flt-opts" data-col="${ci}">${opts
        .map(
          (o, i) => `<div class="flt-opt${o.v === sel ? ' on' : ''}${ci === fcol && i === frow[ci] ? ' focus' : ''}${o.count === 0 && o.v !== null && o.v !== sel ? ' zero' : ''}" data-i="${i}"${o.count === 0 && o.v !== null && o.v !== sel ? ' data-zero="1"' : ''}>
          <span class="flt-nm">${esc(o.label)}</span><span class="flt-ct">${o.count}</span>
        </div>`,
        )
        .join('')}</div>
    </div>`;
    }).join(''),
  );
  box.querySelectorAll<HTMLElement>('.flt-opt').forEach((el) => {
    clickable(el);
    el.addEventListener('click', () => {
      const ci = Number((el.parentElement as HTMLElement).dataset.col);
      fcol = ci;
      frow[ci] = Number(el.dataset.i);
      if (el.dataset.zero) {
        toast('该条件当前没有作品');
        renderFilter();
        return;
      }
      pickFilter();
    });
  });
  box.querySelector<HTMLElement>('.flt-opt.focus')?.scrollIntoView({ block: 'nearest' });
  syncFilterChip();
}

export function openFilter(): void {
  fcol = 0;
  COLS.forEach((col, i) => {
    const opts = options(col);
    const k = opts.findIndex((o) => o.v === currentOf(col));
    frow[i] = k < 0 ? 0 : k;
  });
  showState('filterPanel');
  renderFilter();
}

function moveFilter(dir: 'up' | 'down' | 'left' | 'right'): void {
  if (dir === 'left' || dir === 'right') {
    fcol = (fcol + (dir === 'right' ? 1 : COLS.length - 1)) % COLS.length;
    frow[fcol] = Math.min(frow[fcol], options(COLS[fcol]).length - 1);
  } else {
    const n = options(COLS[fcol]).length;
    if (!n) return;
    frow[fcol] = (frow[fcol] + (dir === 'down' ? 1 : n - 1)) % n;
  }
  renderFilter();
}

/** 应用光标所在项：立刻重建网格（面板保持打开，方便接着调下一列） */
function pickFilter(): void {
  const col = COLS[fcol];
  const o = options(col)[frow[fcol]];
  if (!o) return;
  if (o.count === 0 && o.v !== null) {
    toast('该条件当前没有作品');
    return;
  }
  choose(col, o.v);
  state.gridFocus = 0;
  toast(`${COL_TITLE[col]} · ${o.v === null ? '全部' : esc(o.label)}`);
  // 视图可能带排序：库屏（经典轨道 / 列表 / 海报墙）必须一起重建，否则 A 键启动的是旧排序里的那部
  void import('./screens/library').then((m) => m.renderRail());
  void import('./screens/grid').then((m) => m.renderGrid());
  renderFilter();
}

/** 关闭筛选面板：顺手重建网格——面板开着时不弹空态，关掉这一刻才该弹 */
function closeFilter(): void {
  hideStates();
  void import('./screens/grid').then((m) => m.renderGrid());
}

/** 清空全部筛选：状态 / 分面 / 快捷分类 / 保存视图一次归零，面板保持打开 */
export function clearAllFilters(): void {
  clearFacets();
  state.viewName = null;
  state.gridFilter = 'all';
  state.gridFocus = 0;
  document.querySelectorAll('#fchips .fchip').forEach((x) => {
    const f = (x as HTMLElement).dataset.filter;
    if (f) x.classList.toggle('on', f === 'all');
  });
  renderFilter();
  void import('./screens/library').then((m) => m.renderRail());
  void import('./screens/grid').then((m) => m.setFilter('all'));
  toast('已清空全部筛选');
}

/** 把当前「状态筛选 + 分面 + 快捷分类 + 排序」存成命名视图（最多 8 个，随设置落盘）。
 *  输入弹层要盖在筛选面板之上，所以先收面板、填完再打开，避免弹层被压在下面。 */
export async function saveCurrentView(): Promise<void> {
  const s = state.settings;
  if (!s) return;
  hideStates();
  const raw = await promptInput({
    title: '保存筛选视图',
    sub: '保存当前快捷分类 / 分面 / 排序；之后在「筛选 · 快捷分类」一键回到这里（最多 8 个）',
    value: '',
    cap: 24,
  });
  if (raw === null) {
    openFilter();
    return;
  }
  const name = raw.trim();
  if (!name) {
    toast('名称不能为空', true);
    openFilter();
    return;
  }
  if ((s.views ?? []).some((v) => v.name === name)) {
    toast('已有同名视图，换个名字', true);
    openFilter();
    return;
  }
  const v: SavedView = {
    name,
    filter: state.gridFilter,
    tag: state.tagFilter,
    dev: state.devFilter,
    year: state.yearFilter,
    collection: state.collection,
    sort: state.sortBy,
  };
  const next = [...(s.views ?? []), v];
  if (next.length > 8) {
    toast('最多保存 8 个视图，先删掉一个再存', true);
    openFilter();
    return;
  }
  try {
    // 走设置落盘的同一条队列：直接 updateSettings 会和设置页里排队的写入互相覆盖
    // （两边的快照都是整份设置，后到的旧快照会把刚存好的视图冲掉）
    s.views = next;
    await persist();
    state.viewName = name;
    toast(`已保存视图 · ${esc(name)}`);
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
  openFilter();
}

/** 筛选面板的按键（调用前已确认面板打开） */
export function filterKey(e: KeyboardEvent): boolean {
  if (e.code === 'Escape' || e.code === 'KeyB' || e.code === 'Backspace') {
    closeFilter();
    e.preventDefault();
    return true;
  }
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    moveFilter(e.code.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right');
    e.preventDefault();
    return true;
  }
  if (e.code === 'KeyS') {
    void saveCurrentView();
    e.preventDefault();
    return true;
  }
  if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
    pickFilter();
    e.preventDefault();
    return true;
  }
  if (NATIVE_DEFAULT.has(e.code)) e.preventDefault();
  return true;
}

/** 游戏库主屏：封面轨道 / 列表 / 海报墙三种布局 + 焦点 / 启动 / 详情入口。
 *  Hero 在 `hero.ts`、详情背景在 `detail-bg.ts`、封面结构在 `art.ts`，这里只做编排。
 *  焦点锥三级梯度（focus/n1/n2）+ 居中滚动首尾夹紧 + 行级错落入场。 */

import type { Game, NavIntent, Screen } from '../types';
import { asset, launchGame, stopGame, onEvent, setFavorite, getSettings, getLibrary, runningGame } from '../ipc';
import { placeholderArt } from '../art';
import { state, sortedGames, setScreen, lastPlayedId, gameById, gridList, versionCounts, markLocalEdit, clearLocalEdit, localEditOf, mergeLocalEdits } from '../state';
import { clearHTML, setRawHTML } from '../html';
import { registerHandler, isPadNavEvent } from '../nav';
import { markSel, toggleSel, setMulti, openBatch, setMultiRefresh } from '../multi';
import { toast, esc, press, pressCard, applyFullscreenUI } from '../ui';
import { anyState, showEmpty, hideEmpty, emptyShown } from '../overlay';
import { refreshPadHints } from '../keybar';
import { sfx } from '../sfx';
import { artHTML, hydrateArts } from './art';
import { buildCard, buildSlot, initCard } from './card';
import { isDetailBgReady, prepareDetailBg, resetDetailArt, showDetailArtFor } from './detail-bg';
import { initHero, scheduleHero } from './hero';
import { layoutMode } from './layout-mode';
import { applyListFocus, renderList } from './list';
import { WALL_COLS, applyWallFocus, renderWall } from './wall';
import { bindLibraryApi } from '../library-bridge';

// 对外稳定出口：其它模块 / 测试仍可从 library 取这些符号
export { artHTML, hydrateArts } from './art';
export { forgetDetailBg, paintDetailArt, prepareDetailBg, showDetailArtFor } from './detail-bg';
export { layoutMode } from './layout-mode';
export { wallPos } from './wall';

const CARD_W = 170;
const STEP = 184;
const HALF = 85;
/** 手柄回书架手势只提示一次：它是游戏卡死时唯一的纯手柄出口 */
const PAD_HOME_HINT = 'stash.padHomeHint';
const RAIL_PAD = 32;
/** 舞台逻辑宽度：fitStage 会按窗口比例把它撑到 1280 以上（16:9 时正好 1280），
 *  轨道居中与首尾夹紧必须跟着走，否则宽窗口里焦点卡会偏到左边 */
function stageW(): number {
  return document.getElementById('app')?.offsetWidth || 1280;
}

/** 首屏「继续上次」只生效一次：之后焦点由用户接管，刷新不应把用户拽回去 */
let resumeFocusDone = false;
/** 触摸滑动结束后短暂吞掉浏览器补发的 click（否则松手位置的卡片会抢走焦点） */
let suppressClickUntil = 0;

/* ============ 封面预热（B9） ============ */
/** 已预热过的封面路径：避免每次拨动都重复建 Image 抢带宽 */
const warmed = new Set<string>();

/** 焦点两侧各 3 张提前解码：拨动轨道时不会先看到深色底再淡入。
 *  调用方在同一帧已排过序时把结果传进来，省掉一次全库排序。 */
function warmAhead(center: number, list: Game[] = sortedGames()): void {
  // 路径换了新封面后旧键会一直占位；到上限整体重置，避免长期运行只增不减
  if (warmed.size > 512) warmed.clear();
  for (let d = -3; d <= 3; d++) {
    const g = list[center + d];
    if (!g) continue;
    const p = g.thumb || g.cover;
    if (!p || warmed.has(p)) continue;
    warmed.add(p);
    asset(p)
      .then((u) => {
        const im = new Image();
        im.src = u;
      })
      .catch(() => {
        /* 预热失败不打扰用户：真正显示时还会再试一次 */
      });
  }
}

/* ============ 轨道 ============ */
function railX(i: number, n: number): number {
  const viewW = stageW();
  const total = n * CARD_W + (n - 1) * 14;
  const raw = viewW / 2 - HALF - STEP * i;
  // 轨道总宽不足一屏时，min 恒小于 max 会把 `Math.min` 架空（整条钉在右侧）；
  // 先把下界夹到不超过上界，小库也能让焦点卡居中
  const maxX = RAIL_PAD;
  const minX = Math.min(maxX, viewW - RAIL_PAD - total);
  return Math.max(minX, Math.min(maxX, raw));
}

/* ============ 大库窗口化 ============ */
/** 焦点前后各建多少张完整卡；远处用等尺寸空卡占位（visibility:hidden）。
 *  1000 部时完整卡从 1000 降到 121：封面解码、事件监听、innerHTML 全部跟着降；
 *  占位仍占 170×226 + 14px 间距，轨道夹紧与 184px 步长完全不变。 */
const WIN = 60;
/** 焦点偏离已建窗口中心超过这个值才同步一批，避免每次按键都换 DOM */
const WIN_STEP = 30;
/** 最近一次建满卡片时的焦点（窗口中心） */
let railCenter = -1;

/** 窗口范围 [start, end]（含焦点本身，越界夹紧）。导出便于单测边界。 */
export function railWindow(focus: number, total: number): [number, number] {
  if (total <= 0) return [0, -1];
  return [Math.max(0, focus - WIN), Math.min(total - 1, focus + WIN)];
}

/** 焦点移动后只替换「进出窗口」的卡片：窗口内已建好的可见卡原样保留，
 *  不会因为换窗口而重新解码封面（整轨重建会在快速拨动时闪一下）。 */
function syncRailWindow(list: Game[], lastId: string | null): void {
  const track = document.getElementById('railTrack');
  if (!track) return;
  const [start, end] = railWindow(state.focus, list.length);
  // 进窗口的卡可能有好几张：版本计数只建一次，别在逐卡里扫全库
  const versions = versionCounts();
  track.querySelectorAll<HTMLElement>(':scope > .card').forEach((el) => {
    const i = Number(el.dataset.i);
    const full = i >= start && i <= end;
    const isSlot = el.classList.contains('slot');
    if (full === !isSlot) return;
    const g = list[i];
    el.replaceWith(full && g ? buildCard(g, i, lastId, versions) : buildSlot(i));
  });
  hydrateArts(track);
  railCenter = state.focus;
}

/** 重建库屏（库/排序变化后）：按当前布局皮肤渲染轨道 / 列表 / 海报墙 */
export function renderRail(): void {
  const list = sortedGames();
  const lastId = lastPlayedId();
  if (!resumeFocusDone && list.length) {
    resumeFocusDone = true;
    const i = lastId ? list.findIndex((g) => g.id === lastId) : -1;
    if (i > 0) state.focus = i; // P4：首屏落在「继续上次」而不是第一张
  }
  const mode = layoutMode();
  const animateBase = state.screen === 'library';
  if (mode === 'list') {
    renderList(list, animateBase);
    if (state.gridMulti) markSel();
    warmAhead(state.focus);
    updateCount();
    updateEmpty();
    return;
  }
  if (mode === 'wall') {
    renderWall(list, lastId, animateBase);
    if (state.gridMulti) markSel();
    warmAhead(state.focus);
    updateCount();
    updateEmpty();
    return;
  }
  const track = document.getElementById('railTrack');
  if (!track) return;
  // 布局互斥：清掉另一侧容器，避免两套卡片 DOM 同时驻留（大库时翻倍占内存）
  document.getElementById('wallGrid')?.replaceChildren();
  document.getElementById('listRows')?.replaceChildren();
  document.getElementById('listPreview')?.replaceChildren();
  clearHTML(track);
  state.focus = Math.min(state.focus, Math.max(0, list.length - 1));
  const [start, end] = railWindow(state.focus, list.length);
  const versions = versionCounts();
  list.forEach((g, i) =>
    track.appendChild(i >= start && i <= end ? buildCard(g, i, lastId, versions) : buildSlot(i)),
  );
  railCenter = state.focus;
  hydrateArts(track);
  applyFocusCone();
  warmAhead(state.focus);
  scheduleHero();
  updateCount();
  updateEmpty();
  if (state.gridMulti) markSel();
}

/* ============ 布局皮肤（P12）：list 列表 + 大图 / wall 海报墙，与主题正交 ============ */
/** 入场动效判定：只有「容器原本为空 + 当前在库屏 + 有内容」才播放入场。
 *  库内重绘（收藏 / 排序 / 缩略图回填）容器已有子元素，不得重播。 */
export function isFreshEnter(prevCount: number, screen: Screen, listLength: number): boolean {
  return prevCount === 0 && screen === 'library' && listLength > 0;
}

/** 焦点锥：list 由调用方传入时复用同一帧已算好的排序结果（每次 sortedGames 都是全库排序） */
function applyFocusCone(list: Game[] = sortedGames()): void {
  const mode = layoutMode();
  if (mode === 'wall') {
    applyWallFocus();
    return;
  }
  if (mode === 'list') {
    applyListFocus(true); // 键盘 / 手柄移动必须把焦点行滚进视口（列表约 6.3 行可见）
    return;
  }
  const n = list.length;
  const track = document.getElementById('railTrack');
  if (!track) return;
  if (n > 0) track.style.transform = `translateX(${railX(state.focus, n)}px)`;
  track.querySelectorAll('.card').forEach((c) => {
    const d = Math.abs(Number((c as HTMLElement).dataset.i) - state.focus);
    c.classList.toggle('focus', d === 0);
    c.classList.toggle('n1', d === 1);
    c.classList.toggle('n2', d === 2);
  });
}

export function setFocus(i: number, skipHero = false): void {
  // 同一帧只排一次全库：窗口同步 / 焦点锥 / 封面预热共用这份列表
  const list = sortedGames();
  const n = list.length;
  if (n === 0) return;
  state.focus = Math.max(0, Math.min(n - 1, i));
  // 经典轨道：焦点离开已建窗口中心一段距离后，只替换进出窗口的卡片。
  // 窗口内已建好的卡原样保留，不会因为整轨重建而重新解码封面。
  if (layoutMode() === 'classic' && Math.abs(state.focus - railCenter) > WIN_STEP) {
    syncRailWindow(list, lastPlayedId());
  }
  applyFocusCone(list);
  warmAhead(state.focus, list);
  if (!skipHero) scheduleHero();
}

/* ============ 启动 ============ */
export async function doLaunch(): Promise<void> {
  const g = sortedGames()[state.focus];
  if (!g || state.running) return;
  try {
    await launchGame(g.id);
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

async function showLaunchLayer(g: Game): Promise<void> {
  const layer = document.getElementById('launchLayer')!;
  const artBox = document.getElementById('llArt')!;
  if (g.thumb || g.cover) {
    artBox.style.background = '';
    setRawHTML(artBox, artHTML(g));
    hydrateArts(artBox);
  } else {
    clearHTML(artBox);
    artBox.style.background = placeholderArt(g.id).bg;
  }
  document.getElementById('llTitle')!.textContent = g.title;
  document.getElementById('llStatus')!.textContent = '正在启动…';
  layer.classList.add('on');
  if ((g.localeOverride ?? g.needsLocale) && (state.settings?.locale.warnOnly ?? true)) {
    toast('检测到 Shift-JIS 引擎：如启动异常，建议用转区工具运行');
  }
  // 首次用手柄启动游戏时提示唯一的手柄出口：游戏卡死 / 全屏时没有别的办法叫回窗口
  if (state.padInfo.name && localStorage.getItem(PAD_HOME_HINT) !== '1') {
    localStorage.setItem(PAD_HOME_HINT, '1');
    toast('手柄：长按 Start+Select 1.2 秒可结束游戏并回书架');
  }
}

function hideLaunchLayer(): void {
  document.getElementById('launchLayer')?.classList.remove('on');
}

/* ============ 收藏切换（轨道卡 / 网格卡 / 详情三处视图同步） ============ */
/** 收藏标记变化后刷新受影响的三处视图 */
function refreshFavViews(id: string): void {
  renderRail();
  void import('./grid').then((m) => m.renderGrid());
  void import('./detail').then((m) => {
    if (state.detailId === id) void m.renderDetail();
  });
}

/** 进行中的收藏写入：刷新拿到的是写盘前的旧快照时，赋值前用这里的最新意图覆盖 */
export function toggleFav(id: string): void {
  const g = gameById(id);
  if (!g) return;
  // 快照本次意图：失败时按快照回滚，而不是「取反当前值」——
  // 等待写盘期间用户又点了一次的话，取反会把第二次操作也一起抹掉
  const before = g.favorite;
  const next = !before;
  g.favorite = next;
  markLocalEdit(id, { favorite: next });
  toast(next ? '已加入收藏 ★' : '已取消收藏');
  refreshFavViews(id);
  // 落盘：写失败则回滚内存标志并提示，避免「界面显示已收藏、重启后没了」
  setFavorite(id, next).catch((e) => {
    // 等待写盘期间用户又点了一次时，意图已被换成下一次的值：不能连它一起清掉，
    // 否则下一次刷新拿到旧快照会把第二次操作冲回
    if (localEditOf(id, 'favorite') === next) clearLocalEdit(id, ['favorite']);
    // 用当前对象而非闭包里的 g：后台刷新可能已经把 state.games 换成了新数组
    const cur = gameById(id);
    if (cur && cur.favorite === next) cur.favorite = before;
    toast(`收藏保存失败：${esc(String((e as { message?: string })?.message ?? e))}`, true);
    refreshFavViews(id);
  });
}

/* ============ 空态 / 计数 ============ */
export function updateEmpty(): void {
  // 空态只属于库 / 网格两屏：库被清空时用户可能正在设置页，
  // 整屏空态（z-index 70）会把设置页盖住，还会顺手关掉面板。
  const cur = state.screen;
  if (state.empty && (cur === 'library' || cur === 'grid')) showEmpty('empty');
  else if (emptyShown()) hideEmpty();
}

export function updateCount(): void {
  const t = `${state.games.length} 部作品`;
  const a = document.getElementById('gameCount');
  const b = document.getElementById('gameCount2');
  const w = document.getElementById('wallCount');
  if (a) a.textContent = t;
  if (b) b.textContent = t;
  if (w) w.textContent = t;
}

/** 刷新请求序号：并发刷新时旧快照后到不得覆盖新快照（批量导入 / 缩略图回填会撞车） */
let refreshSeq = 0;
/** 防抖定时器 id（0 = 空闲） */
let refreshTimer = 0;

/** 防抖刷新入口：后台缩略图连续完成时合并成一次全库 IPC + 重绘。
 *  失败只打日志（调用方是后台事件，没有可交互的上下文）。 */
export function scheduleLibraryRefresh(delay = 300): void {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    void refreshLibrary().catch((e) => console.warn('[thumbs] 刷新库失败', e));
  }, delay);
}

/** 只换一张作品的封面：轨道 / 网格 / 列表 / 海报墙里的 .art 子树原地替换。
 *  缩略图批次回填走这里，不必整屏重建（大库重建 = 上千张卡重新解码封面）。 */
function refreshArt(g: Game): void {
  const nodes = [...document.querySelectorAll<HTMLElement>(`[data-id="${g.id}"] .art`)];
  if (!nodes.length) return;
  const box = document.createElement('div');
  setRawHTML(box, artHTML(g));
  const art = box.firstElementChild as HTMLElement | null;
  if (!art) return;
  for (const old of nodes) {
    const next = art.cloneNode(true) as HTMLElement;
    old.replaceWith(next);
    hydrateArts(next.parentElement ?? document);
  }
}

/** 结构快照：去掉缩略图 / 原封面路径，用于判断这批数据是不是「只补了封面」 */
function structureKey(g: Game): string {
  const copy = { ...g } as Record<string, unknown>;
  delete copy.thumb;
  delete copy.cover;
  return JSON.stringify(Object.keys(copy).sort().map((k) => [k, copy[k]]));
}

/** 仅封面路径变化时把新路径原地写回旧对象，返回需要换图的条目；
 *  结构有变返回 null，由调用方整屏重建。 */
function applyThumbPatch(games: Game[]): Game[] | null {
  const prev = state.games;
  if (!games.length || games.length !== prev.length) return null;
  const byId = new Map(prev.map((g) => [g.id, g]));
  const changed: Game[] = [];
  for (const next of games) {
    const old = byId.get(next.id);
    if (!old || structureKey(old) !== structureKey(next)) return null;
    if (old.thumb === next.thumb && old.cover === next.cover) continue;
    old.thumb = next.thumb;
    old.cover = next.cover;
    changed.push(old);
  }
  return changed;
}

/** 库数据整体刷新（启动 / 添加作品 / 游戏退出后） */
export async function refreshLibrary(): Promise<void> {
  const token = ++refreshSeq;
  let games: Game[];
  try {
    games = await getLibrary();
  } catch (e) {
    // 已被更新的刷新取代：这次失败不再打扰用户（避免连弹过期错误）
    if (token !== refreshSeq) return;
    // 统一提示后继续抛出，让 await 本函数的调用方知道刷新并未成功
    console.error('[library] refresh failed', e);
    toast(`刷新库失败：${esc(String((e as { message?: string })?.message ?? e))}`, true);
    throw e;
  }
  if (token !== refreshSeq) return; // 旧快照：不写 state、不重绘
  // 收藏 / 评分 / 结局等「内存先改、后台落盘」的字段：这次读取若是写盘前的快照，
  // 会把刚改的值冲回去。按字段意图合并，磁盘值已经一致的部分自动出清。
  mergeLocalEdits(games);
  // 后台缩略图回填只改封面路径：原地换图后直接返回，不重建卡片
  const patched = applyThumbPatch(games);
  if (patched) {
    if (patched.length) {
      for (const g of patched) refreshArt(g);
      // 大海报用当前焦点那部的封面：正好补到它才刷新，否则会白闪一次入场动画
      const focusId = sortedGames()[state.focus]?.id;
      if (state.screen === 'library' && patched.some((g) => g.id === focusId)) scheduleHero();
    }
    return;
  }
  state.games = games;
  // 刷新可能移除 / 隐藏已勾选的条目：先剔除失效 id。
  // 否则多选计数虚高，批量操作对着已不存在的条目调 IPC 直接报错并中断在半路。
  if (state.gridSel.size) {
    const alive = new Set(state.games.filter((g) => !g.hidden).map((g) => g.id));
    for (const id of [...state.gridSel]) if (!alive.has(id)) state.gridSel.delete(id);
    markSel();
  }
  renderRail();
  const { renderGrid } = await import('./grid');
  renderGrid();
  updateEmpty();
}

/* ============ 详情入口 ============ */
/** 详情入口序号：等待背景解码期间用户又点了别的作品时，旧的那次切屏作废 */
let openSeq = 0;

export function openDetail(id: string, fromSearch = false): void {
  const prev = state.detailId;
  state.detailId = id;
  // 记下来处：网格 / 设置 / 文件进详情后，B 回原屏而不是一律回轨道。
  // 已经在详情里切版本时不覆盖，避免把来处改写成 detail。
  if (state.screen !== 'detail') state.detailFrom = state.screen;
  state.detailFromSearch = fromSearch;
  const seq = ++openSeq;
  // 来处快照：背景解码要等最多 400ms，期间用户可能已经切屏 / 开了别的面板
  const from = state.screen;
  const enter = (): void => {
    if (seq !== openSeq) return;
    // 等待期间屏幕被切走 / 打开了状态层：这次进入作废，并把 detailId 还原，
    // 否则 B 会落到一个「没有背景也没有内容」的详情页上
    if (state.screen !== from || anyState()) {
      if (state.detailId === id) state.detailId = prev;
      // 静默作废会被当成「点了没反应」：明确告诉用户这次进入被取消
      toast('已取消进入详情');
      return;
    }
    const app = document.getElementById('app');
    if (prev !== id) {
      // 换作品：在切屏前就卸掉上一张背景，否则详情首帧还会带着上一部的不透明旧图
      resetDetailArt();
      // 这部还没解码完：先清掉整屏封面里的旧作品内容（不管预热有没有给出路径——
      // 预热没覆盖到时（从网格 / 数字键进来）kv 里仍是上一部，露一帧就是「旧封面残留」；
      // 真没有背景时 renderDetail 会用新封面重建这一层）
      if (!isDetailBgReady(id)) {
        const kv = document.getElementById('kvArt');
        if (kv) clearHTML(kv);
      }
      // 这一帧禁掉 450ms 淡入：背景在本帧内就会挂上，淡入等于先黑一下
      app?.classList.add('no-fade');
      requestAnimationFrame(() =>
        requestAnimationFrame(() => app?.classList.remove('no-fade')),
      );
    }
    // 切屏前把背景亮出来：换作品时是「铺新图 + 封面让位」，同一部作品再次进入时
    // 图还在层上（库屏上被 CSS 藏了），走同一条瞬时亮出，否则两层又各跑一次 450ms 过渡。
    showDetailArtFor(id);
    setScreen('detail');
    void import('./detail').then((m) => {
      if (seq !== openSeq) return;
      m.markDetailEnter();
      void m.renderDetail();
    });
  };
  // 同作品重进 / 背景已解码：立即切屏，不多等一帧
  if (prev === id || isDetailBgReady(id)) {
    enter();
    return;
  }
  // 背景未解码：等它（最坏 400ms）再切屏。等的时候停在库屏，用户最多觉得点了稍慢；
  // 反过来先切过去，详情屏会先拿整屏封面顶几百毫秒——那正是「封面闪一下」。
  const timeout = new Promise<void>((res) => window.setTimeout(res, 400));
  void Promise.race([prepareDetailBg(id), timeout]).then(enter);
}

/** 键盘 / 手柄在轨道上打开详情：先给焦点卡一次按压反馈，再切屏
 *  （mockup 同款 110ms——否则切屏淡出抢在按压动画前面，看不出按到了） */
export function openDetailFromRail(id: string): void {
  const mode = layoutMode();
  const sel =
    mode === 'wall'
      ? `#wallGrid .wall-cell[data-i="${state.focus}"] .card`
      : mode === 'classic'
        ? `#railTrack .card[data-i="${state.focus}"]`
        : '';
  const card = sel ? document.querySelector<HTMLElement>(sel) : null;
  if (!card) {
    openDetail(id);
    return;
  }
  pressCard(card);
  const idx = state.focus;
  window.setTimeout(() => {
    // 与网格同一条规则：切屏 / 换焦点后这份延迟动作必须作废，否则会把人拉进详情
    if (state.screen !== 'library' || state.focus !== idx) return;
    openDetail(id);
  }, 110);
}

/* ============ 触摸：轨道横扫（掌机兜底交互，总案 2.4） ============ */
/** 拖动时只改 translateX（合成层），松手按位移量换算成卡片步数后对齐。
 *  鼠标不改语义：仍走 hover / click，避免拖拽感与桌面习惯打架。 */
function initTouchRail(): void {
  const track = document.getElementById('railTrack');
  if (!track) return;
  let startX = 0;
  let baseX = 0;
  let startFocus = 0;
  let moved = 0;
  let dragId = -1; // 进行中的触点 id（多指同时按时只认第一个）

  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const n = sortedGames().length;
    if (n < 2 || anyState() || dragId !== -1) return;
    dragId = e.pointerId;
    startX = e.clientX;
    startFocus = state.focus;
    baseX = railX(state.focus, n);
    moved = 0;
    track.style.transition = 'none';
  });

  track.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    const n = sortedGames().length;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    // 夹到首尾，拖到头就停住，不露空白
    const min = railX(n - 1, n);
    const max = railX(0, n);
    track.style.transform = `translateX(${Math.max(min, Math.min(max, baseX + dx))}px)`;
  });

  const end = (e: PointerEvent, cancelled = false): void => {
    if (e.pointerId !== dragId) return;
    dragId = -1;
    track.style.transition = '';
    // pointercancel 的 clientX 不可信（系统手势接管时常为 0）：按「原位回弹」处理，
    // 否则会算出一个巨大位移，把焦点直接甩到第一张
    if (cancelled || moved <= 10) {
      applyFocusCone(); // 轻点 / 手势被打断：轨道回对齐位
      return;
    }
    const n = sortedGames().length;
    const dx = e.clientX - startX;
    suppressClickUntil = Date.now() + 350;
    const steps = Math.abs(dx) < 30 ? 0 : Math.round(-dx / STEP);
    setFocus(Math.max(0, Math.min(n - 1, startFocus + steps)));
  };
  track.addEventListener('pointerup', (e) => end(e));
  track.addEventListener('pointercancel', (e) => end(e, true));
  // 手指滑出轨道区再松开：窗口级兜底，否则 dragId 会一直挂着
  window.addEventListener('pointerup', (e) => {
    if (e.pointerId === dragId) end(e);
  });
}

/* ============ 鼠标滚轮：经典轨道前后拨卡 ============ */
/** 经典轨道的位移由 transform 驱动、不是滚动容器，滚轮默认什么都不会发生。
 *  桌面用户习惯「滚轮 = 前后翻」，这里换算成焦点步进：
 *  鼠标一格（deltaY 常为 100）立即走一张，触控板的小增量累计到 40px 才算一次。 */
function initRailWheel(): void {
  let acc = 0;
  let last = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || state.screen !== 'library' || layoutMode() !== 'classic' || anyState()) return;
      const n = sortedGames().length;
      if (n < 2) return;
      // 横向滚轮 / 触控板横扫与竖向等价
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!raw) return;
      e.preventDefault();
      // deltaMode 1 = 行（一行的像素量按 40 估算）
      acc += e.deltaMode === 1 ? raw * 40 : raw;
      if (Math.abs(acc) < 40) return;
      const dir = acc > 0 ? 1 : -1;
      acc = 0;
      const now = Date.now();
      if (now - last < 70) return; // 高频滚轮事件限速，避免「滚一下飞出十几张」
      last = now;
      setFocus(state.focus + dir);
      sfx.move();
    },
    { passive: false },
  );
}

/* ============ 初始化 ============ */
export function initLibrary(): void {
  // Hero / 卡片的动作在这里注入：hero.ts / card.ts 不静态依赖本模块，避免循环引用
  initHero({ launch: () => void doLaunch(), openDetail: (id) => openDetail(id) });
  initCard({
    onFocus: setFocus,
    onOpen: openDetail,
    onLaunch: () => void doLaunch(),
    onToggleSel: toggleSel,
    suppressed: () => Date.now() < suppressClickUntil,
    multi: () => state.gridMulti,
  });
  initTouchRail();
  initRailWheel();
  // 窗口比例变化 → 舞台逻辑宽度变了：轨道的居中 / 夹紧要按新视口重算
  window.addEventListener('stage-resize', () => {
    if (state.games.length) applyFocusCone();
  });
  // 空态判定按屏分流：从设置页回到库 / 网格时补一次（见 updateEmpty 的注释）
  window.addEventListener('screen-change', () => updateEmpty());
  registerHandler('library', (n: NavIntent) => {
    if (n.intent === 'accept') {
      // 多选态：A = 勾选当前焦点，不再启动
      if (state.gridMulti) {
        const g = sortedGames()[state.focus];
        if (g) toggleSel(g.id);
        return;
      }
      // 键盘 / 手柄 A：先缩一下再启动（经典 = 大海报 CTA；列表 = 右侧大图 CTA；海报墙 = 聚焦卡）
      const mode = layoutMode();
      if (mode === 'list') press('#listPlay');
      else if (mode === 'wall') {
        const card = document.querySelector<HTMLElement>(`#wallGrid .wall-cell[data-i="${state.focus}"] .card`);
        if (card) pressCard(card);
      } else press('#ctaPlay');
      void doLaunch();
      return;
    }
    if (n.intent === 'back') {
      // 手柄 B（以及键盘 B）不产生 Escape，走不到下面那条 keydown 分支：
      // 多选态必须在这里退出，否则只能点「退出」按钮
      if (state.gridMulti) setMulti(false);
      return;
    }
    if (n.intent === 'move') {
      const n$ = sortedGames().length;
      if (n$ === 0) return;
      const mode = layoutMode();
      if (mode === 'list') {
        // 列表：只上下逐行，左右交给右侧内容（无横向列表项）
        if (n.dir === 'up') setFocus(state.focus - 1);
        if (n.dir === 'down') setFocus(state.focus + 1);
        return;
      }
      if (mode === 'wall') {
        // 海报墙：←→ 逐张，↑↓ 整排
        const step = n.dir === 'left' ? -1 : n.dir === 'right' ? 1 : n.dir === 'up' ? -WALL_COLS : WALL_COLS;
        setFocus(state.focus + step);
        return;
      }
      if (n.dir === 'up') return;
      if (n.dir === 'left') setFocus(state.focus - 1);
      if (n.dir === 'right') setFocus(state.focus + 1);
      if (n.dir === 'down') {
        // 轨道索引是「未筛选」的，网格用的是筛选后的 gridList()：按 id 映射。
        // 直接把 state.focus 赋过去，开过收藏 / 分面筛选时会落到别的作品或被夹到末尾。
        const cur = sortedGames()[state.focus];
        const list = gridList();
        const i = cur ? list.findIndex((g) => g.id === cur.id) : -1;
        state.gridFocus = i >= 0 ? i : 0;
        setScreen('grid');
        import('./grid')
          .then((m) => m.renderGrid())
          .catch((e) => console.error('[library] grid render failed', e));
      }
    }
  });

  /** 轮询兜底：game://exited 订阅失败（onEvent 静默吞错）时运行遮罩永不关闭，
   *  只能重启应用。每 5s 对账一次后端运行实例，对不上就手动走退出流程（最迟 5s 自愈）。
   *  事件正常时 exited 先停轮询，这里永不误触发。 */
  let exitPoll = 0;
  const stopExitPoll = (): void => {
    if (exitPoll) {
      window.clearInterval(exitPoll);
      exitPoll = 0;
    }
  };
  const startExitPoll = (): void => {
    stopExitPoll();
    exitPoll = window.setInterval(() => {
      if (!state.running) {
        stopExitPoll();
        return;
      }
      void runningGame()
        .then((g) => {
          if (state.running && !g) {
            // 错过了退出事件：退出码未知，按 0 处理，避免误导性的「退出码」提示
            handleGameExited(state.running, 0);
          }
        })
        .catch(() => {
          /* IPC 瞬时失败：下一轮再查 */
        });
    }, 5000);
  };
  const handleGameExited = (id: string, code: number): void => {
    stopExitPoll();
    state.running = null;
    refreshPadHints();
    hideLaunchLayer();
    // 游戏内快捷窗是另一个窗口，可能改过全屏：回库屏时同步窗口按钮的显隐
    void getSettings()
      .then((s) => applyFullscreenUI(!!s.fullscreen))
      .catch(() => {});
    const g = state.games.find((x) => x.id === id);
    if (g) toast(`《${esc(g.title)}》已退出`);
    if (code !== 0) toast(`退出码 ${code}`, true);
    // 退出后「累计时长 / 最近游玩 / 进度」都变了：详情屏是启动来源时它不会被
    // renderRail 重绘，不补一次就会一直显示进游戏前的旧数值
    void refreshLibrary()
      .then(() => {
        if (state.detailId === id) void import('./detail').then((m) => m.renderDetail());
      })
      .catch(() => undefined); // 刷新失败已在 refreshLibrary 统一提示
  };

  void onEvent<string>('game://started', async (id) => {
    state.running = id;
    refreshPadHints();
    sfx.launch(); // 真正起来了才给启动音（点击时的确认音已经响过）
    const g = state.games.find((x) => x.id === id);
    if (!g) return;
    try {
      await showLaunchLayer(g);
    } catch (e) {
      // 启动层渲染失败不能变成未捕获拒绝：游戏进程已经起来了，状态照样要更新
      console.error('[library] showLaunchLayer failed', e);
    }
    const status = document.getElementById('llStatus');
    if (status) status.textContent = '游戏运行中';
    startExitPoll();
  });
  void onEvent<{ id: string; code: number }>('game://exited', ({ id, code }) => {
    handleGameExited(id, code);
  });

  // X 结束游戏（运行中）/ 多选（M）/ Esc 退出多选 —— 各屏语义键，mockup 分发同款
  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'library' || anyState()) return;
    // 键鼠补位：Home/End 跳首尾，PageUp/PageDown 翻一屏（三套布局同一口径）
    if (e.code === 'Home' || e.code === 'End' || e.code === 'PageUp' || e.code === 'PageDown') {
      const total = sortedGames().length;
      if (!total) return;
      if (e.code === 'Home') setFocus(0);
      else if (e.code === 'End') setFocus(total - 1);
      else setFocus(state.focus + (e.code === 'PageUp' ? -6 : 6));
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyX' && state.gridMulti) {
      void openBatch();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyX' && state.running) {
      // AppError 是 { code, message } 对象：String(err) 只会显示 [object Object]
      stopGame(state.running).catch((err) =>
        toast(esc(String((err as { message?: string })?.message ?? err)), true),
      );
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyX') {
      // 手柄 X 保持「对当前对象的主操作」，不再兼作多选入口（手柄多选改按 Select）；
      // 键盘仍有 M，X 进多选的老习惯保留，不破坏既有键位
      if (isPadNavEvent(e)) {
        toast('多选请按 Select');
        e.preventDefault();
        return;
      }
      setMulti(true);
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyM') {
      // 三套布局统一多选；Y 在库屏仍是「详情」，与既有机位/文档一致
      setMulti(!state.gridMulti);
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyY') {
      const g = sortedGames()[state.focus];
      if (g) openDetailFromRail(g.id);
      // 打开详情是同步的：同一次按键还会继续送到详情屏的 window 监听器，
      // 那边看到 state.screen 已是 detail，会再按 Y 打开「结局」面板。
      // 这里截断本轮传播，`Y` 只表示「进入详情」，详情内的 Y 要再按一次。
      e.stopImmediatePropagation();
      e.preventDefault();
    }
    if (e.code === 'Escape' && state.gridMulti) {
      setMulti(false);
      e.preventDefault();
      return;
    }
    // P4：R 随机一部（掌机上「今天玩什么」的最短路径）。
    // 与网格 / 手柄 L3 / 快捷菜单共用 quick.pickRandomGame，避免两套实现分叉。
    if (e.code === 'KeyR') {
      void import('../quick').then((m) => m.pickRandomGame());
      e.preventDefault();
    }
  });

  document.getElementById('llStop')?.addEventListener('click', () => {
    if (state.running) {
      stopGame(state.running).catch((err) =>
        toast(esc(String((err as { message?: string })?.message ?? err)), true),
      );
    }
  });

  // 多选（三套布局共用 multi.ts）：批量完成后由回调刷新库；多选态变化只补勾选标记
  setMultiRefresh(refreshLibrary);
  window.addEventListener('multi-change', () => {
    refreshPadHints(); // 底栏从「多选（Select）」切到「批量操作（X）」
    // 勾选标记由 multi.markSel 全局同步；轨道整卡重建只会白解码一遍封面、还丢滚动位置
    if (state.screen === 'library') markSel();
  });
  document.getElementById('lselExit')?.addEventListener('click', () => setMulti(false));
  document.getElementById('lselAct')?.addEventListener('click', () => {
    void openBatch();
  });
}

// 向桥接层注册实现：detail / grid / 设置页不再直接 import 本文件（避免核心层反向依赖屏幕）
bindLibraryApi({
  refresh: refreshLibrary,
  openDetail,
  toggleFav,
  updateEmpty,
  updateCount,
  renderRail,
});

/** 全局轻量状态（vanilla，模块单例）。 */

import type { Game, Screen, Settings, SortMode } from './types';
import type { PadKind } from './padmap';

export type GridFilter = 'all' | 'playing' | 'done' | 'new' | 'fav';

/** 智能集合：不改状态筛选，只叠加一条「由数据自己决定」的条件 */
export type CollectionId = 'unplayed' | 'short' | 'series' | 'recent';

export const COLLECTIONS: { v: CollectionId; label: string }[] = [
  { v: 'unplayed', label: '从未启动' },
  { v: 'short', label: '短篇 ≤10h' },
  { v: 'series', label: '同会社系列' },
  { v: 'recent', label: '最近入库' },
];

/** 排序分段三项（UI 规范 5.3）：设置页与搜索面板共用同一份定义与同一 state.sortBy */
export const SORT_MODES: { v: SortMode; label: string }[] = [
  { v: 'lastPlayed', label: '最近游玩' },
  { v: 'title', label: '名称' },
  { v: 'year', label: '发售年' },
];

export const state = {
  games: [] as Game[],
  settings: null as Settings | null,
  screen: 'library' as Screen,
  /** 轨道焦点索引（sortedGames 序） */
  focus: 0,
  /** 网格焦点索引（筛选后列表序） */
  gridFocus: 0,
  gridFilter: 'all' as GridFilter,
  /** 网格多选：开关 + 已选 id（收藏 / 隐藏 / 标签 / 移除的批量入口） */
  gridMulti: false,
  gridSel: new Set<string>(),
  /** 分面筛选（网格）：标签 / 会社 / 年份，null = 不限（总案 P1「标签 / 会社 / 年份筛选」） */
  tagFilter: null as string | null,
  devFilter: null as string | null,
  yearFilter: null as number | null,
  /** 智能集合（P10）：unplayed / short / series / recent，null = 不叠加 */
  collection: null as CollectionId | null,
  /** 当前套用的保存视图名（用户再改任一筛选就失效） */
  viewName: null as string | null,
  /** 详情页对应的游戏 id */
  detailId: null as string | null,
  /** 运行中的游戏 id */
  running: null as string | null,
  /** 手柄布局：决定键帽显示 A/B/X/Y 还是 ✕/○/□/△ 或 B/A/Y/X */
  padKind: 'xbox' as PadKind,
  /** 键位页「手柄信息」：名称 / 布局 / 电量 / 力反馈 */
  padInfo: { name: '', kind: 'xbox' as PadKind, power: 'unknown', ff: false },
  sortBy: 'lastPlayed' as SortMode,
  /** 搜索面板关键词 */
  query: '',
  /** 动效强度：0 标准 / 1 柔和 */
  motion: 0,
  /** 竖排原文名显示 */
  verticalTitle: true,
  get empty(): boolean {
    // 隐藏作品不参与四屏显示：全部隐藏时同样按「库为空」处理，避免整屏空白且没有引导
    return !this.games.some((g) => !g.hidden);
  },
};

export function gameById(id: string | null): Game | null {
  if (!id) return null;
  return state.games.find((g) => g.id === id) ?? null;
}

/** 四屏可见的作品（隐藏作品只在「设置 · 库」出现），不排序。
 *  分面计数、候选池这类只要集合不要顺序的地方用它：sortedGames 每次都要排一遍全库，
 *  方向键连发时「面板 4 列 × 每步重排」正是大库卡顿的来源。 */
export function visibleGames(): Game[] {
  return state.games.filter((x) => !x.hidden);
}

export function sortedGames(): Game[] {
  // 隐藏作品只在「设置 · 库」里出现，默认四屏一律不显示
  const g = visibleGames();
  switch (state.sortBy) {
    case 'title':
      g.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
      break;
    case 'year':
      g.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      break;
    default:
      g.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || b.addedAt - a.addedAt);
  }
  return g;
}

/** 智能集合的预聚合数据：一次遍历算好，供同批次的所有判定复用。
 *  「同会社系列」原来对每部作品都要再扫一遍全库（O(N²)），
 *  网格筛选 + 筛选面板四列计数会把它放大到无法接受的量级。 */
export interface CollectionCtx {
  /** 可见作品中「同会社至少 2 部」的开发商 */
  seriesDevs: Set<string>;
}

export function collectionCtx(): CollectionCtx {
  const n = new Map<string, number>();
  for (const g of state.games) {
    if (g.hidden || !g.developer) continue;
    n.set(g.developer, (n.get(g.developer) ?? 0) + 1);
  }
  const seriesDevs = new Set<string>();
  for (const [dev, count] of n) if (count >= 2) seriesDevs.add(dev);
  return { seriesDevs };
}

/** 智能集合条件：只读数据，不需要用户维护。
 *  短篇用联网匹配拿到的参考时长（EGS）；没有时长的作品不进「短篇」，避免误判。
 *  ctx 由调用方在同一批次里算一次传进来；不传时退回单次计算（只有单条判定时才该这样用）。 */
export function collectionMatch(g: Game, c: CollectionId | null, ctx?: CollectionCtx): boolean {
  if (!c) return true;
  if (c === 'unplayed') return !g.lastPlayed;
  if (c === 'short') return !!g.lengthMinutes && g.lengthMinutes > 0 && g.lengthMinutes <= 600;
  if (c === 'recent') return Date.now() / 1000 - g.addedAt <= 30 * 86400;
  // 同会社系列：同一开发商在库里至少 2 部（隐藏的不算，否则会出现「只剩一部」的空集合）
  const dev = g.developer;
  if (!dev) return false;
  return (ctx ?? collectionCtx()).seriesDevs.has(dev);
}

/** 通关状态：END 清单非空且全部勾选达成（清单为空不算已通关） */
export function isFinished(g: Game): boolean {
  return g.endings.length > 0 && g.endings.every((e) => e.done);
}

/** 网格筛选后的列表（mockup FILTERS 同款语义 + 标签 / 会社 / 年份分面 + 智能集合） */
export function gridList(): Game[] {
  const f = state.gridFilter;
  const ctx = state.collection ? collectionCtx() : null;
  return sortedGames().filter((g) => {
    const byStatus =
      f === 'all'
        ? true
        : f === 'playing'
          ? !!g.lastPlayed && !isFinished(g)
          : f === 'done'
            ? isFinished(g)
            : f === 'fav'
              ? g.favorite
              : !g.lastPlayed;
    if (!byStatus) return false;
    if (state.tagFilter && !g.tags.includes(state.tagFilter) && !(g.userTags ?? []).includes(state.tagFilter)) return false;
    if (state.devFilter && g.developer !== state.devFilter) return false;
    if (state.yearFilter !== null && g.year !== state.yearFilter) return false;
    if (!collectionMatch(g, state.collection, ctx ?? undefined)) return false;
    return true;
  });
}

/** 当前生效的分面个数（0 = 未启用；用于筛选按钮上的角标与空态文案） */
export function facetCount(): number {
  return (
    (state.tagFilter ? 1 : 0) +
    (state.devFilter ? 1 : 0) +
    (state.yearFilter !== null ? 1 : 0) +
    (state.collection ? 1 : 0)
  );
}

export function clearFacets(): void {
  state.tagFilter = null;
  state.devFilter = null;
  state.yearFilter = null;
  state.collection = null;
  state.viewName = null;
}

/** 最近一次游玩的游戏 id（「最近游玩」徽标） */
export function lastPlayedId(): string | null {
  let best: Game | null = null;
  for (const g of state.games) {
    if (g.hidden) continue;
    if (g.lastPlayed && (!best || g.lastPlayed > (best.lastPlayed ?? 0))) best = g;
  }
  return best?.id ?? null;
}

/** 焦点对应游戏（按当前排序） */
export function focusedGame(): Game | null {
  const list = sortedGames();
  return list[state.focus] ?? list[0] ?? null;
}

/** 版本归并键：优先 Bangumi 条目，退回归一化标题（去分隔符 / 大小写 / 全半角）。
 *  汉化版与生肉通常同目录名，靠标题即可并到一起。 */
function versionKey(g: Game): string {
  if (g.bangumiId != null) return `b:${g.bangumiId}`;
  return `t:${(g.titleOriginal || g.title)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_·・:：,，.。!！?？'"“”‘’()（）[\]【】<>《》~～*＊/\\|]+/g, '')}`;
}

/** 同一部作品的其它版本（不含自己）。轨道只用来打「+N 版」角标，详情页用来切版本。
 *  隐藏的作品不参与四屏显示，也不该从这里被切进来（否则「已隐藏」形同虚设）。 */
export function versionGroup(g: Game): Game[] {
  const k = versionKey(g);
  return state.games.filter((x) => x.id !== g.id && !x.hidden && versionKey(x) === k);
}

/** 供 fps.ts 标记交互时间戳（触发 Auto 阶梯回升） */
export function touch(): void {
  /* lastInput 由 fps.ts 自己维护，此处保留扩展点 */
}

/** 屏幕切换：同一帧直切，不做任何交叉溶解。
 *  旧实现在旧屏上做了 .18s 淡出，旧屏始终以递减的不透明度盖在新屏上，
 *  切过去就能看到上一屏的画面残留；四屏统一直切后不再有过渡帧。
 *  不做 early-return —— 幂等处理，初始 state 与目标屏同名时首屏也不会黑屏 */
export function setScreen(s: Screen): void {
  // 先确认目标屏存在再改状态：反过来写的话，目标缺失时会留下
  // 「state.screen = 新屏、DOM 还停在旧屏」的错位（此后所有按键都打到错误的 handler 上）
  const screens = [...document.querySelectorAll<HTMLElement>('.screen')];
  const next = screens.find((el) => el.dataset.s === s);
  if (!next) return;
  const prev = state.screen;
  state.screen = s;
  // 多选只属于「库 ⇄ 网格」这两套浏览视图：进详情 / 设置时统一清掉。
  // 否则回到库屏还挂着「已选 N 部」，而详情屏的 A 完全不认这份选中集（两套语义打架）。
  let multiCleared = false;
  if (s !== 'library' && s !== 'grid' && state.gridMulti) {
    state.gridMulti = false;
    state.gridSel.clear();
    multiCleared = true;
  }
  // 点亮目标屏与关掉其它屏在同一次样式提交里完成：浏览器只会出一帧，
  // 既没有「旧屏还亮着」的残留，也没有两屏各半透明叠在一起的双曝光。
  next.classList.add('on');
  for (const el of screens) {
    if (el !== next) el.classList.remove('on');
  }
  // 让样式表知道当前在哪一屏（详情屏的背景浓度、氛围层都靠它分流）
  document.getElementById('app')?.setAttribute('data-screen', s);
  if (multiCleared) window.dispatchEvent(new Event('multi-change'));
  // 离屏清理的通用钩子：设置页的「改键捕获」在离开设置屏时必须自行结束，
  // 否则系统级热键会一直处于暂停注册状态（手柄 B 返回时没有按键事件可用来兜底）。
  if (prev !== s) window.dispatchEvent(new Event('screen-change'));
}


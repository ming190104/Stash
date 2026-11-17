/** 库状态纯逻辑：排序稳定性、隐藏条目、状态筛选 / 分面、智能集合与版本归并。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../types';
import {
  state,
  sortedGames,
  visibleGames,
  gridList,
  collectionMatch,
  collectionCtx,
  facetCount,
  clearFacets,
  lastPlayedId,
  versionGroup,
  versionCounts,
  versionOthers,
} from '../state';

/** 最小可用 Game：按用例覆盖排序 / 筛选 / 集合相关字段 */
function game(id: string, over: Partial<Game> = {}): Game {
  return {
    id, title: id, titleOriginal: null, romaji: null, dir: '', exe: '', engine: 'unknown', engineLabel: '',
    engineEvidence: '', cover: null, thumb: null, shots: [], peProduct: null, peCompany: null,
    developer: null, sizeGb: 0, lastPlayed: null, playCount: 0, playSeconds: 0, endings: [],
    favorite: false, addedAt: 0, needsLocale: false, matched: true, launchArgs: [], bangumiId: null,
    matchScore: null, pending: false, summary: null, tags: [], aliases: [], year: null,
    hidden: false, userTags: [], notes: '', ...over,
  };
}

const ids = (list: Game[]): string[] => list.map((g) => g.id);

beforeEach(() => {
  state.games = [];
  state.sortBy = 'lastPlayed';
  state.gridFilter = 'all';
  state.tagFilter = null;
  state.devFilter = null;
  state.yearFilter = null;
  state.collection = null;
  state.viewName = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('排序与隐藏条目', () => {
  it('最近游玩降序、隐藏条目不进入结果', () => {
    state.games = [
      game('a', { lastPlayed: 100 }),
      game('b', { lastPlayed: 200 }),
      game('c'),
      game('h', { lastPlayed: 999, hidden: true }),
    ];
    expect(ids(sortedGames())).toEqual(['b', 'a', 'c']);
  });

  it('最近游玩相同时按入库时间降序（稳定兜底）', () => {
    state.games = [game('old', { lastPlayed: 100, addedAt: 10 }), game('new', { lastPlayed: 100, addedAt: 20 })];
    expect(ids(sortedGames())).toEqual(['new', 'old']);
  });

  it('visibleGames 只过滤隐藏条目、不排序（分面计数用它，避免每列重排全库）', () => {
    state.games = [game('a', { lastPlayed: 100 }), game('b', { lastPlayed: 200 }), game('h', { hidden: true })];
    expect(ids(visibleGames())).toEqual(['a', 'b']);
  });

  it('名称 / 发售年排序', () => {
    state.games = [
      game('b', { title: 'Beta', year: 2000 }),
      game('a', { title: 'Alpha', year: 2020 }),
      game('c', { title: 'Gamma' }),
    ];
    state.sortBy = 'title';
    expect(ids(sortedGames())).toEqual(['a', 'b', 'c']);
    state.sortBy = 'year';
    expect(ids(sortedGames())).toEqual(['a', 'b', 'c']);
  });

  it('最近游玩徽标忽略隐藏条目', () => {
    state.games = [game('a', { lastPlayed: 100 }), game('h', { lastPlayed: 500, hidden: true })];
    expect(lastPlayedId()).toBe('a');
  });

  it('全部隐藏时按空库处理', () => {
    state.games = [game('h', { hidden: true })];
    expect(state.empty).toBe(true);
    state.games.push(game('v'));
    expect(state.empty).toBe(false);
  });
});

describe('网格筛选与分面', () => {
  it('状态筛选：playing / done / fav / new 且排除隐藏', () => {
    state.games = [
      game('playing', { lastPlayed: 100, endings: [{ name: 'END 1', done: true }, { name: 'END 2', done: false }] }),
      game('done', { lastPlayed: 200, endings: [{ name: 'END 1', done: true }] }),
      game('fresh'),
      game('fav', { lastPlayed: 300, favorite: true, endings: [{ name: 'END 1', done: false }] }),
      game('hid', { lastPlayed: 400, hidden: true }),
    ];
    state.gridFilter = 'playing';
    expect(ids(gridList())).toEqual(['fav', 'playing']);
    state.gridFilter = 'done';
    expect(ids(gridList())).toEqual(['done']);
    state.gridFilter = 'fav';
    expect(ids(gridList())).toEqual(['fav']);
    state.gridFilter = 'new';
    expect(ids(gridList())).toEqual(['fresh']);
  });

  it('标签（含用户标签）/ 会社 / 年份分面与角标', () => {
    state.games = [
      game('a', { tags: ['和风'], developer: 'Key', year: 2016 }),
      game('b', { userTags: ['和风'], developer: 'Leaf', year: 2012 }),
      game('c', { tags: ['科幻'], developer: 'Key', year: 2016 }),
    ];
    state.tagFilter = '和风';
    expect(ids(gridList())).toEqual(['a', 'b']);
    state.tagFilter = null;
    state.devFilter = 'Key';
    expect(ids(gridList())).toEqual(['a', 'c']);
    state.devFilter = null;
    state.yearFilter = 2012;
    expect(ids(gridList())).toEqual(['b']);
    expect(facetCount()).toBe(1);
    clearFacets();
    expect(facetCount()).toBe(0);
  });
});

describe('智能集合', () => {
  it('未启动 / 短篇 / 同会社系列', () => {
    const a = game('a', { lengthMinutes: 600, developer: 'Key' });
    const b = game('b', { lastPlayed: 100, lengthMinutes: 601, developer: 'Key' });
    const c = game('c', { lastPlayed: 100, developer: 'Leaf' });
    state.games = [a, b, c];
    expect(collectionMatch(a, 'unplayed')).toBe(true);
    expect(collectionMatch(b, 'unplayed')).toBe(false);
    expect(collectionMatch(a, 'short')).toBe(true);
    expect(collectionMatch(b, 'short')).toBe(false);
    expect(collectionMatch(c, 'short')).toBe(false);
    expect(collectionMatch(a, 'series')).toBe(true);
    expect(collectionMatch(c, 'series')).toBe(false);
    expect(collectionMatch(a, null)).toBe(true);
  });

  it('同会社系列走预聚合：隐藏作品不计数，也不需要逐条扫全库', () => {
    const a = game('a', { developer: 'Key' });
    const c = game('c', { developer: 'Leaf' });
    const h = game('h', { developer: 'Leaf', hidden: true });
    state.games = [a, game('b', { developer: 'Key' }), c, h];
    const ctx = collectionCtx();
    expect([...ctx.seriesDevs]).toEqual(['Key']);
    expect(collectionMatch(a, 'series', ctx)).toBe(true);
    expect(collectionMatch(c, 'series', ctx)).toBe(false);
    expect(collectionMatch(h, 'series', ctx)).toBe(false);
    // 不传 ctx 的旧调用方式结果一致（只用于单条判定）
    expect(collectionMatch(a, 'series')).toBe(true);
    expect(collectionMatch(c, 'series')).toBe(false);
  });

  it('最近入库按 30 天窗口判定（固定时钟，避免 flaky）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
    const now = Date.now() / 1000;
    expect(collectionMatch(game('fresh', { addedAt: now - 29 * 86400 }), 'recent')).toBe(true);
    expect(collectionMatch(game('old', { addedAt: now - 31 * 86400 }), 'recent')).toBe(false);
  });
});

describe('版本归并', () => {
  it('忽略大小写与分隔符，同一作品合并且不含自己', () => {
    state.games = [game('v1', { title: 'CLANNAD' }), game('v2', { title: 'clannad' }), game('v3', { title: 'C-LANNAD' })];
    expect(ids(versionGroup(state.games[0]))).toEqual(['v2', 'v3']);
  });

  it('隐藏的版本不参与归并（否则能从版本角标切进已隐藏的作品）', () => {
    state.games = [game('v1', { title: 'CLANNAD' }), game('v2', { title: 'clannad' }), game('v3', { title: 'C-LANNAD', hidden: true })];
    expect(ids(versionGroup(state.games[0]))).toEqual(['v2']);
  });

  it('预建计数与逐条 versionGroup 结果一致（隐藏作品的语境）', () => {
    state.games = [
      game('a', { title: 'CLANNAD' }),
      game('b', { title: 'clannad' }),
      game('c', { title: 'C-LANNAD' }),
      game('d', { title: 'CLANNAD', hidden: true }),
      game('e', { title: 'AIR' }),
    ];
    const counts = versionCounts();
    for (const g of state.games) {
      expect(versionOthers(g, counts)).toBe(versionGroup(g).length);
    }
    expect(versionOthers(state.games[0], counts)).toBe(2);
    expect(versionOthers(state.games[4], counts)).toBe(0);
  });

  it('改绑 Bangumi / 改标题后版本键缓存失效', () => {
    state.games = [game('a', { title: 'CLANNAD' }), game('b', { title: 'AIR' })];
    expect(ids(versionGroup(state.games[0]))).toEqual([]);
    state.games[1].bangumiId = 1;
    state.games[0].bangumiId = 1;
    expect(ids(versionGroup(state.games[0]))).toEqual(['b']);
  });
});

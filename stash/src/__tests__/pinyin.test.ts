/** 搜索索引：拼音全拼 / 首字母命中、大小写不敏感、空查询与隐藏条目语义。 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Game } from '../types';
import { state } from '../state';
import { searchList } from '../overlay';
import { pinyinHay } from '../pinyin';

/** 最小可用 Game：只填搜索相关字段，其余给空值，避免测试依赖完整 mock 库 */
function game(id: string, title: string, over: Partial<Game> = {}): Game {
  return {
    id, title, titleOriginal: null, romaji: null, dir: '', exe: '', engine: '', engineLabel: '',
    engineEvidence: '', cover: null, thumb: null, shots: [], peProduct: null, peCompany: null,
    developer: null, sizeGb: 0, lastPlayed: null, playCount: 0, playSeconds: 0, endings: [],
    favorite: false, addedAt: 0, needsLocale: false, matched: true, launchArgs: [], bangumiId: null,
    matchScore: null, pending: false, summary: null, tags: [], aliases: [], year: null,
    progress: 0, ...over,
  };
}

const ids = (): string[] => searchList().map((g) => g.id).sort();

beforeEach(() => {
  state.games = [
    game('g1', '初夏', { developer: '猫猫社', addedAt: 200 }),
    game('g2', 'CLANNAD', { romaji: 'CLANNAD', addedAt: 100 }),
    game('g3', '隐藏作品', { hidden: true }),
  ];
  state.query = '';
});

describe('pinyinHay', () => {
  it('同时输出全拼与首字母', () => {
    const hay = pinyinHay('初夏');
    expect(hay).toContain('chuxia');
    expect(hay).toContain('cx');
    expect(pinyinHay('')).toBe('');
  });
});

describe('搜索匹配', () => {
  it('全拼 chuxia 命中《初夏》', () => {
    state.query = 'chuxia';
    expect(ids()).toEqual(['g1']);
  });

  it('首字母 cx 命中《初夏》', () => {
    state.query = 'cx';
    expect(ids()).toEqual(['g1']);
  });

  it('大小写不敏感', () => {
    state.query = 'CHUXIA';
    expect(ids()).toEqual(['g1']);
    state.query = 'ClAnNaD';
    expect(ids()).toEqual(['g2']);
  });

  it('不相关的词不命中', () => {
    state.query = 'zzzz';
    expect(searchList()).toEqual([]);
  });

  it('空查询返回全部可见作品（隐藏条目不出现）', () => {
    expect(ids()).toEqual(['g1', 'g2']);
  });

  it('原地改标题后检索缓存失效（不会命中旧索引）', () => {
    const g = state.games[0];
    state.query = 'chuxia';
    expect(ids()).toEqual(['g1']);
    g.title = '白学';
    state.query = 'baixue';
    expect(ids()).toEqual(['g1']);
    state.query = 'chuxia';
    expect(ids()).toEqual([]);
  });
});

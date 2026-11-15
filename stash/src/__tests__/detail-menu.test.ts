// @vitest-environment happy-dom
/** 详情「游戏管理 → 元数据匹配」：三源候选手动应用 / 取消匹配入口，
 *  以及候选墙的渲染与来源角标（网络层用 mock，断言不依赖外网）。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { game, key, mountSkeleton, resetState } from './dom-skeleton';
import { handleOverlayKey } from '../overlay';
import { openDetailMenu } from '../screens/detail';
import { applyCandidate, metaCandidates, unmatchGame } from '../ipc';
import { toast } from '../ui';
import { state } from '../state';

vi.mock('../ipc', async (orig) => {
  const real = await orig<typeof import('../ipc')>();
  return {
    ...real,
    getLibrary: vi.fn(async () => []),
    metaCandidates: vi.fn(),
    applyCandidate: vi.fn(),
    unmatchGame: vi.fn(),
  };
});

// 详情屏依赖库屏的刷新与美术；这里只关心菜单，整块替身掉避免拉起整套库 DOM
vi.mock('../screens/library', () => ({
  toggleFav: vi.fn(),
  refreshLibrary: vi.fn(async () => undefined),
}));
vi.mock('../screens/art', () => ({
  artHTML: () => '',
  hydrateArts: () => undefined,
}));
vi.mock('../screens/detail-bg', () => ({
  paintDetailArt: () => undefined,
  forgetDetailBg: () => undefined,
  prepareDetailBg: vi.fn(async () => undefined),
}));

// toast 改成可断言的替身：真实 toast 是队列（每条 1.8s），会让用例互相等
vi.mock('../ui', async (orig) => {
  const real = await orig<typeof import('../ui')>();
  return { ...real, toast: vi.fn() };
});

const ID = '0123456789abcdef';

/** 菜单项文本（label + hint 拼在一起，去空白后做包含匹配） */
const items = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('#qmenu .qitem')].map((b) => (b.textContent ?? '').replace(/\s+/g, ''));
const title = (): string => (document.querySelector('#qmenu .qt')?.textContent ?? '').replace(/\s+/g, '');

/** 点菜单项并让出一轮宏任务：exec 的 busy 守卫在 await 之后才复位，
 *  同一微任务里连点第二项会被当成「重复触发」吃掉（真实用户点不了这么快）。 */
async function clickItem(text: string): Promise<void> {
  const b = [...document.querySelectorAll<HTMLElement>('#qmenu .qitem')].find((x) =>
    (x.textContent ?? '').replace(/\s+/g, '').includes(text),
  );
  b?.click();
  await new Promise((r) => setTimeout(r, 0));
}

const bangumi = (key: string, title: string, year: number | null, score: number) => ({
  source: 'bangumi' as const,
  key,
  title,
  original: null,
  year,
  score,
  summary: null,
  thumb: null,
  egs: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mountSkeleton();
  resetState();
});

describe('游戏管理 · 元数据匹配入口', () => {
  it('已匹配作品：显示「已匹配」角标，子菜单含匹配 / 取消 / 返回', async () => {
    state.games = [game(ID, { title: '装甲恶鬼村正', bangumiId: 99, matchScore: 100 })];
    await openDetailMenu(ID);
    expect(items().some((t) => t.includes('元数据匹配…已匹配'))).toBe(true);

    await clickItem('元数据匹配');
    await vi.waitFor(() => expect(title()).toContain('元数据匹配'));
    expect(items()).toEqual(['匹配元数据…四源候选·手动选择', '取消匹配回到本地meta.json', '返回B']);
  });

  it('未匹配作品：不给「取消匹配」（没有东西可取消）', async () => {
    state.games = [game(ID, { title: 'AIR' })];
    await openDetailMenu(ID);
    await clickItem('元数据匹配');
    await vi.waitFor(() => expect(title()).toContain('元数据匹配'));
    expect(items().some((t) => t.includes('取消匹配'))).toBe(false);
    expect(items().some((t) => t.includes('匹配元数据'))).toBe(true);
  });

  it('匹配元数据：三源候选统一列出，带来源角标；点一条即按 source + key 应用', async () => {
    state.games = [game(ID, { title: '装甲恶鬼村正', bangumiId: 99, matchScore: 100 })];
    vi.mocked(metaCandidates).mockResolvedValue([
      bangumi('1111', '装甲恶鬼村正（正确条目）', 2009, 92),
      { ...bangumi('装甲恶鬼村正', '装甲恶鬼村正', 2009, 88), source: 'moegirl' as const },
      {
        source: 'egs' as const,
        key: '装甲悪鬼村正',
        title: '装甲悪鬼村正',
        original: null,
        year: null,
        score: 60,
        summary: null,
        thumb: null,
        egs: { score: 78, votes: 120, minutes: 1500 },
      },
    ]);
    vi.mocked(applyCandidate).mockResolvedValue(undefined);

    await openDetailMenu(ID);
    await clickItem('元数据匹配');
    await vi.waitFor(() => expect(title()).toContain('元数据匹配'));
    await clickItem('匹配元数据');

    await vi.waitFor(() => expect(document.querySelectorAll('#candGrid .cand-card').length).toBe(3));
    expect(metaCandidates).toHaveBeenCalledWith(ID, 4);
    const srcs = [...document.querySelectorAll('#candGrid .cand-src')].map((e) => e.textContent);
    expect(srcs).toEqual(['Bangumi', '萌娘百科', '批评空间']);
    const mts = [...document.querySelectorAll('#candGrid .cand-mt')].map((e) => e.textContent);
    expect(mts[0]).toBe('2009 · 92 分');
    // EGS 展示自己的中央值与时长，不用相似度
    expect(mts[2]).toBe('中央值 78 · 25 小时');

    document.querySelector<HTMLElement>('#candGrid .cand-card')!.click();
    await vi.waitFor(() =>
      expect(applyCandidate).toHaveBeenCalledWith(ID, 'bangumi', '1111', [
        'title',
        'original',
        'year',
        'summary',
        'cover',
        'score',
      ]),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(toast).mock.calls.some(([m]) => String(m).includes('已应用所选数据'))).toBe(true),
    );
  });

  it('候选为空：候选墙给出说明，不伪造结果', async () => {
    state.games = [game(ID, { title: 'AIR' })];
    vi.mocked(metaCandidates).mockResolvedValue([]);

    await openDetailMenu(ID);
    await clickItem('元数据匹配');
    await vi.waitFor(() => expect(title()).toContain('元数据匹配'));
    await clickItem('匹配元数据');

    await vi.waitFor(() =>
      expect(document.getElementById('candGrid')!.textContent).toContain('没有候选'),
    );
    expect(document.querySelectorAll('#candGrid .cand-card').length).toBe(0);

    // 收起候选墙，避免 pending 的菜单 run 把下一用例的 exec 守卫占住
    handleOverlayKey(key('Escape'));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('取消匹配：调用后端并把结果交给 afterChange', async () => {
    state.games = [game(ID, { title: 'AIR', bangumiId: 7, matchScore: 100 })];
    vi.mocked(unmatchGame).mockResolvedValue(undefined);

    await openDetailMenu(ID);
    await clickItem('元数据匹配');
    await vi.waitFor(() => expect(title()).toContain('元数据匹配'));
    await clickItem('取消匹配');

    await vi.waitFor(() => expect(unmatchGame).toHaveBeenCalledWith(ID));
  });
});

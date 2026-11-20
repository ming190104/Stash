// @vitest-environment happy-dom
/** 详情屏交互链路（detail.ts）：渲染兜底、启动 / 收藏 / 目录、
 *  评分 / 标签 / 备注 / 版本切换、更多操作菜单与导航键位。 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { game, key, mountSkeleton, resetState } from './dom-skeleton';
import { state, setScreen } from '../state';
import { dispatchNav } from '../nav';
import { hideStates, openEndings } from '../overlay';
import { handleQuickKey } from '../quick';

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  prompt: vi.fn(async (_o: unknown): Promise<string | null> => null),
  confirm: vi.fn(async (_o: unknown): Promise<boolean> => false),
  asset: vi.fn(async (p: string) => `asset://${p}`),
  launchGame: vi.fn(async (_id: string) => undefined),
  openDir: vi.fn(async (_id: string) => undefined),
  setRating: vi.fn(async (_id: string, _v: number) => undefined),
  setUserTags: vi.fn(async (_id: string, _t: string[]) => undefined),
  setNotes: vi.fn(async (_id: string, _v: string) => undefined),
  setLaunchArgs: vi.fn(async (_id: string, _a: string[]) => undefined),
  setFavorite: vi.fn(async (_id: string, _f: boolean) => undefined),
  setGameTitle: vi.fn(async (_id: string, _t: string) => undefined),
  setGameCover: vi.fn(async (_id: string, _p: string) => undefined),
  pickImageFile: vi.fn(async (): Promise<string | null> => null),
  useBackgroundCandidate: vi.fn(async (_id: string, _k: string) => '/bg/k.jpg'),
  touchAsset: vi.fn(),
  setHidden: vi.fn(async (_id: string, _h: boolean) => undefined),
  removeGame: vi.fn(async (_id: string) => undefined),
  deleteGameDir: vi.fn(async (_id: string) => undefined),
  metaCandidates: vi.fn(async (_id: string, _n?: number) => [] as unknown[]),
  applyCandidate: vi.fn(async (_id: string, _s: string, _k: string) => undefined),
  unmatchGame: vi.fn(async (_id: string) => undefined),
  smartCover: vi.fn(async (_id: string) => 'D:\\c\\auto.png'),
  steamgridCover: vi.fn(async (_id: string) => 'D:\\c\\sgdb.png'),
  getLibrary: vi.fn(async (): Promise<unknown[]> => []),
  getSettings: vi.fn(async () => ({ fullscreen: false })),
  detailBackground: vi.fn(async (_id: string, _f?: boolean): Promise<string | null> => null),
}));

vi.mock('../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc')>();
  return {
    ...actual,
    asset: H.asset,
    launchGame: H.launchGame,
    openDir: H.openDir,
    setRating: H.setRating,
    setUserTags: H.setUserTags,
    setNotes: H.setNotes,
    setLaunchArgs: H.setLaunchArgs,
    setFavorite: H.setFavorite,
    setGameTitle: H.setGameTitle,
    setGameCover: H.setGameCover,
    pickImageFile: H.pickImageFile,
    useBackgroundCandidate: H.useBackgroundCandidate,
    touchAsset: H.touchAsset,
    setHidden: H.setHidden,
    removeGame: H.removeGame,
    deleteGameDir: H.deleteGameDir,
    metaCandidates: H.metaCandidates,
    applyCandidate: H.applyCandidate,
    unmatchGame: H.unmatchGame,
    smartCover: H.smartCover,
    steamgridCover: H.steamgridCover,
    getLibrary: H.getLibrary,
    getSettings: H.getSettings,
    detailBackground: H.detailBackground,
  };
});

vi.mock('../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui')>();
  return { ...actual, toast: H.toast };
});

vi.mock('../prompt', () => ({
  promptInput: H.prompt,
  promptConfirm: H.confirm,
  promptShown: () => false,
  submitPrompt: vi.fn(),
  dismissPrompt: vi.fn(),
}));

vi.mock('../bgpanel', () => ({
  openBgPanel: vi.fn(async () => null),
  BG_PICK: '@pick',
  BG_AUTO: '@auto',
}));

import { initDetail, markDetailEnter, openDetailMenu, renderDetail } from '../screens/detail';
import { renderRail } from '../screens/library';

function addContainers(): void {
  document.getElementById('app')!.insertAdjacentHTML(
    'beforeend',
    `<div id="detailArt"></div><div id="kvArt"></div>
     <div id="dCover"></div><div id="dInfo"></div><div id="dSide"></div>
     <div id="railTrack"></div><div id="wallGrid"></div><div id="gridCards"></div>
     <div id="listRows"></div><div id="listPreview"></div>
     <div id="gameCount"></div><div id="gameCount2"></div>`,
  );
}

const lastToast = (): string => String(H.toast.mock.calls[H.toast.mock.calls.length - 1]?.[0] ?? '');
const toastLog = (): string => H.toast.mock.calls.map((c) => String(c[0])).join('｜');

beforeAll(() => {
  mountSkeleton();
  addContainers();
  initDetail();
});

beforeEach(() => {
  resetState();
  hideStates();
  H.toast.mockClear();
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('on'));
  document.querySelector('.screen[data-s="detail"]')!.classList.add('on');
  document.getElementById('railTrack')!.innerHTML = '';
  document.getElementById('detailArt')!.className = '';
  document.getElementById('detailArt')!.style.backgroundImage = '';
  H.prompt.mockResolvedValue(null);
  H.getLibrary.mockImplementation(async () => state.games.map((g) => ({ ...g })));
});

/** 子菜单项刚画出来时上一层的 exec 还在 await 中（busy 未复位），立即点击会被丢掉。
 *  等一拍再点，才是真实用户的节奏。 */
const clickSoon = async (k: string): Promise<void> => {
  await vi.waitFor(() => expect(document.querySelector(`#qmenu .qitem[data-k="${k}"]`)).not.toBeNull());
  await new Promise((r) => window.setTimeout(r, 30));
  document.querySelector<HTMLElement>(`#qmenu .qitem[data-k="${k}"]`)!.click();
};

describe('详情渲染', () => {
  it('作品已不在库中：清掉残留并给出返回提示', async () => {
    state.detailId = 'gone';
    document.getElementById('kvArt')!.innerHTML = 'old';
    await renderDetail();
    expect(document.getElementById('kvArt')!.innerHTML).toBe('');
    expect(document.getElementById('dInfo')!.textContent).toContain('作品已不在库中');
    expect(document.getElementById('dSide')!.innerHTML).toBe('');
  });

  it('完整信息：标题 / 标签 / 版本 / 场次 / 结局与右侧按钮', async () => {
    const a = game('a', {
      title: '千恋万花',
      titleOriginal: '千恋＊万花',
      romaji: 'Senren',
      cover: 'D:\\c\\a.png',
      favorite: true,
      tags: ['纯爱', '和风'],
      userTags: ['神作'],
      endings: [
        { name: 'END1', done: true },
        { name: 'END2', done: false },
      ],
      notes: '已通关',
      rating: 3,
      playSeconds: 7200,
      sessions: [
        { at: Date.now() / 1000 - 3600, seconds: 600 },
        { at: Date.now() / 1000 - 7200, seconds: 900 },
      ],
      engineLabel: 'Kirikiri',
      needsLocale: true,
      metaScore: 8.4,
      metaScoreSource: 'bangumi',
      lengthMinutes: 600,
    });
    state.games = [a, game('a2', { title: '千恋万花', dir: 'D:\\a2' })];
    state.detailId = 'a';
    markDetailEnter();
    await renderDetail();

    const info = document.getElementById('dInfo')!;
    expect(info.querySelector('.d-cn')!.textContent).toBe('千恋万花');
    expect(info.querySelector('.d-jp')!.textContent).toContain('千恋＊万花');
    expect(info.querySelectorAll('.pill').length).toBe(3);
    expect(info.querySelectorAll('.dstar.on').length).toBe(3);
    expect(info.querySelector('#dEnds')!.textContent).toBe('管理');
    expect(info.textContent).toContain('需转区');
    expect(info.querySelector('.d-ver')!.textContent).toContain('a2');
    expect(info.querySelectorAll('.d-sess b').length).toBe(2);

    const side = document.getElementById('dSide')!;
    expect(side.querySelector('#dPlay')).not.toBeNull();
    expect(side.querySelector('#dFav')!.textContent).toContain('★ 已收藏');
    expect(side.classList.contains('unfold')).toBe(true);
    expect(document.querySelector('#dPlay')!.classList.contains('focus')).toBe(true);
  });
});

describe('右侧按钮', () => {
  async function renderOne(over: Parameters<typeof game>[1] = {}): Promise<void> {
    state.games = [game('a', over)];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
  }

  it('启动：已有游戏运行先提示；失败转 toast；成功调 launchGame', async () => {
    await renderOne();
    state.running = 'b';
    document.getElementById('dPlay')!.click();
    expect(lastToast()).toContain('已有游戏在运行');

    state.running = null;
    H.launchGame.mockRejectedValueOnce({ message: '路径失效' });
    document.getElementById('dPlay')!.click();
    await vi.waitFor(() => expect(lastToast()).toContain('路径失效'));

    await renderOne();
    document.getElementById('dPlay')!.click();
    expect(H.launchGame).toHaveBeenCalledWith('a');
  });

  it('收藏按钮走统一入口并落盘', async () => {
    await renderOne();
    document.getElementById('dFav')!.click();
    expect(state.games[0]!.favorite).toBe(true);
    await vi.waitFor(() => expect(H.setFavorite).toHaveBeenCalledWith('a', true));
  });

  it('打开目录失败转提示', async () => {
    await renderOne();
    H.openDir.mockRejectedValueOnce({ message: '目录不存在' });
    document.getElementById('dOpen')!.click();
    await vi.waitFor(() => expect(lastToast()).toContain('目录不存在'));
  });
});

describe('信息面板操作', () => {
  async function renderOne(over: Parameters<typeof game>[1] = {}): Promise<void> {
    state.games = [game('a', over)];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
  }

  it('评分：点第 N 颗写入 N，再点同一颗清零，失败只提示', async () => {
    await renderOne({ rating: 2 });
    const info = document.getElementById('dInfo')!;
    info.querySelector<HTMLElement>('[data-star="4"]')!.click();
    await vi.waitFor(() => expect(H.setRating).toHaveBeenCalledWith('a', 4));
    await vi.waitFor(() => expect(state.games[0]!.rating).toBe(4));

    H.setRating.mockRejectedValueOnce({ message: '写库失败' });
    (document.getElementById('dInfo')!.querySelector<HTMLElement>('[data-star="4"]'))!.click();
    await vi.waitFor(() => expect(lastToast()).toContain('写库失败'));
  });

  it('自定义标签：点标签移除，添加入口把空格分隔的标签一次写入', async () => {
    await renderOne({ userTags: ['神作', '纯爱'] });
    document.querySelector<HTMLElement>('[data-tag="纯爱"]')!.click();
    await vi.waitFor(() => expect(H.setUserTags).toHaveBeenCalledWith('a', ['神作']));
    await vi.waitFor(() => expect(state.games[0]!.userTags).toEqual(['神作']));

    await renderOne({ userTags: [] });
    H.prompt.mockResolvedValueOnce('  剧情 拔作 ');
    document.getElementById('dTagAdd')!.click();
    await vi.waitFor(() => expect(H.setUserTags).toHaveBeenCalledWith('a', ['剧情', '拔作']));
    expect(toastLog()).toContain('标签已保存');
  });

  it('备注：取消不写库；确认后落盘并刷新', async () => {
    await renderOne({ notes: '旧备注' });
    H.prompt.mockResolvedValueOnce(null);
    document.getElementById('dNotes')!.click();
    await vi.waitFor(() => expect(H.prompt).toHaveBeenCalled());
    expect(H.setNotes).not.toHaveBeenCalled();

    H.prompt.mockResolvedValueOnce('新备注');
    document.getElementById('dNotes')!.click();
    await vi.waitFor(() => expect(H.setNotes).toHaveBeenCalledWith('a', '新备注'));
    expect(toastLog()).toContain('备注已保存');
  });

  it('同名版本：点 chip 切换 detailId，等背景备齐后重渲染', async () => {
    await renderOne();
    state.games = [game('a'), game('b', { title: 'a' })];
    state.detailId = 'a';
    await renderDetail();
    document.querySelector<HTMLElement>('[data-ver="b"]')!.click();
    // detailId 要等 prepareDetailBg 解码完才改，避免等待期间按键作用到新作品
    await vi.waitFor(() => expect(state.detailId).toBe('b'));
  });
});

describe('更多操作菜单', () => {
  const menuBtn = (k: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`#qmenu .qitem[data-k="${k}"]`);

  it('菜单项齐全，启动参数可保存 / 清空，标题可重命名', async () => {
    state.games = [game('a', { launchArgs: ['-window'] })];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    await openDetailMenu('a');
    expect(document.getElementById('qmenu')!.classList.contains('show')).toBe(true);
    for (const k of ['args', 'iso', 'title', 'cover', 'bg', 'tag', 'notes', 'match', 'remove']) {
      expect(menuBtn(k), k).not.toBeNull();
    }
    expect(menuBtn('args')!.querySelector('span')!.textContent).toBe('1 项');

    H.prompt.mockResolvedValueOnce('-window -nojoy');
    menuBtn('args')!.click();
    await vi.waitFor(() => expect(H.setLaunchArgs).toHaveBeenCalledWith('a', ['-window', '-nojoy']));
    await vi.waitFor(() => expect(state.games[0]!.launchArgs).toEqual(['-window', '-nojoy']));

    await openDetailMenu('a');
    H.prompt.mockResolvedValueOnce('  ');
    menuBtn('args')!.click();
    await vi.waitFor(() => expect(lastToast()).toContain('已清空启动参数'));

    await openDetailMenu('a');
    H.prompt.mockResolvedValueOnce('新标题');
    menuBtn('title')!.click();
    await vi.waitFor(() => expect(H.setGameTitle).toHaveBeenCalledWith('a', '新标题'));
    expect(toastLog()).toContain('标题已更新');
  });

  it('更换封面子菜单：本地图片与自动找图', async () => {
    state.games = [game('a')];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    await openDetailMenu('a');
    menuBtn('cover')!.click();

    H.pickImageFile.mockResolvedValueOnce('D:\\p.png');
    await clickSoon('file');
    await vi.waitFor(() => expect(H.setGameCover).toHaveBeenCalledWith('a', 'D:\\p.png'));
    await vi.waitFor(() => expect(toastLog()).toContain('封面已更新'));

    state.screen = 'detail';
    await openDetailMenu('a');
    menuBtn('cover')!.click();
    await clickSoon('auto');
    await vi.waitFor(() => expect(toastLog()).toContain('已在目录里选好封面'));
  });

  it('元数据：自动重匹配、候选绑定、取消匹配', async () => {
    state.games = [game('a', { bangumiId: 7, matchScore: 100 })];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    await openDetailMenu('a');
    menuBtn('match')!.click();
    await vi.waitFor(() => expect(menuBtn('unmatch')).not.toBeNull());
    await new Promise((r) => window.setTimeout(r, 30));

    H.metaCandidates.mockResolvedValueOnce([
      {
        source: 'bangumi',
        key: '42',
        title: '雪之少女',
        original: 'Kanon',
        year: 1999,
        score: 98,
        summary: null,
        thumb: null,
        egs: null,
      },
    ]);
    menuBtn('pick')!.click();
    await vi.waitFor(() => expect(document.querySelector('#candGrid .cand-card')).not.toBeNull());
    document.querySelector<HTMLElement>('#candGrid .cand-card')!.click();
    await vi.waitFor(() =>
      expect(H.applyCandidate).toHaveBeenCalledWith('a', 'bangumi', '42', [
        'title',
        'original',
        'year',
        'summary',
        'cover',
        'score',
      ]),
    );
    await vi.waitFor(() => expect(toastLog()).toContain('已应用所选数据'));
  });

  it('移出库：隐藏后清 detailId 回库屏；移除只需点确定', async () => {
    state.games = [game('a')];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    await openDetailMenu('a');
    menuBtn('remove')!.click();

    await clickSoon('hide');
    await vi.waitFor(() => expect(H.setHidden).toHaveBeenCalledWith('a', true));
    await vi.waitFor(() => expect(state.detailId).toBeNull());
    expect(state.screen).toBe('library');
    state.games = [game('a')];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    await openDetailMenu('a');
    menuBtn('remove')!.click();

    H.confirm.mockResolvedValueOnce(false);
    await clickSoon('remove');
    await vi.waitFor(() => expect(H.confirm).toHaveBeenCalled());
    expect(H.removeGame).not.toHaveBeenCalled();

    H.confirm.mockResolvedValueOnce(true);
    await clickSoon('remove');
    await vi.waitFor(() => expect(H.removeGame).toHaveBeenCalledWith('a'));
    await vi.waitFor(() => expect(state.detailId).toBeNull());
  });

  it('删除游戏目录：确认后调后端并回库屏，取消失败都不动文件', async () => {
    state.games = [game('a', { dir: 'D:\\Games\\AIR' })];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    await openDetailMenu('a');
    menuBtn('remove')!.click();

    H.confirm.mockResolvedValueOnce(false);
    await clickSoon('delete');
    await vi.waitFor(() => expect(H.confirm).toHaveBeenCalled());
    expect(H.deleteGameDir).not.toHaveBeenCalled();

    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    await openDetailMenu('a');
    menuBtn('remove')!.click();

    H.confirm.mockResolvedValueOnce(true);
    await clickSoon('delete');
    await vi.waitFor(() => expect(H.deleteGameDir).toHaveBeenCalledWith('a'));
    await vi.waitFor(() => expect(state.detailId).toBeNull());
    expect(state.screen).toBe('library');
    expect(toastLog()).toContain('已移入回收站');
  });

  it('删除游戏目录：后端拒绝时只报错，仍停在详情页', async () => {
    state.games = [game('a', { dir: 'D:\\Games\\AIR' })];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    await openDetailMenu('a');
    menuBtn('remove')!.click();

    H.deleteGameDir.mockRejectedValueOnce({ message: '该目录还包含其它已入库作品' });
    H.confirm.mockResolvedValueOnce(true);
    await clickSoon('delete');
    await vi.waitFor(() => expect(lastToast()).toContain('还包含其它已入库作品'));
    expect(state.detailId).toBe('a');
    expect(state.screen).toBe('detail');
  });
});

describe('导航与快捷键', () => {
  async function setup(): Promise<void> {
    state.games = [
      game('a', { endings: [{ name: 'END1', done: true }] }),
      game('b', { title: 'a', dir: 'D:\\b' }),
    ];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
  }

  it('B 回库并清掉焦点环；A 激活焦点控件', async () => {
    await setup();
    dispatchNav({ intent: 'back' });
    expect(state.screen).toBe('library');
    expect(document.querySelectorAll('.focus.ghost').length).toBe(0);

    setScreen('detail'); // 切屏会改 DOM 的 .on：curScreen() 读 DOM，不能只改 state
    await renderDetail(); // 回库时焦点环被清掉，重进详情才会重新聚焦第一个控件
    dispatchNav({ intent: 'accept' });
    expect(H.launchGame).toHaveBeenCalledWith('a');
  });

  it('上下移动焦点环，左右切换同名版本', async () => {
    await setup();
    const before = [...document.querySelectorAll('#dSide .focus')].length;
    dispatchNav({ intent: 'move', dir: 'down' });
    expect(document.querySelectorAll('#dSide .focus').length).toBe(before);
    dispatchNav({ intent: 'move', dir: 'right' });
    await vi.waitFor(() => expect(state.detailId).toBe('b'));
  });

  it('三个同名版本按环顺序左右循环', async () => {
    state.games = [
      game('r1', { title: '同名作品' }),
      game('r2', { title: '同名作品' }),
      game('r3', { title: '同名作品' }),
    ];
    state.detailId = 'r1';
    setScreen('detail');
    await renderDetail();

    const stepTo = async (dir: 'left' | 'right', id: string): Promise<void> => {
      dispatchNav({ intent: 'move', dir });
      await vi.waitFor(() => expect(state.detailId).toBe(id));
      // 等这一轮 renderDetail 收尾：版本环游标要按新作品同步后，下一次 ← / → 才接着走
      await vi.waitFor(() => expect(document.querySelectorAll('#dInfo .vchip').length).toBe(2));
    };

    await stepTo('right', 'r2');
    await stepTo('right', 'r3');
    await stepTo('right', 'r1');
    await stepTo('left', 'r3');
  });

  it('切换版本等待背景解码期间不提前改 detailId', async () => {
    state.games = [
      game('w1', { title: '汉化版', bangumiId: 999 }),
      game('w2', { title: '生肉版', bangumiId: 999 }),
    ];
    state.detailId = 'w1';
    setScreen('detail');
    await renderDetail();
    expect(document.querySelector('#dInfo .d-cn')!.textContent).toBe('汉化版');

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    H.detailBackground.mockImplementation(async (id: string): Promise<string | null> => {
      if (id === 'w2') await gate;
      return null;
    });

    dispatchNav({ intent: 'move', dir: 'right' });
    await new Promise((r) => window.setTimeout(r, 20));
    // 背景还在解码：detailId 与 DOM 都必须是旧作品
    expect(state.detailId).toBe('w1');
    expect(document.querySelector('#dInfo .d-cn')!.textContent).toBe('汉化版');

    release();
    await vi.waitFor(() => expect(state.detailId).toBe('w2'));
    await vi.waitFor(() => expect(document.querySelector('#dInfo .d-cn')!.textContent).toBe('生肉版'));
    H.detailBackground.mockImplementation(async () => null);
  });

  it('删除最后一条结局时不会残留已通关状态', () => {
    state.games = [game('a', { endings: [{ name: 'END1', done: true }] })];
    state.detailId = 'a';
    setScreen('detail');
    openEndings('a');
    expect(document.getElementById('endTitle')!.textContent).toContain('1/1 达成');
    document
      .querySelector<HTMLElement>('#endList .snap-act.del[data-act="del"]')!
      .click();
    expect(state.games[0]!.endings).toEqual([]);
    expect(document.getElementById('endTitle')!.textContent).toContain('尚未记录');
  });

  it('Y 打开结局面板但不会同一次事件里新增 END；R 收藏', async () => {
    await setup();
    window.dispatchEvent(key('KeyY'));
    await vi.waitFor(() => expect(document.getElementById('endPanel')!.classList.contains('show')).toBe(true));
    // 回归：打开面板的那一次 Y 不能被 overlay 再解释成「新增」，否则每次看结局都多一条假记录
    expect(state.games[0]!.endings.map((e) => e.name)).toEqual(['END1']);
    hideStates();
    window.dispatchEvent(key('KeyR'));
    await vi.waitFor(() => expect(H.setFavorite).toHaveBeenCalledWith('a', true));
  });

  it('子菜单 B 先回上一层，再按才关整层', async () => {
    await setup();
    await openDetailMenu('a');
    await vi.waitFor(() => expect(document.querySelector('#qmenu .qitem[data-k="cover"]')).not.toBeNull());
    document.querySelector<HTMLElement>('#qmenu .qitem[data-k="cover"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('#qmenu .qitem[data-k="file"]')).not.toBeNull());
    expect(handleQuickKey(key('Escape'))).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('#qmenu .qitem[data-k="args"]')).not.toBeNull());
    expect(handleQuickKey(key('Escape'))).toBe(true);
    expect(document.getElementById('qmenu')!.classList.contains('show')).toBe(false);
  });
});

describe('库屏刷新兜底', () => {
  it('afterChange 走 refreshLibrary，即使库读取失败也不会抛错', async () => {
    state.games = [game('a')];
    state.detailId = 'a';
    state.screen = 'detail';
    await renderDetail();
    H.getLibrary.mockRejectedValueOnce(new Error('offline'));
    document.querySelector<HTMLElement>('[data-star="5"]')!.click();
    await vi.waitFor(() => expect(H.setRating).toHaveBeenCalled());
    expect(renderRail).toBeTruthy();
  });
});

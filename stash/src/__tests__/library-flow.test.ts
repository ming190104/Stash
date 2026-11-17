// @vitest-environment happy-dom
/** 库屏核心交互链路（library.ts）：三套布局渲染、窗口化、焦点、收藏回滚、刷新容错、
 *  启动 / 退出事件、滚轮与触摸横扫、导航与快捷键分发。
 *  这些路径此前只有纯渲染的单测，键盘 / 手柄 → 状态 → DOM 的整条链路没有跑过。 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { game, key, mountSkeleton, resetState } from './dom-skeleton';
import { state, setScreen } from '../state';
import { dispatchNav } from '../nav';
import { applyLayout } from '../ui';
import { hideStates, showEmpty } from '../overlay';

const H = vi.hoisted(() => ({
  events: new Map<string, (p: unknown) => void>(),
  toast: vi.fn((_msg: string, _hot?: boolean) => undefined),
  asset: vi.fn(async (p: string) => `asset://${p}`),
  launchGame: vi.fn(async (_id: string) => undefined),
  stopGame: vi.fn(async (_id: string) => undefined),
  setFavorite: vi.fn(async (_id: string, _f: boolean) => undefined),
  getLibrary: vi.fn(async (): Promise<unknown[]> => []),
  getSettings: vi.fn(async () => ({ fullscreen: false })),
  runningGame: vi.fn(async () => null),
  detailBackground: vi.fn(async () => null),
  openDir: vi.fn(async () => undefined),
  setRating: vi.fn(async () => undefined),
  setUserTags: vi.fn(async () => undefined),
  setNotes: vi.fn(async () => undefined),
  setLaunchArgs: vi.fn(async () => undefined),
}));

vi.mock('../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc')>();
  return {
    ...actual,
    asset: H.asset,
    launchGame: H.launchGame,
    stopGame: H.stopGame,
    setFavorite: H.setFavorite,
    getLibrary: H.getLibrary,
    getSettings: H.getSettings,
    runningGame: H.runningGame,
    detailBackground: H.detailBackground,
    openDir: H.openDir,
    setRating: H.setRating,
    setUserTags: H.setUserTags,
    setNotes: H.setNotes,
    setLaunchArgs: H.setLaunchArgs,
    onEvent: async (name: string, cb: (p: never) => void) => {
      H.events.set(name, cb as (p: unknown) => void);
      return () => H.events.delete(name);
    },
  };
});

// toast 走队列（1.8s/条），连续断言时上一条还挂在 DOM 上：改为记录调用，避免跨用例串味
vi.mock('../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui')>();
  return { ...actual, toast: H.toast };
});

import { init } from '../nav';
import {
  doLaunch,
  initLibrary,
  openDetail,
  openDetailFromRail,
  refreshLibrary,
  renderRail,
  scheduleLibraryRefresh,
  setFocus,
  toggleFav,
  updateEmpty,
  railWindow,
} from '../screens/library';
import { renderGrid, initGrid } from '../screens/grid';
import { setMulti, toggleSel } from '../multi';

/** 生产环境的结构来自 index.html；测试里补出 library.ts / grid.ts 会查到的容器 */
function addContainers(): void {
  const app = document.getElementById('app')!;
  app.insertAdjacentHTML(
    'beforeend',
    `<div id="railTrack"></div>
     <div id="wallGrid"></div>
     <div id="listRows"></div><div id="listPreview"></div>
     <div id="gridCards"></div>
     <div id="detailArt"></div><div id="kvArt"></div>
     <div id="dCover"></div><div id="dInfo"></div><div id="dSide"></div>
     <div id="gameCount"></div><div id="gameCount2"></div>
     <div id="llArt"></div><div id="llTitle"></div><div id="llStatus"></div>
     <span id="gselN"></span><span id="lselN"></span>
     <div id="lselBar" hidden><button id="lselExit"></button><button id="lselAct"></button></div>
     <div id="gselBar" hidden><button id="gselExit"></button><button id="gselAct"></button></div>`,
  );
}

/** 所有 toast 文案拼在一起，顺序不敏感的断言用这个 */
const allToasts = (): string => H.toast.mock.calls.map((c) => String(c[0])).join('｜');

beforeAll(() => {
  mountSkeleton();
  addContainers();
  init();
  initLibrary();
});

beforeEach(() => {
  resetState();
  hideStates();
  H.toast.mockClear();
  applyLayout('classic', false);
  // resetState 只复位 state.screen；DOM 的 .on 由上一个用例留在别的屏上，
  // 而 curScreen() 读的是 DOM：不同步会让导航被分发到错误的 handler
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('on'));
  document.querySelector('.screen[data-s="library"]')!.classList.add('on');
  document.getElementById('railTrack')!.innerHTML = '';
  document.getElementById('wallGrid')!.innerHTML = '';
  document.getElementById('gridCards')!.innerHTML = '';
  document.getElementById('listRows')!.innerHTML = '';
  document.getElementById('listPreview')!.innerHTML = '';
  H.getLibrary.mockResolvedValue([]);
  H.setFavorite.mockResolvedValue(undefined);
  H.launchGame.mockResolvedValue(undefined);
  H.getSettings.mockResolvedValue({ fullscreen: false });
});

describe('首屏与三套布局', () => {
  it('首屏焦点落在「继续上次」而不是第一张（只生效一次）', () => {
    state.sortBy = 'title';
    state.games = [game('a', { title: 'A' }), game('b', { title: 'B', lastPlayed: 100 })];
    renderRail();
    expect(state.focus).toBe(1);
    // 用户接管焦点后再刷新：不能被拽回「继续上次」
    state.focus = 0;
    renderRail();
    expect(state.focus).toBe(0);
  });

  it('经典轨道：建卡、挂焦点锥三级梯度并写位移', () => {
    state.games = [game('a'), game('b'), game('c'), game('h', { hidden: true })];
    renderRail();
    const cards = document.querySelectorAll<HTMLElement>('#railTrack .card');
    expect(cards.length).toBe(3); // 隐藏作品不参与
    expect(cards[0].classList.contains('focus')).toBe(true);
    expect(cards[1].classList.contains('n1')).toBe(true);
    expect(cards[2].classList.contains('n2')).toBe(true);
    expect(document.getElementById('railTrack')!.style.transform).toMatch(/^translateX\(/);
    // 计数含隐藏作品（设置 · 库里还能看到）
    expect(document.getElementById('gameCount')!.textContent).toBe('4 部作品');
    expect(document.getElementById('gameCount2')!.textContent).toBe('4 部作品');
  });

  it('大库窗口化：焦点前后各 60 张完整卡，其余用等尺寸占位', () => {
    state.games = Array.from({ length: 200 }, (_, i) => game(`g${i}`));
    state.focus = 100;
    renderRail();
    expect(document.querySelectorAll('#railTrack .card').length).toBe(200);
    expect(document.querySelectorAll('#railTrack .card.slot').length).toBe(79);
    expect(document.querySelectorAll('#railTrack .card:not(.slot)').length).toBe(121);
  });

  it('railWindow 边界：空库、负焦点、越界都夹紧', () => {
    expect(railWindow(0, 0)).toEqual([0, -1]);
    expect(railWindow(-5, 10)).toEqual([0, 9]);
    expect(railWindow(99, 10)).toEqual([39, 9]);
    expect(railWindow(3, 10)).toEqual([0, 9]);
  });

  it('列表布局：行渲染、焦点行高亮、计数同步', () => {
    applyLayout('list', false);
    state.games = [game('a', { title: 'A' }), game('b', { title: 'B' })];
    state.focus = 5;
    renderRail();
    const rows = document.querySelectorAll<HTMLElement>('#listRows .lrow');
    expect(rows.length).toBe(2);
    expect(state.focus).toBe(1);
    expect(rows[1].classList.contains('on')).toBe(true);
    setFocus(0);
    expect(document.querySelectorAll('#listRows .lrow.on').length).toBe(1);
  });

  it('海报墙布局：单元格建卡与标题，焦点只给当前卡', () => {
    applyLayout('wall', false);
    state.games = [game('a'), game('b')];
    renderRail();
    expect(document.querySelectorAll('#wallGrid .wall-cell').length).toBe(2);
    setFocus(1);
    expect(document.querySelectorAll('#wallGrid .card.focus').length).toBe(1);
  });

  it('空态：库空时弹引导，重新有作品后收起', () => {
    state.games = [];
    renderRail();
    expect(document.getElementById('emptyState')!.classList.contains('show')).toBe(true);
    state.games = [game('a')];
    renderRail();
    expect(document.getElementById('emptyState')!.classList.contains('show')).toBe(false);
    showEmpty('empty');
    updateEmpty();
  });

  it('空态只属于库 / 网格屏：设置页不弹，回库后自动补上', () => {
    state.games = [];
    setScreen('settings');
    updateEmpty();
    const empty = document.getElementById('emptyState')!;
    expect(empty.classList.contains('show')).toBe(false);
    setScreen('library');
    expect(empty.classList.contains('show')).toBe(true);
    hideStates();
  });

  it('setFocus 夹紧越界索引并同步焦点锥', () => {
    state.games = Array.from({ length: 5 }, (_, i) => game(`g${i}`));
    renderRail();
    setFocus(9);
    expect(state.focus).toBe(4);
    expect(document.querySelectorAll('#railTrack .card.focus').length).toBe(1);
    setFocus(-3);
    expect(state.focus).toBe(0);
  });
});

describe('收藏 / 刷新 / 启动', () => {
  it('收藏立即生效，落盘失败则回滚并提示', async () => {
    state.games = [game('a', { favorite: false })];
    renderRail();
    H.setFavorite.mockRejectedValueOnce(new Error('写库失败'));
    toggleFav('a');
    expect(state.games[0].favorite).toBe(true);
    await vi.waitFor(() => expect(state.games[0].favorite).toBe(false));
    expect(allToasts()).toContain('收藏保存失败');
  });

  it('refreshLibrary：剔除已消失的勾选，失败会提示并抛给调用方', async () => {
    state.games = [game('a'), game('b')];
    state.gridSel.add('b');
    H.getLibrary.mockResolvedValueOnce([game('a')]);
    await refreshLibrary();
    expect(state.games.map((g) => g.id)).toEqual(['a']);
    expect([...state.gridSel]).toEqual([]);

    H.getLibrary.mockRejectedValueOnce(new Error('读取失败'));
    await expect(refreshLibrary()).rejects.toThrow('读取失败');
    expect(state.games.map((g) => g.id)).toEqual(['a']);
    expect(allToasts()).toContain('刷新库失败');
  });

  it('缩略图回填只换封面，不重建卡片', async () => {
    state.games = [game('a'), game('b')];
    renderRail();
    const first = document.querySelector('#railTrack .card[data-i="0"]')!;
    expect(first.querySelector('.art.has-img')).toBeNull();

    // 后台缩略图完成：同 id、同结构，只有 thumb 变了
    H.getLibrary.mockResolvedValueOnce([
      game('a', { thumb: 'C:/thumbs/a.webp' }),
      game('b', { thumb: 'C:/thumbs/b.webp' }),
    ]);
    await refreshLibrary();
    // 卡片节点原样保留（整屏重建会换掉它并重播入场）
    expect(document.querySelector('#railTrack .card[data-i="0"]')).toBe(first);
    expect(state.games[0].thumb).toBe('C:/thumbs/a.webp');
    await vi.waitFor(() =>
      expect(first.querySelector('.art img')?.getAttribute('src')).toBe('asset://C:/thumbs/a.webp'),
    );
  });

  it('结构有变化时仍走整屏重建（新增作品不会被增量路径吞掉）', async () => {
    state.games = [game('a')];
    renderRail();
    const first = document.querySelector('#railTrack .card[data-i="0"]')!;
    H.getLibrary.mockResolvedValueOnce([game('a'), game('b')]);
    await refreshLibrary();
    expect(state.games.map((g) => g.id)).toEqual(['a', 'b']);
    expect(document.querySelector('#railTrack .card[data-i="0"]')).not.toBe(first);
    expect(document.querySelectorAll('#railTrack .card').length).toBe(2);
  });

  it('启动：运行中不重复拉起，IPC 失败转成提示', async () => {
    state.games = [game('a')];
    renderRail();
    state.running = 'a';
    await doLaunch();
    expect(H.launchGame).not.toHaveBeenCalled();

    state.running = null;
    H.launchGame.mockRejectedValueOnce({ message: '路径失效' });
    await doLaunch();
    expect(allToasts()).toContain('路径失效');
  });

  it('启动成功后再点一次不会重复调用', async () => {
    state.games = [game('a')];
    renderRail();
    await doLaunch();
    state.running = 'a';
    await doLaunch();
    expect(H.launchGame).toHaveBeenCalledTimes(1);
    expect(H.launchGame).toHaveBeenCalledWith('a');
  });
});

describe('详情入口', () => {
  it('同作品重进立即切屏；换作品时等背景备齐再切', async () => {
    state.games = [game('a'), game('b')];
    renderRail();
    state.detailId = 'a';
    openDetail('a');
    expect(state.screen).toBe('detail');

    state.screen = 'library';
    state.detailId = 'a';
    H.detailBackground.mockResolvedValueOnce(null);
    openDetail('b');
    await vi.waitFor(() => expect(state.screen).toBe('detail'));
    expect(state.detailId).toBe('b');
  });

  it('轨道打开详情：先按一下焦点卡，110ms 后才切屏', async () => {
    state.games = [game('a'), game('b'), game('c')];
    state.focus = 1;
    renderRail();
    openDetailFromRail('b');
    expect(document.querySelector('#railTrack .card[data-i="1"]')!.classList.contains('press')).toBe(true);
    await vi.waitFor(() => expect(state.screen).toBe('detail'), { timeout: 500 });
    expect(state.detailId).toBe('b');
  });

  it('110ms 内焦点被拨走：这次切屏作废', async () => {
    state.games = [game('a'), game('b'), game('c')];
    state.focus = 1;
    renderRail();
    openDetailFromRail('b');
    state.focus = 2;
    await new Promise((r) => window.setTimeout(r, 200));
    expect(state.screen).toBe('library');
  });
});

describe('导航与快捷键', () => {
  it('accept：常规启动游戏；多选态改为勾选', async () => {
    state.games = [game('a'), game('b')];
    renderRail();
    dispatchNav({ intent: 'accept' });
    await vi.waitFor(() => expect(H.launchGame).toHaveBeenCalledWith('a'));

    state.gridMulti = true;
    dispatchNav({ intent: 'accept' });
    expect([...state.gridSel]).toEqual(['a']);
    expect(H.launchGame).toHaveBeenCalledTimes(1);
  });

  it('back：多选态先退出多选，不切屏', () => {
    state.games = [game('a')];
    state.gridMulti = true;
    dispatchNav({ intent: 'back' });
    expect(state.gridMulti).toBe(false);
    expect(state.screen).toBe('library');
  });

  it('move：经典左右逐张，down 进网格并带上当前焦点', async () => {
    state.games = [game('a'), game('b'), game('c')];
    renderRail();
    dispatchNav({ intent: 'move', dir: 'right' });
    expect(state.focus).toBe(1);
    dispatchNav({ intent: 'move', dir: 'up' }); // 经典：上键无语义
    expect(state.focus).toBe(1);
    state.focus = 2;
    dispatchNav({ intent: 'move', dir: 'down' });
    await vi.waitFor(() => expect(state.screen).toBe('grid'));
    expect(state.gridFocus).toBe(2);
  });

  it('move：列表上下逐行；海报墙左右逐张、上下整排', () => {
    applyLayout('list', false);
    state.games = [game('a'), game('b'), game('c')];
    renderRail();
    dispatchNav({ intent: 'move', dir: 'down' });
    expect(state.focus).toBe(1);
    dispatchNav({ intent: 'move', dir: 'left' }); // 列表不横向移动
    expect(state.focus).toBe(1);

    applyLayout('wall', false);
    state.games = Array.from({ length: 8 }, (_, i) => game(`w${i}`));
    state.focus = 0;
    renderRail();
    dispatchNav({ intent: 'move', dir: 'down' });
    expect(state.focus).toBe(6); // 6 列整排
    dispatchNav({ intent: 'move', dir: 'right' });
    expect(state.focus).toBe(7);
  });

  it('Home / End / PageUp / PageDown 跳首尾与翻屏', () => {
    state.games = Array.from({ length: 10 }, (_, i) => game(`g${i}`));
    renderRail();
    window.dispatchEvent(key('End'));
    expect(state.focus).toBe(9);
    window.dispatchEvent(key('Home'));
    expect(state.focus).toBe(0);
    window.dispatchEvent(key('PageDown'));
    expect(state.focus).toBe(6);
    window.dispatchEvent(key('PageUp'));
    expect(state.focus).toBe(0);
  });

  it('X 键：无多选进多选，有选中开批量菜单，运行中结束游戏', async () => {
    state.games = [game('a'), game('b')];
    renderRail();
    window.dispatchEvent(key('KeyX'));
    expect(state.gridMulti).toBe(true);

    state.gridSel.add('a');
    window.dispatchEvent(key('KeyX'));
    await vi.waitFor(() => expect(document.getElementById('qmenu')!.classList.contains('show')).toBe(true));

    hideStates();
    state.gridMulti = false;
    state.running = 'a';
    H.stopGame.mockRejectedValueOnce({ message: '结束失败' });
    window.dispatchEvent(key('KeyX'));
    await vi.waitFor(() => expect(H.stopGame).toHaveBeenCalledWith('a'));
    await vi.waitFor(() => expect(allToasts()).toContain('结束失败'));
  });

  it('M / Esc / R / Y 的库屏语义', async () => {
    state.games = [game('a'), game('b'), game('c')];
    renderRail();
    window.dispatchEvent(key('KeyM'));
    expect(state.gridMulti).toBe(true);
    window.dispatchEvent(key('Escape'));
    expect(state.gridMulti).toBe(false);

    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99);
    state.focus = 0;
    window.dispatchEvent(key('KeyR'));
    expect(state.focus).toBe(2);
    expect(allToasts()).toContain('随机');

    state.focus = 1;
    window.dispatchEvent(key('KeyY'));
    await vi.waitFor(() => expect(state.screen).toBe('detail'), { timeout: 500 });
    expect(state.detailId).toBe('b');
  });

  it('多选变化只同步勾选标记，不重建轨道', () => {
    state.games = [game('a')];
    renderRail();
    const card = document.querySelector('#railTrack .card');
    window.dispatchEvent(new Event('multi-change'));
    expect(document.querySelector('#railTrack .card')).toBe(card);
    expect(document.querySelectorAll('#railTrack .card').length).toBe(1);
  });

  it('操作条按钮：退出多选 / 批量操作', async () => {
    state.games = [game('a')];
    renderRail();
    state.gridMulti = true;
    document.getElementById('lselExit')!.click();
    expect(state.gridMulti).toBe(false);
    state.gridMulti = true;
    state.gridSel.add('a');
    document.getElementById('lselAct')!.click();
    await vi.waitFor(() => expect(document.getElementById('qmenu')!.classList.contains('show')).toBe(true));
  });
});

describe('运行事件与输入设备兜底', () => {
  it('game://started 拉起运行态与启动层，game://exited 收尾并刷新库', async () => {
    state.games = [game('a', { title: 'A' }), game('b')];
    renderRail();
    const started = H.events.get('game://started')!;
    started('a');
    await vi.waitFor(() => expect(state.running).toBe('a'));
    expect(document.getElementById('launchLayer')!.classList.contains('on')).toBe(true);
    await vi.waitFor(() => expect(document.getElementById('llStatus')!.textContent).toBe('游戏运行中'));

    H.getLibrary.mockResolvedValueOnce([game('a', { title: 'A' }), game('b')]);
    const exited = H.events.get('game://exited')!;
    exited({ id: 'a', code: 3 });
    await vi.waitFor(() => expect(state.running).toBeNull());
    expect(document.getElementById('launchLayer')!.classList.contains('on')).toBe(false);
    expect(allToasts()).toContain('已退出');
    await vi.waitFor(() => expect(H.getLibrary).toHaveBeenCalled());
  });

  it('手柄 X 不再进多选（提示按 Select），Select 切换多选', async () => {
    state.games = [game('a'), game('b')];
    renderRail();
    dispatchNav({ intent: 'actionX' });
    expect(state.gridMulti).toBe(false);
    expect(allToasts()).toContain('多选请按 Select');

    await vi.waitFor(() => expect(H.events.has('pad://button')).toBe(true));
    const btn = H.events.get('pad://button')!;
    btn({ button: 'select' });
    expect(state.gridMulti).toBe(true);
    btn({ button: 'select' });
    expect(state.gridMulti).toBe(false);
  });

  it('首次用手柄启动游戏时提示 Start+Select 回书架，且只提示一次', async () => {
    state.games = [game('a')];
    state.padInfo = { name: 'Xbox Wireless Controller', kind: 'xbox' as const, power: 'full', ff: true };
    localStorage.removeItem('stash.padHomeHint');
    renderRail();
    const started = H.events.get('game://started')!;
    started('a');
    await vi.waitFor(() => expect(allToasts()).toContain('长按 Start+Select 1.2 秒可结束游戏并回书架'));

    H.toast.mockClear();
    const exited = H.events.get('game://exited')!;
    exited({ id: 'a', code: 0 });
    await vi.waitFor(() => expect(state.running).toBeNull());
    started('a');
    await new Promise((r) => setTimeout(r, 10));
    expect(allToasts()).not.toContain('长按 Start+Select 1.2 秒可结束游戏并回书架');
    localStorage.removeItem('stash.padHomeHint');
    exited({ id: 'a', code: 0 });
    await vi.waitFor(() => expect(state.running).toBeNull());
  });

  it('stage-resize 按新视口重算轨道位移', () => {
    state.games = [game('a'), game('b')];
    renderRail();
    document.getElementById('app')!.classList.add('resized');
    window.dispatchEvent(new Event('stage-resize'));
    expect(document.getElementById('railTrack')!.style.transform).toMatch(/^translateX\(/);
  });

  it('滚轮：经典布局逐张拨动，小增量累计、面板打开时不响应', () => {
    state.games = [game('a'), game('b'), game('c')];
    renderRail();
    const ev = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
    window.dispatchEvent(ev);
    expect(state.focus).toBe(1);
    expect(ev.defaultPrevented).toBe(true);

    state.focus = 0;
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, cancelable: true }));
    expect(state.focus).toBe(0); // 未到 40px 阈值

    showEmpty('empty');
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    expect(state.focus).toBe(0);
  });

  it('触摸横扫：拖动后按位移换算步数，轻点只回正', () => {
    state.games = [game('a'), game('b'), game('c')];
    renderRail();
    const track = document.getElementById('railTrack')!;
    const fire = (type: string, x: number, pointerId = 1): void => {
      const ev = new Event(type) as Event & { pointerId: number; pointerType: string; clientX: number };
      ev.pointerId = pointerId;
      ev.pointerType = 'touch';
      ev.clientX = x;
      track.dispatchEvent(ev);
    };
    state.focus = 1;
    fire('pointerdown', 300);
    fire('pointermove', 250);
    fire('pointerup', 120); // dx = -180 → 向右拨一张
    expect(state.focus).toBe(2);

    state.focus = 1;
    fire('pointerdown', 300);
    fire('pointerup', 295); // 位移 ≤ 10：轻点，不改焦点
    expect(state.focus).toBe(1);
  });
});

describe('网格渲染兜底', () => {
  it('renderGrid 按筛选重建单元格，空结果给「无结果」态', () => {
    state.games = [game('a', { lastPlayed: 100 }), game('b')];
    state.screen = 'grid';
    state.gridFilter = 'playing';
    renderGrid();
    const cells = document.querySelectorAll<HTMLElement>('#gridCards .gcell');
    expect(cells.length).toBe(1);
    state.gridFilter = 'done';
    renderGrid();
    expect(document.querySelectorAll('#gridCards .gcell').length).toBe(0);
    expect(document.getElementById('emptyState')!.classList.contains('show')).toBe(true);
  });

  it('多选开关只切换勾选态，不重建网格（卡片节点保留）', () => {
    initGrid();
    state.games = [game('a'), game('b')];
    state.screen = 'grid';
    renderGrid();
    const cell = document.querySelector<HTMLElement>('#gridCards .gcell')!;
    setMulti(true);
    expect(document.querySelector('#gridCards .gcell')).toBe(cell);
    expect(document.getElementById('gselBar')!.hidden).toBe(false);
    toggleSel('a');
    expect(cell.classList.contains('sel')).toBe(true);
    setMulti(false);
    expect(document.getElementById('gselBar')!.hidden).toBe(true);
    expect(cell.classList.contains('sel')).toBe(false);
  });
});

describe('刷新防抖（B1）', () => {
  it('连续 5 次 scheduleLibraryRefresh 只触发一次全库 IPC', async () => {
    vi.useFakeTimers();
    try {
      H.getLibrary.mockClear();
      for (let i = 0; i < 5; i++) scheduleLibraryRefresh();
      expect(H.getLibrary).not.toHaveBeenCalled(); // 300ms 内都在攒着
      await vi.advanceTimersByTimeAsync(300);
      expect(H.getLibrary).toHaveBeenCalledTimes(1);
      // 让这次刷新后面的重绘走完，避免残留微任务串到别的用例
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('网格索引（B6）', () => {
  it('1000 部：单元格数量与首尾卡片的 data-g 索引正确', () => {
    state.games = Array.from({ length: 1000 }, (_, i) => game(`g${i}`));
    state.gridFilter = 'all';
    state.screen = 'grid';
    renderGrid();
    const cells = document.querySelectorAll<HTMLElement>('#gridCards .gcell');
    expect(cells.length).toBe(1000);
    expect(cells[0].dataset.id).toBe('g0');
    expect(cells[0].dataset.g).toBe('0');
    expect(cells[999].dataset.id).toBe('g999');
    expect(cells[999].dataset.g).toBe('999');
    // 点击末尾卡片：焦点落到 999，回查的仍是 all[999]
    cells[999].click();
    expect(state.gridFocus).toBe(999);
  });

  it('筛选后的 data-g 仍是轨道位置（按 id 映射，不按筛选后下标）', () => {
    state.games = Array.from({ length: 1000 }, (_, i) => game(`g${i}`));
    state.games[999].favorite = true;
    state.gridFilter = 'fav';
    state.screen = 'grid';
    renderGrid();
    const cells = document.querySelectorAll<HTMLElement>('#gridCards .gcell');
    expect(cells.length).toBe(1);
    expect(cells[0].dataset.id).toBe('g999');
    expect(cells[0].dataset.i).toBe('0'); // 筛选后第 0 个
    expect(cells[0].dataset.g).toBe('999'); // 但轨道里是第 999 个
  });
});

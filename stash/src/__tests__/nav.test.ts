// @vitest-environment happy-dom
/** 导航分发状态机：快捷菜单优先 → 状态层拦截 → 屏幕 handler。
 *  覆盖手柄合成键、Y/LB/RB 分屏语义、四屏直切守卫与 Esc 只退一层。 */

import { beforeEach, describe, expect, it, vi, beforeAll } from 'vitest';
import type { NavIntent } from '../types';
import { game, key, mountSkeleton, resetState } from './dom-skeleton';
import { curScreen, dispatchNav, init, registerHandler } from '../nav';
import { padKindOf } from '../padmap';
import { setScreen, state } from '../state';
import { emptyShown, filterShown, hideStates, openSearch, searchShown } from '../overlay';
import { handleQuickKey, quickShown, toggleQuickMenu } from '../quick';
import { cycleFilter } from '../screens/grid';
import { showDetailArtFor } from '../screens/library';

vi.mock('../ipc', () => ({
  onEvent: vi.fn(async () => () => {}),
  padStatus: vi.fn(async () => ({ connected: false, name: '' })),
  asset: vi.fn(async (p: string) => p),
  deleteShot: vi.fn(async () => [] as string[]),
  updateEndings: vi.fn(async () => 0),
  updateSettings: vi.fn(async () => undefined),
}));

vi.mock('../quick', () => ({
  handleQuickKey: vi.fn(() => false),
  quickShown: vi.fn(() => false),
  toggleQuickMenu: vi.fn(async () => undefined),
}));

vi.mock('../screens/grid', () => ({ cycleFilter: vi.fn(), renderGrid: vi.fn(), setFilter: vi.fn() }));
vi.mock('../screens/library', () => ({ renderRail: vi.fn(), openDetail: vi.fn(), showDetailArtFor: vi.fn() }));
vi.mock('../screens/detail', () => ({ renderDetail: vi.fn() }));
vi.mock('../screens/settings', () => ({
  addManualGame: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mountSkeleton();
  resetState();
  vi.mocked(handleQuickKey).mockReturnValue(false);
  vi.mocked(quickShown).mockReturnValue(false);
});

describe('分发基础', () => {
  it('curScreen 读当前点亮的屏，未注册的屏静默忽略', () => {
    expect(curScreen()).toBe('library');
    setScreen('settings');
    expect(curScreen()).toBe('settings');
    expect(() => dispatchNav({ intent: 'move', dir: 'down' })).not.toThrow();
  });

  it('方向 / 确认 / 返回送到当前屏 handler', () => {
    const seen: NavIntent[] = [];
    setScreen('grid');
    registerHandler('grid', (n) => seen.push(n));
    dispatchNav({ intent: 'move', dir: 'down' });
    dispatchNav({ intent: 'accept' });
    dispatchNav({ intent: 'back' });
    expect(seen).toEqual([
      { intent: 'move', dir: 'down' },
      { intent: 'accept' },
      { intent: 'back' },
    ]);
  });

  it('状态层打开时方向键不落到底层屏幕', () => {
    state.games = [game('a'), game('b')];
    const seen: NavIntent[] = [];
    registerHandler('library', (n) => seen.push(n));
    openSearch();
    dispatchNav({ intent: 'move', dir: 'down' });
    expect(seen).toEqual([]);
    // 搜索面板自己消费了方向键（第一条候选被选中）
    expect(document.querySelectorAll('#spList .sp-item.on').length).toBe(1);
  });

  it('快捷菜单消费掉的按键不再给屏幕', () => {
    const seen: NavIntent[] = [];
    registerHandler('library', (n) => seen.push(n));
    vi.mocked(handleQuickKey).mockReturnValue(true);
    dispatchNav({ intent: 'accept' });
    expect(seen).toEqual([]);
  });

  it('菜单开着但 handleQuickKey 不认的键也不能穿透到屏幕', () => {
    const seen: NavIntent[] = [];
    registerHandler('library', (n) => seen.push(n));
    vi.mocked(quickShown).mockReturnValue(true);
    dispatchNav({ intent: 'accept' });
    dispatchNav({ intent: 'move', dir: 'right' });
    expect(seen).toEqual([]);
  });

  it('菜单键：状态层开着不叠菜单，菜单开着则关闭', () => {
    openSearch();
    dispatchNav({ intent: 'menu' });
    expect(toggleQuickMenu).not.toHaveBeenCalled();
    hideStates();
    dispatchNav({ intent: 'menu' });
    expect(toggleQuickMenu).toHaveBeenCalledTimes(1);
    vi.mocked(quickShown).mockReturnValue(true);
    dispatchNav({ intent: 'menu' });
    expect(toggleQuickMenu).toHaveBeenCalledTimes(2);
  });

  it('Esc 一次只退一层：先关状态层，再才回屏幕', () => {
    const seen: NavIntent[] = [];
    registerHandler('library', (n) => seen.push(n));
    openSearch();
    dispatchNav({ intent: 'back' });
    expect(searchShown()).toBe(false);
    expect(seen).toEqual([]);
    dispatchNav({ intent: 'back' });
    expect(seen).toEqual([{ intent: 'back' }]);
  });
});

describe('分屏语义键', () => {
  it('Y：网格开筛选，库屏投递 KeyY 给屏幕自己处理', () => {
    setScreen('grid');
    dispatchNav({ intent: 'actionY' });
    expect(filterShown()).toBe(true);
    hideStates();
    setScreen('library');
    const codes: string[] = [];
    const onKey = (e: KeyboardEvent): void => {
      codes.push(e.code);
    };
    window.addEventListener('keydown', onKey);
    dispatchNav({ intent: 'actionY' });
    window.removeEventListener('keydown', onKey);
    expect(codes).toEqual(['KeyY']);
  });

  it('X：状态层开着时不投递合成键', () => {
    openSearch();
    const codes: string[] = [];
    const onKey = (e: KeyboardEvent): void => {
      codes.push(e.code);
    };
    window.addEventListener('keydown', onKey);
    dispatchNav({ intent: 'actionX' });
    window.removeEventListener('keydown', onKey);
    expect(codes).toEqual([]);
  });

  it('LB / RB：只在网格切分类，库与设置屏不响应，也绝不切屏', async () => {
    setScreen('grid');
    dispatchNav({ intent: 'actionL' });
    await vi.waitFor(() => expect(cycleFilter).toHaveBeenCalledWith(-1));
    dispatchNav({ intent: 'actionR' });
    await vi.waitFor(() => expect(cycleFilter).toHaveBeenCalledWith(1));
    expect(state.screen).toBe('grid');
    setScreen('settings');
    dispatchNav({ intent: 'actionL' });
    dispatchNav({ intent: 'actionR' });
    expect(state.screen).toBe('settings');
    expect(cycleFilter).toHaveBeenCalledTimes(2);
  });

  it('RB 在详情屏 = 收藏（投递 KeyR）', () => {
    setScreen('detail');
    const codes: string[] = [];
    const onKey = (e: KeyboardEvent): void => {
      codes.push(e.code);
    };
    window.addEventListener('keydown', onKey);
    dispatchNav({ intent: 'actionR' });
    window.removeEventListener('keydown', onKey);
    expect(codes).toEqual(['KeyR']);
  });

  it('switchView 只在库 ⇄ 网格之间切，其他屏原地不动', () => {
    dispatchNav({ intent: 'switchView' });
    expect(state.screen).toBe('grid');
    dispatchNav({ intent: 'switchView' });
    expect(state.screen).toBe('library');
    setScreen('detail');
    dispatchNav({ intent: 'switchView' });
    expect(state.screen).toBe('detail');
    setScreen('settings');
    dispatchNav({ intent: 'switchView' });
    expect(state.screen).toBe('settings');
  });
});

describe('手柄型号识别', () => {
  it('按名称归类为 Xbox / PlayStation / Nintendo，未知回落 Xbox', () => {
    expect(padKindOf('Xbox Wireless Controller')).toBe('xbox');
    expect(padKindOf('DualSense Wireless Controller')).toBe('playstation');
    expect(padKindOf('Sony DualShock 4')).toBe('playstation');
    expect(padKindOf('Pro Controller')).toBe('nintendo');
    expect(padKindOf('Joy-Con (L)')).toBe('nintendo');
    expect(padKindOf('')).toBe('xbox');
  });
});

describe('全局键盘入口（init）', () => {
  beforeAll(() => {
    init();
  });

  it('数字 2/4 直切网格与设置', () => {
    const two = key('Digit2');
    window.dispatchEvent(two);
    expect(state.screen).toBe('grid');
    expect(two.defaultPrevented).toBe(true);
    window.dispatchEvent(key('Digit4'));
    expect(state.screen).toBe('settings');
  });

  it('数字 3：无详情 / 详情已隐藏时不放行，正常作品才切详情并预热背景', async () => {
    state.games = [game('a'), game('h', { hidden: true })];
    state.detailId = null;
    window.dispatchEvent(key('Digit3'));
    expect(state.screen).toBe('library');
    state.detailId = 'h';
    window.dispatchEvent(key('Digit3'));
    expect(state.screen).toBe('library');
    state.detailId = 'a';
    window.dispatchEvent(key('Digit3'));
    expect(state.screen).toBe('detail');
    await vi.waitFor(() => expect(showDetailArtFor).toHaveBeenCalledWith('a'));
  });

  it('/ 开搜索，Esc 只关面板不退屏', () => {
    setScreen('detail');
    window.dispatchEvent(key('Slash'));
    expect(searchShown()).toBe(true);
    window.dispatchEvent(key('Escape'));
    expect(searchShown()).toBe(false);
    expect(state.screen).toBe('detail');
  });

  it('F1 与 ? 打开快捷键总览', () => {
    window.dispatchEvent(key('F1'));
    expect(document.getElementById('helpPanel')?.classList.contains('show')).toBe(true);
    hideStates();
    window.dispatchEvent(key('Slash', { shiftKey: true }));
    expect(document.getElementById('helpPanel')?.classList.contains('show')).toBe(true);
  });

  it('数字 5 开空态；状态层开着时数字键不切屏，Esc 关掉后才生效', () => {
    window.dispatchEvent(key('Digit5'));
    expect(emptyShown()).toBe(true);
    window.dispatchEvent(key('Digit4'));
    expect(state.screen).toBe('library');
    window.dispatchEvent(key('Escape'));
    expect(emptyShown()).toBe(false);
    window.dispatchEvent(key('Digit4'));
    expect(state.screen).toBe('settings');
  });

  it('菜单键（ContextMenu）走同一入口开快捷菜单', () => {
    window.dispatchEvent(key('ContextMenu'));
    expect(toggleQuickMenu).toHaveBeenCalled();
  });

  it('F 只在库 / 网格生效，从库屏打开筛选会先切到网格', () => {
    window.dispatchEvent(key('KeyF'));
    expect(state.screen).toBe('grid');
    expect(filterShown()).toBe(true);
    hideStates();
    setScreen('detail');
    window.dispatchEvent(key('KeyF'));
    expect(filterShown()).toBe(false);
  });

  it('按住不放的键盘连发（repeat）不算新的一次确认', () => {
    hideStates();
    const seen: NavIntent[] = [];
    setScreen('grid');
    registerHandler('grid', (n) => seen.push(n));
    window.dispatchEvent(key('Enter', { repeat: true }));
    expect(seen).toHaveLength(0);
    window.dispatchEvent(key('Enter'));
    expect(seen).toHaveLength(1);
  });
});

describe('同一按键的双通道投递', () => {
  it('手柄与键盘在同一瞬间各投递一次 accept：只生效一次', () => {
    const seen: NavIntent[] = [];
    setScreen('grid');
    registerHandler('grid', (n) => seen.push(n));
    dispatchNav({ intent: 'accept' }, 'pad');
    dispatchNav({ intent: 'accept' }, 'key');
    expect(seen).toEqual([{ intent: 'accept' }]);
  });

  it('同一通道连按两次仍然各自生效（去重只拦跨通道）', async () => {
    // 等过去重窗口，避免受上一条用例留下的时间戳影响
    await new Promise((r) => setTimeout(r, 200));
    const seen: NavIntent[] = [];
    setScreen('grid');
    registerHandler('grid', (n) => seen.push(n));
    dispatchNav({ intent: 'accept' }, 'pad');
    dispatchNav({ intent: 'accept' }, 'pad');
    expect(seen).toHaveLength(2);
  });
});

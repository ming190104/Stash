// @vitest-environment happy-dom
/** 键鼠适配：经典轨道滚轮拨卡、Home/End/PgUp/PgDn 跳转、点暗底关闭浮层。
 *  键盘 / 手柄原有语义不在这里重复覆盖（nav.test 已覆盖分发），
 *  这里只守护本轮新增的桌面输入路径。 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { game, key, mountSkeleton, resetState } from './dom-skeleton';
import { setScreen, state } from '../state';
import { initLibrary } from '../screens/library';
import { initGrid } from '../screens/grid';
import { filterShown, handleOverlayKey, initOverlay, openFilter, openSearch, searchShown } from '../overlay';
import { promptConfirm, promptInput } from '../prompt';
import { clickable, ringFocus } from '../ui';

vi.mock('../ipc', () => ({
  asset: vi.fn(async (p: string) => p),
  onEvent: vi.fn(async () => () => {}),
  padStatus: vi.fn(async () => ({ connected: false, name: '' })),
  getLibrary: vi.fn(async () => []),
  getSettings: vi.fn(async () => null),
  launchGame: vi.fn(async () => undefined),
  stopGame: vi.fn(async () => undefined),
  setFavorite: vi.fn(async () => undefined),
  detailBackground: vi.fn(async () => null),
  deleteShot: vi.fn(async () => [] as string[]),
  updateEndings: vi.fn(async () => 0),
  updateSettings: vi.fn(async () => undefined),
}));

// 依赖 handler 注册的屏幕初始化只需一次；DOM 相关的 overlay 接线每个用例重挂
beforeAll(() => {
  initLibrary();
  initGrid();
});

beforeEach(() => {
  mountSkeleton();
  resetState();
  state.games = Array.from({ length: 20 }, (_, i) => game(`g${i}`, { title: `作品 ${i}`, addedAt: i }));
  state.screen = 'library';
  initOverlay();
});

const wheel = (deltaY: number): WheelEvent => new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });

describe('鼠标', () => {
  it('经典轨道：滚轮一格拨一张（小增量先累计）', async () => {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    state.focus = 3;
    await sleep(80); // 越过 70ms 限速窗口
    window.dispatchEvent(wheel(120));
    expect(state.focus).toBe(4);
    // 触控板的小增量不足 40px 时不动，累计够了才走一张
    await sleep(80);
    window.dispatchEvent(wheel(20));
    expect(state.focus).toBe(4);
    window.dispatchEvent(wheel(30));
    expect(state.focus).toBe(5);
  });

  it('点面板暗底关闭，点面板内容不关闭', () => {
    openSearch();
    const panel = document.getElementById('searchPanel')!;
    panel.querySelector('#spList')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(searchShown()).toBe(true);
    panel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(searchShown()).toBe(false);
  });

  it('筛选面板同样支持点暗底关闭', () => {
    openFilter();
    expect(filterShown()).toBe(true);
    document.getElementById('filterPanel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(filterShown()).toBe(false);
  });

  it('输入弹层点暗底 = 取消（Promise 以 null 结束）', async () => {
    const p = promptInput({ title: '重命名' });
    const layer = document.getElementById('promptLayer')!;
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it('确认弹层不显示输入框，点确定返回 true、取消返回 false', async () => {
    const p1 = promptConfirm({ title: '移除出库' });
    const layer = document.getElementById('promptLayer')!;
    const inp = layer.querySelector('#pInput') as HTMLTextAreaElement;
    expect(inp.style.display).toBe('none');
    (layer.querySelector('#pOk') as HTMLElement).click();
    await expect(p1).resolves.toBe(true);

    const p2 = promptConfirm({ title: '移除出库' });
    (layer.querySelector('#pCancel') as HTMLElement).click();
    await expect(p2).resolves.toBe(false);
    // 后续普通输入弹层要恢复输入框
    void promptInput({ title: '重命名' });
    expect(inp.style.display).toBe('');
    (document.getElementById('pCancel') as HTMLElement).click();
  });
});

describe('键盘跳转', () => {
  it('搜索面板：←/→ 切换排序，排序条焦点跟随', () => {
    openSearch();
    const before = state.sortBy;
    expect(handleOverlayKey(key('ArrowRight'))).toBe(true);
    expect(state.sortBy).not.toBe(before);
    const chips = [...document.querySelectorAll<HTMLElement>('#spSort b')];
    expect(chips.findIndex((b) => b.classList.contains('focus'))).toBeGreaterThanOrEqual(0);
  });

  it('库屏：Home / End / PageUp / PageDown', () => {
    state.focus = 5;
    window.dispatchEvent(key('Home'));
    expect(state.focus).toBe(0);
    window.dispatchEvent(key('End'));
    expect(state.focus).toBe(19);
    window.dispatchEvent(key('PageUp'));
    expect(state.focus).toBe(13);
    window.dispatchEvent(key('PageDown'));
    expect(state.focus).toBe(19);
  });

  it('网格：Home / End / PageUp / PageDown 走 gridFocus', () => {
    setScreen('grid');
    state.gridFocus = 5;
    window.dispatchEvent(key('Home'));
    expect(state.gridFocus).toBe(0);
    window.dispatchEvent(key('End'));
    expect(state.gridFocus).toBe(19);
    window.dispatchEvent(key('PageUp'));
    expect(state.gridFocus).toBe(7);
    window.dispatchEvent(key('PageDown'));
    expect(state.gridFocus).toBe(19);
  });
});

describe('可点元素的无障碍语义', () => {
  it('ringFocus 同步 DOM 焦点，让手柄焦点环与键盘焦点一致', () => {
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.scrollIntoView = vi.fn();
    second.scrollIntoView = vi.fn();
    document.body.append(first, second);

    expect(ringFocus([first, second], 1)).toBe(1);
    expect(document.activeElement).toBe(second);
    expect(second.classList.contains('focus')).toBe(true);
  });

  it('div/span 补 role=button + tabindex，Enter / 空格触发 click 且不冒泡到全局按键', () => {
    const el = document.createElement('span');
    document.body.appendChild(el);
    const click = vi.fn();
    el.addEventListener('click', click);
    clickable(el);

    expect(el.getAttribute('role')).toBe('button');
    expect(el.tabIndex).toBe(0);
    // 已有 role/tabindex 不被覆盖
    const custom = document.createElement('div');
    custom.setAttribute('role', 'menuitem');
    custom.tabIndex = -1;
    clickable(custom);
    expect(custom.getAttribute('role')).toBe('menuitem');
    expect(custom.tabIndex).toBe(-1);

    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(2);
    // Enter / 空格被元素消费，不再冒泡到全局按键
    expect(bubbled).not.toHaveBeenCalled();
    // 普通字母键不触发 click，照常冒泡
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(2);
    expect(bubbled).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', bubbled);
  });
});

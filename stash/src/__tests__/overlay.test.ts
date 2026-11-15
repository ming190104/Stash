// @vitest-environment happy-dom
/** 状态层（overlay）DOM 行为：单例互斥、搜索 / 筛选 / 结局的按键守卫与异步回填。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { game, key, mountSkeleton, resetState } from './dom-skeleton';
import { updateEndings } from '../ipc';
import {
  anyState,
  emptyShown,
  filterShown,
  handleOverlayKey,
  hideStates,
  launchShown,
  modalState,
  openEndings,
  openFilter,
  openHelp,
  openSearch,
  renderSearch,
  searchList,
  searchShown,
  showEmpty,
  showLoading,
  showState,
} from '../overlay';
import { state } from '../state';
import { renderGrid, setFilter } from '../screens/grid';

vi.mock('../ipc', () => ({
  updateEndings: vi.fn(async () => 0),
  updateSettings: vi.fn(async () => undefined),
}));

vi.mock('../screens/grid', () => ({ renderGrid: vi.fn(), setFilter: vi.fn(), cycleFilter: vi.fn() }));
vi.mock('../screens/library', () => ({ renderRail: vi.fn(), openDetail: vi.fn(), showDetailArtFor: vi.fn(), refreshLibrary: vi.fn() }));
vi.mock('../screens/detail', () => ({ renderDetail: vi.fn() }));
vi.mock('../screens/settings', () => ({
  addManualGame: vi.fn(async () => undefined),
}));

const el = (id: string): HTMLElement => document.getElementById(id)!;

beforeEach(() => {
  vi.clearAllMocks();
  mountSkeleton();
  resetState();
  vi.mocked(updateEndings).mockResolvedValue(0);
});

describe('层单例与可见性', () => {
  it('任何一层打开前先关掉其余层', () => {
    openSearch();
    expect(searchShown()).toBe(true);
    expect(anyState()).toBe(true);
    openFilter();
    expect(searchShown()).toBe(false);
    expect(filterShown()).toBe(true);
    openHelp();
    expect(filterShown()).toBe(false);
    expect(anyState()).toBe(true);
    hideStates();
    expect(anyState()).toBe(false);
  });

  it('快捷菜单 / 输入弹层也计入 anyState', () => {
    el('qmenu').classList.add('show');
    expect(anyState()).toBe(true);
    expect(modalState()).toBe(true);
  });

  it('启动遮罩用 on，且不计入 modalState（游戏运行中仍可弹快捷菜单）', () => {
    el('launchLayer').classList.add('on');
    expect(launchShown()).toBe(true);
    expect(anyState()).toBe(true);
    expect(modalState()).toBe(false);
  });

  it('hideStates 主动失焦层内输入框，并清掉 qmenu 与搜索选中', () => {
    openSearch();
    const inp = el('spInput') as HTMLInputElement;
    inp.focus();
    expect(document.activeElement).toBe(inp);
    el('qmenu').classList.add('show');
    el('spList').innerHTML = '<div class="sp-item on"></div>';
    hideStates();
    expect(document.activeElement).not.toBe(inp);
    expect(el('qmenu').classList.contains('show')).toBe(false);
    expect(document.querySelector('#spList .sp-item.on')).toBeNull();
    expect(anyState()).toBe(false);
  });
});

describe('搜索 · 排序', () => {
  it('命中列表 / 纯符号查询视为无结果', () => {
    state.games = [game('a', { title: '千恋万花' }), game('b', { title: 'CLANNAD', developer: 'Key', year: 2004 })];
    state.query = 'clannad';
    expect(searchList().map((g) => g.id)).toEqual(['b']);
    openSearch();
    expect(document.querySelectorAll('#spList .sp-item').length).toBe(2);
    state.query = '千恋';
    renderSearch();
    expect(document.querySelectorAll('#spList .sp-item').length).toBe(1);
    expect(document.querySelector<HTMLElement>('#spList .sp-item')!.dataset.id).toBe('a');
    state.query = '***';
    renderSearch();
    expect(document.querySelectorAll('#spList .sp-item').length).toBe(0);
    expect(el('spList').textContent).toContain('没有匹配');
  });

  it('焦点在搜索框：Esc 关闭、Enter 选中候选并写入历史', () => {
    openSearch();
    const inp = el('spInput') as HTMLInputElement;
    const esc = key('Escape');
    inp.dispatchEvent(esc);
    expect(handleOverlayKey(esc)).toBe(true);
    expect(searchShown()).toBe(false);
    expect(esc.defaultPrevented).toBe(true);

    openSearch();
    const item = document.createElement('div');
    item.className = 'sp-item on';
    const click = vi.fn();
    item.addEventListener('click', click);
    el('spList').appendChild(item);
    state.query = 'miko';
    const enter = key('Enter');
    inp.dispatchEvent(enter);
    expect(handleOverlayKey(enter)).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('vnSearchHistory') ?? '[]')).toContain('miko');
  });

  it('历史词行末尾有「清空」，点掉后历史与 chips 一起消失', () => {
    state.games = [game('a', { title: '千恋万花' })];
    localStorage.setItem('vnSearchHistory', JSON.stringify(['千恋']));
    state.query = '';
    renderSearch();
    const clear = el('spList').querySelector<HTMLElement>('.sp-hclear');
    expect(clear).not.toBeNull();
    clear!.click();
    expect(localStorage.getItem('vnSearchHistory')).toBeNull();
    expect(el('spList').querySelector('.sp-hchip')).toBeNull();
  });

  it('搜索框失焦时 A / ↑↓ 仍由面板消费，不穿透到屏幕', () => {
    openSearch();
    el('spList').innerHTML = '<div class="sp-item"></div><div class="sp-item"></div>';
    const items = [...document.querySelectorAll<HTMLElement>('#spList .sp-item')];
    const click = vi.fn();
    items[0].addEventListener('click', click);
    const down = key('ArrowDown');
    expect(handleOverlayKey(down)).toBe(true);
    expect(document.querySelectorAll('#spList .sp-item.on').length).toBe(1);
    const enter = key('Enter');
    expect(handleOverlayKey(enter)).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(searchShown()).toBe(true); // 关闭由真实候选的 click 处理器负责，这里只验证按键被面板消费
  });
});

describe('筛选面板', () => {
  it('方向键移动焦点、A 应用集合、Esc 关闭并重建网格', async () => {
    state.games = [
      game('a', { tags: ['和风'], developer: 'Key', year: 2016 }),
      game('b', { tags: ['科幻'], developer: 'Leaf', year: 2012 }),
    ];
    openFilter();
    expect(filterShown()).toBe(true);
    expect(document.querySelectorAll('#fltCols .flt-opt').length).toBeGreaterThan(0);
    expect(handleOverlayKey(key('ArrowDown'))).toBe(true);
    const opts = [...document.querySelectorAll<HTMLElement>('#fltCols .flt-opts')[0].querySelectorAll('.flt-opt')];
    expect(opts[1].classList.contains('focus')).toBe(true);
    expect(handleOverlayKey(key('Enter'))).toBe(true);
    expect(state.collection).toBe('unplayed');
    await vi.waitFor(() => expect(renderGrid).toHaveBeenCalled());
    const esc = key('Escape');
    expect(handleOverlayKey(esc)).toBe(true);
    expect(filterShown()).toBe(false);
  });
});

describe('空态 / 加载 / 失败', () => {
  it('无结果空态说明筛选条件，A 触发「清除筛选」', async () => {
    state.games = [game('a', { tags: ['和风'] })];
    state.tagFilter = '和风';
    showEmpty('noresult');
    expect(emptyShown()).toBe(true);
    expect(el('emptyBody').textContent).toContain('没有符合条件的作品');
    expect(el('emptyBody').textContent).toContain('标签「和风」');
    expect(handleOverlayKey(key('Enter'))).toBe(true);
    await vi.waitFor(() => expect(setFilter).toHaveBeenCalledWith('all'));
    expect(state.tagFilter).toBeNull();
  });

  it('空库空态 A 触发添加游戏 exe', async () => {
    showEmpty('empty');
    expect(el('emptyBody').textContent).toContain('还没有任何作品');
    const add = el('emAdd');
    const click = vi.fn();
    add.addEventListener('click', click);
    expect(handleOverlayKey(key('Enter'))).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('加载说明就地更新，加载层与失败层互斥', () => {
    showLoading('正在重建缩略图');
    expect(el('skCap').textContent).toBe('正在重建缩略图');
    expect(el('loadingState').classList.contains('show')).toBe(true);
    showState('errorState');
    expect(el('loadingState').classList.contains('show')).toBe(false);
    const retry = document.querySelector<HTMLElement>('#errorState [data-state="retry"]')!;
    const click = vi.fn();
    retry.addEventListener('click', click);
    expect(handleOverlayKey(key('Enter'))).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('结局', () => {
  it('结局面板：Y 新增 END 1，A 勾选达成并串行落盘', async () => {
    state.games = [game('g', { endings: [], progress: 0 })];
    await openEndings('g');
    expect(handleOverlayKey(key('KeyY'))).toBe(true);
    expect(state.games[0].endings.map((e) => e.name)).toEqual(['END 1']);
    expect(document.querySelectorAll('#endList .end-row').length).toBe(1);
    expect(handleOverlayKey(key('Enter'))).toBe(true);
    expect(state.games[0].endings[0].done).toBe(true);
    await vi.waitFor(() => expect(updateEndings).toHaveBeenCalledWith('g', [{ name: 'END 1', done: true }]));
    expect(handleOverlayKey(key('KeyX'))).toBe(true);
    expect(state.games[0].endings).toEqual([]);
  });
});

describe('启动遮罩', () => {
  it('拦截所有按键，X 走遮罩上的结束按钮', () => {
    el('launchLayer').classList.add('on');
    const stop = vi.fn();
    el('llStop').addEventListener('click', stop);
    expect(handleOverlayKey(key('KeyX'))).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(handleOverlayKey(key('Enter'))).toBe(true);
    expect(handleOverlayKey(key('ArrowDown'))).toBe(true);
  });
});

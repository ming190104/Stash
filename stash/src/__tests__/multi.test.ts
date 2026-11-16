// @vitest-environment happy-dom
/** 多选与批量操作（multi.ts）：选中集刷新、进入/退出多选、四种批量动作的菜单文案与失败统计。
 *  批量最容易出错的地方是「一部失败拖垮整批」与「完成文案里的成功/失败数对不上」，因此逐条断言。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { game, mountSkeleton, resetState } from './dom-skeleton';
import { state } from '../state';
import { markSel, openBatch, setMulti, setMultiRefresh, toggleSel } from '../multi';
import type { MenuItem } from '../quick';

// vi.mock 的工厂在 import 求值时就执行，早于模块体里的 const：只能用 vi.hoisted 提前建桩
const m = vi.hoisted(() => ({
  openMenu: vi.fn(),
  toast: vi.fn(),
  promptInput: vi.fn(),
  promptConfirm: vi.fn(),
  setFavorite: vi.fn(),
  setHidden: vi.fn(),
  setUserTags: vi.fn(),
  removeGame: vi.fn(),
}));

vi.mock('../quick', () => ({ openMenu: m.openMenu }));
vi.mock('../ui', () => ({ toast: m.toast }));
vi.mock('../prompt', () => ({ promptInput: m.promptInput, promptConfirm: m.promptConfirm }));
vi.mock('../ipc', () => ({
  setFavorite: m.setFavorite,
  setHidden: m.setHidden,
  setUserTags: m.setUserTags,
  removeGame: m.removeGame,
}));

let refreshHook = vi.fn(async () => undefined);

/** 最近一次 openBatch 交给 openMenu 的菜单项 */
const menu = (): MenuItem[] => {
  const calls = m.openMenu.mock.calls;
  return (calls[calls.length - 1]?.[2] as MenuItem[] | undefined) ?? [];
};

/** 摆好库与选中集后打开批量菜单 */
async function open(ids: string[], games = ids.map((id) => game(id, { hidden: false }))): Promise<MenuItem[]> {
  state.games = games;
  state.gridSel.clear();
  for (const id of ids) state.gridSel.add(id);
  await openBatch();
  return menu();
}

const item = (key: string): MenuItem => {
  const it = menu().find((x) => x.key === key);
  if (!it) throw new Error(`菜单缺少 ${key}`);
  return it;
};

beforeEach(() => {
  mountSkeleton();
  resetState();
  vi.clearAllMocks();
  m.openMenu.mockImplementation(() => undefined);
  refreshHook = vi.fn(async () => undefined);
  setMultiRefresh(refreshHook);
});

describe('选中集与多选开关', () => {
  it('markSel 只改当前屏的勾选标记，并同步两条操作条的计数', () => {
    for (const id of ['a', 'b', 'c']) {
      const cell = document.createElement('div');
      cell.className = 'gcell';
      cell.dataset.id = id;
      document.getElementById('app')!.appendChild(cell);
    }
    const n1 = document.createElement('span');
    n1.id = 'gselN';
    const n2 = document.createElement('span');
    n2.id = 'lselN';
    document.getElementById('app')!.append(n1, n2);

    state.gridSel.add('a');
    state.gridSel.add('c');
    markSel();

    const cells = [...document.querySelectorAll<HTMLElement>('.gcell')];
    expect(cells.map((c) => c.classList.contains('sel'))).toEqual([true, false, true]);
    expect(n1.textContent).toBe('已选 2 部');
    expect(n2.textContent).toBe('已选 2 部');
  });

  it('toggleSel 来回切换同一个 id', () => {
    toggleSel('a');
    expect([...state.gridSel]).toEqual(['a']);
    toggleSel('a');
    expect([...state.gridSel]).toEqual([]);
  });

  it('setMulti 只在状态变化时广播，退出多选会清空选中集', () => {
    let events = 0;
    window.addEventListener('multi-change', () => events++);
    state.gridSel.add('a');

    setMulti(true);
    expect(state.gridMulti).toBe(true);
    expect(state.gridSel.size).toBe(0);
    expect(events).toBe(1);
    expect(m.toast).toHaveBeenLastCalledWith('多选 · A 勾选 · X 批量操作');

    setMulti(true); // 重复调用不广播、不重复提示
    expect(events).toBe(1);
    expect(m.toast).toHaveBeenCalledTimes(1);

    setMulti(false);
    expect(events).toBe(2);
    expect(m.toast).toHaveBeenLastCalledWith('已退出多选');
  });
});

describe('批量操作菜单', () => {
  it('没有选中条目时只提示，不打开菜单', async () => {
    await openBatch();
    expect(m.openMenu).not.toHaveBeenCalled();
    expect(m.toast).toHaveBeenLastCalledWith('先勾选要处理的条目', true);
  });

  it('文案随选中集翻转（全部已收藏 / 全部已隐藏 → 取消；否则为正向）', async () => {
    await open(['a', 'b']);
    expect(item('fav').label).toBe('收藏 2 部');
    expect(item('hide').label).toBe('隐藏 2 部');
    expect(item('remove').label).toBe('从库中移除 2 部…');
    expect(item('tag').hint).toBe('追加到 2 部');

    await open(['b'], [game('b', { hidden: true, favorite: true })]);
    expect(item('fav').label).toBe('取消收藏 1 部');
    expect(item('hide').label).toBe('取消隐藏 1 部');
  });

  it('收藏 / 隐藏：逐部落库，完成后清空选中集、退出多选并刷新库', async () => {
    await open(['a', 'b']);
    await item('fav').run();
    expect(m.setFavorite.mock.calls).toEqual([['a', true], ['b', true]]);
    expect(refreshHook).toHaveBeenCalledTimes(1);
    expect(state.gridMulti).toBe(false);
    expect(state.gridSel.size).toBe(0);
    expect(m.toast).toHaveBeenLastCalledWith('已收藏 · 2 部', false);

    await open(['a']);
    await item('hide').run();
    expect(m.setHidden).toHaveBeenCalledWith('a', true);
    expect(m.toast).toHaveBeenLastCalledWith('已隐藏 · 1 部', false);
  });

  it('执行过程中选中集被刷新剔除后，完成计数仍按执行前的总数', async () => {
    await open(['a', 'b']);
    // 模拟刷新钩子 / 失效条目回填时清空选中集：旧实现用 gridSel.size 会算成 0
    m.setFavorite.mockImplementation(async (id: string) => {
      state.gridSel.delete(id);
    });
    await item('fav').run();
    expect(m.toast).toHaveBeenLastCalledWith('已收藏 · 2 部', false);
  });

  it('单项失败不中断整批，完成文案区分成功与失败', async () => {
    await open(['a', 'b']);
    m.setFavorite.mockRejectedValueOnce(new Error('磁盘离线'));
    await item('fav').run();
    expect(m.setFavorite).toHaveBeenCalledTimes(2);
    expect(refreshHook).toHaveBeenCalledTimes(1);
    expect(m.toast).toHaveBeenLastCalledWith('已收藏 · 1 部成功 · 1 部失败', true);
  });

  it('批量加标签：输入为空不动库，重复标签跳过', async () => {
    m.promptInput.mockResolvedValueOnce(null);
    await open(['a', 'b']);
    await item('tag').run();
    expect(m.setUserTags).not.toHaveBeenCalled();

    m.promptInput.mockResolvedValueOnce('  纯爱  ');
    await open(
      ['a', 'b'],
      [game('a', { hidden: false, userTags: [] }), game('b', { hidden: false, userTags: ['纯爱'] })],
    );
    await item('tag').run();
    expect(m.setUserTags.mock.calls).toEqual([['a', ['纯爱']]]);
    expect(m.toast).toHaveBeenLastCalledWith('已添加标签 · 2 部', false);
  });

  it('批量移除：取消不动库，确定后逐条移除', async () => {
    m.promptConfirm.mockResolvedValueOnce(false);
    await open(['a', 'b']);
    await item('remove').run();
    expect(m.removeGame).not.toHaveBeenCalled();

    m.promptConfirm.mockResolvedValueOnce(true);
    await open(['a', 'b']);
    await item('remove').run();
    expect(m.removeGame.mock.calls).toEqual([['a'], ['b']]);
    expect(m.toast).toHaveBeenLastCalledWith('已移除 · 2 部', false);
  });
});

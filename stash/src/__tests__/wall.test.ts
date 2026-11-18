// @vitest-environment happy-dom
/** 海报墙（wall.ts）：索引夹紧、空库/越界坐标、卡片与标题事件、阶梯入场只在空墙首帧播放。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { game, mountSkeleton, resetState } from './dom-skeleton';
import { state } from '../state';
import { initCard } from '../screens/card';
import { applyWallFocus, renderWall, wallPos, WALL_COLS } from '../screens/wall';

function mountWall(): HTMLElement {
  const grid = document.createElement('div');
  grid.id = 'wallGrid';
  const rail = document.createElement('div');
  rail.id = 'railTrack';
  const rows = document.createElement('div');
  rows.id = 'listRows';
  const prev = document.createElement('div');
  prev.id = 'listPreview';
  document.getElementById('app')!.append(grid, rail, rows, prev);
  return grid;
}

beforeEach(() => {
  mountSkeleton();
  resetState();
  initCard({
    onFocus: vi.fn(),
    onOpen: vi.fn(),
    onLaunch: vi.fn(),
    onToggleSel: vi.fn(),
    suppressed: () => false,
    multi: () => false,
  });
});

describe('wallPos', () => {
  it('每行 6 列，行列按索引算', () => {
    expect(WALL_COLS).toBe(6);
    expect(wallPos(0, 6, 10)).toEqual([0, 0]);
    expect(wallPos(5, 6, 10)).toEqual([0, 5]);
    expect(wallPos(7, 6, 10)).toEqual([1, 1]);
  });

  it('空库与越界索引都被夹进合法范围', () => {
    expect(wallPos(3, 6, 0)).toEqual([0, 0]);
    expect(wallPos(-5, 6, 10)).toEqual([0, 0]);
    expect(wallPos(99, 6, 10)).toEqual([1, 3]);
  });
});

describe('renderWall', () => {
  it('没有 #wallGrid 时安全返回', () => {
    expect(() => renderWall([game('a')], null, true)).not.toThrow();
  });

  it('逐张建格子：卡 + 勾选标记 + 标题，并清空另外三块容器', () => {
    const grid = mountWall();
    document.getElementById('railTrack')!.innerHTML = '<span>旧轨道</span>';
    document.getElementById('listRows')!.innerHTML = '<span>旧列表</span>';
    document.getElementById('listPreview')!.innerHTML = '<span>旧预览</span>';

    renderWall([game('a'), game('b'), game('c')], 'c', true);

    const cells = [...grid.querySelectorAll<HTMLElement>('.wall-cell')];
    expect(cells.length).toBe(3);
    expect(cells.map((c) => c.dataset.id)).toEqual(['a', 'b', 'c']);
    expect(cells.map((c) => c.dataset.i)).toEqual(['0', '1', '2']);
    expect(cells[0]!.querySelector('.selmk')?.textContent).toBe('✓');
    expect(cells[1]!.querySelector('.wt')?.textContent).toBe('b');
    expect(cells[1]!.querySelector('.wt')?.getAttribute('title')).toBe('b');
    // 最近标记只给 lastId 那一张
    expect(cells[2]!.querySelector('.card .np')).not.toBeNull();
    expect(cells[0]!.querySelector('.card .np')).toBeNull();

    expect(document.getElementById('railTrack')!.children.length).toBe(0);
    expect(document.getElementById('listRows')!.children.length).toBe(0);
    expect(document.getElementById('listPreview')!.children.length).toBe(0);
  });

  it('空墙首帧才播阶梯入场，重绘与 animateBase=false 都不播', () => {
    const grid = mountWall();
    renderWall([game('a')], null, true);
    expect(grid.classList.contains('cascade')).toBe(true);

    renderWall([game('a'), game('b')], null, false);
    expect(grid.classList.contains('cascade')).toBe(false);

    renderWall([game('c')], null, true); // 墙里已有内容：不是首帧
    expect(grid.classList.contains('cascade')).toBe(false);
  });

  it('点的标题和封面都走 activateCard：默认聚焦，多选态改为勾选', () => {
    const onFocus = vi.fn();
    const onToggleSel = vi.fn();
    let multi = false;
    initCard({
      onFocus,
      onOpen: vi.fn(),
      onLaunch: vi.fn(),
      onToggleSel,
      suppressed: () => false,
      multi: () => multi,
    });
    const grid = mountWall();
    renderWall([game('a'), game('b')], null, false);

    grid.querySelectorAll<HTMLElement>('.wt')[1]!.click();
    expect(onFocus).toHaveBeenCalledWith(1);
    grid.querySelectorAll<HTMLElement>('.wall-cell .card')[0]!.click();
    expect(onFocus).toHaveBeenLastCalledWith(0);

    multi = true;
    grid.querySelectorAll<HTMLElement>('.wall-cell .card')[1]!.click();
    expect(onToggleSel).toHaveBeenCalledWith('b');
  });
});

describe('applyWallFocus', () => {
  it('焦点越界时渲染阶段先夹紧，焦点只落在一张卡上', () => {
    const grid = mountWall();
    state.focus = 9;
    renderWall([game('a'), game('b'), game('c')], null, false);
    expect(state.focus).toBe(2);

    const cells = [...grid.querySelectorAll<HTMLElement>('.wall-cell')];
    expect(cells.map((c) => c.classList.contains('on'))).toEqual([false, false, true]);
    expect(cells[2]!.querySelector('.card')?.classList.contains('focus')).toBe(true);
  });

  it('没有 #wallGrid 时安全返回', () => {
    expect(() => applyWallFocus()).not.toThrow();
  });
});

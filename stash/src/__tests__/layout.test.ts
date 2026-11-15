/** 布局纯逻辑：布局白名单、入场动效判定（回归点）、海报墙行列换算、网格焦点夹紧。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isFreshEnter, layoutMode, railWindow, wallPos } from '../screens/library';
import { clampCell } from '../screens/grid';

/** layoutMode 只读 document.documentElement.dataset.layout：用最小桩代替 DOM */
function useLayout(raw: string | undefined): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { dataset: raw === undefined ? {} : { layout: raw } } },
  });
}

beforeEach(() => useLayout(undefined));

describe('layoutMode', () => {
  it('classic / list / wall 原样返回', () => {
    useLayout('classic');
    expect(layoutMode()).toBe('classic');
    useLayout('list');
    expect(layoutMode()).toBe('list');
    useLayout('wall');
    expect(layoutMode()).toBe('wall');
  });

  it('非法值与未设置回落 classic', () => {
    useLayout('magazine');
    expect(layoutMode()).toBe('classic');
    useLayout(undefined);
    expect(layoutMode()).toBe('classic');
  });
});

describe('isFreshEnter', () => {
  it('空容器 + 库屏 + 有内容才播放入场', () => {
    expect(isFreshEnter(0, 'library', 10)).toBe(true);
  });

  it('容器已有子元素时不得重播（库内重绘回归点）', () => {
    expect(isFreshEnter(3, 'library', 10)).toBe(false);
  });

  it('非库屏或空列表不播放入场', () => {
    expect(isFreshEnter(0, 'grid', 10)).toBe(false);
    expect(isFreshEnter(0, 'library', 0)).toBe(false);
  });
});

describe('wallPos（海报墙行列换算）', () => {
  it('按列数换算行列', () => {
    expect(wallPos(0, 6, 10)).toEqual([0, 0]);
    expect(wallPos(5, 6, 10)).toEqual([0, 5]);
    expect(wallPos(6, 6, 10)).toEqual([1, 0]);
    expect(wallPos(9, 6, 10)).toEqual([1, 3]);
  });

  it('最后一行不满 / 单项 / 越界输入都不越界', () => {
    expect(wallPos(7, 6, 8)).toEqual([1, 1]);
    expect(wallPos(0, 6, 1)).toEqual([0, 0]);
    expect(wallPos(99, 6, 7)).toEqual([1, 0]);
    expect(wallPos(-3, 6, 7)).toEqual([0, 0]);
    expect(wallPos(0, 6, 0)).toEqual([0, 0]);
  });
});

describe('railWindow（大库窗口化范围）', () => {
  it('焦点在首 / 中 / 尾：窗口夹紧到列表边界', () => {
    expect(railWindow(0, 1000)).toEqual([0, 60]);
    expect(railWindow(500, 1000)).toEqual([440, 560]);
    expect(railWindow(999, 1000)).toEqual([939, 999]);
  });

  it('小库 / 空库：范围就是全部，空库返回 [0, -1]', () => {
    expect(railWindow(0, 10)).toEqual([0, 9]);
    expect(railWindow(9, 10)).toEqual([0, 9]);
    expect(railWindow(0, 0)).toEqual([0, -1]);
  });
});

describe('clampCell（网格焦点夹紧）', () => {
  it('空列表归零，越界夹进有效格', () => {
    expect(clampCell(0, 0, 5, 0)).toEqual([0, 0]);
    expect(clampCell(9, 9, 5, 1)).toEqual([0, 0]);
    expect(clampCell(-5, -5, 5, 12)).toEqual([0, 0]);
    expect(clampCell(0, 0, 5, 12)).toEqual([0, 0]);
  });

  it('最后一行不满时回落到最后一项', () => {
    expect(clampCell(9, 9, 5, 12)).toEqual([2, 1]);
    expect(clampCell(2, 5, 5, 12)).toEqual([2, 1]);
  });
});

// @vitest-environment happy-dom
/** 搜索面板空查询截断：1000 部库打开面板只渲染前 50 条 DOM，计数同步说明；
 *  有关键词时保持全量命中，空结果仍走空态，不截断逻辑误伤。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { game } from './dom-skeleton';
import { state } from '../state';
import { renderSearch } from '../search';

const items = (): NodeListOf<HTMLElement> => document.querySelectorAll<HTMLElement>('#spList .sp-item');
const countText = (): string => document.getElementById('spCount')!.textContent ?? '';
const ahintText = (): string => document.getElementById('spAHint')!.textContent ?? '';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = `<div id="spList"></div><span id="spCount"></span><span id="spAHint"></span>`;
  state.games = Array.from({ length: 1000 }, (_, i) => game(`g${i}`, { title: `Game ${i}` }));
  state.query = '';
});

describe('空查询截断', () => {
  it('1000 部库只渲染前 50 条，计数带截断说明，首项仍选中', () => {
    renderSearch();
    expect(items().length).toBe(50);
    expect(countText()).toContain('1000');
    expect(countText()).toContain('50');
    expect(countText()).toBe('全部 1000 部 · 显示前 50');
    // 现有行为：第一项默认 .on，Enter 仍能直接打开
    expect(items()[0]!.classList.contains('on')).toBe(true);
    expect(ahintText()).toBe('打开');
  });

  it('不超过 50 部时文案保持「全部 N 部」且全量渲染', () => {
    state.games = Array.from({ length: 30 }, (_, i) => game(`g${i}`, { title: `Game ${i}` }));
    renderSearch();
    expect(items().length).toBe(30);
    expect(countText()).toBe('全部 30 部');
  });
});

describe('关键词查询不截断', () => {
  it('命中 1000 部时全量渲染，计数为 N 部命中', () => {
    state.query = 'game';
    renderSearch();
    expect(items().length).toBe(1000);
    expect(countText()).toBe('1000 部命中');
  });

  it('无命中时显示空态与「清除」提示', () => {
    state.query = 'zzz-不存在';
    renderSearch();
    expect(items().length).toBe(0);
    expect(countText()).toBe('0 部命中');
    expect(document.getElementById('spList')!.textContent).toContain('没有匹配');
    expect(ahintText()).toBe('清除');
  });
});

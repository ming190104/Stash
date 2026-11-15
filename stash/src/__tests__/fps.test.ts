// @vitest-environment happy-dom
/** FPS 面板（fps.ts）：面板开关的持久化，以及 init 按设置写入 dataset.fps / 面板读数、
 *  页面隐藏时停 rAF、恢复可见后重新拉起。rAF 本身不在这里跑，只验状态迁移。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mountSkeleton, resetState } from './dom-skeleton';
import { state } from '../state';
import { init, panelVisible, togglePanel } from '../fps';
import type { FpsMode, Settings } from '../types';

function setMode(mode: FpsMode): void {
  state.settings = { fpsMode: mode } as unknown as Settings;
}

function mountFps(): void {
  const panel = document.createElement('div');
  panel.id = 'fpanel';
  const now = document.createElement('div');
  now.id = 'fpNow';
  const mode = document.createElement('div');
  mode.id = 'fpMode';
  document.getElementById('app')!.append(panel, now, mode);
}

beforeEach(() => {
  mountSkeleton();
  resetState();
  mountFps();
});

describe('FPS 面板', () => {
  it('面板开关只在 localStorage 与 #fpanel 的 .on 之间同步', () => {
    expect(panelVisible()).toBe(false);

    togglePanel();
    expect(panelVisible()).toBe(true);
    expect(document.getElementById('fpanel')!.classList.contains('on')).toBe(true);

    togglePanel();
    expect(panelVisible()).toBe(false);
    expect(document.getElementById('fpanel')!.classList.contains('on')).toBe(false);
  });

  it('手动档直接写 dataset.fps，面板读数不带阶梯', () => {
    setMode('60');
    localStorage.setItem('fpsPanel', '1');
    init();

    expect(document.documentElement.dataset.fps).toBe('60');
    expect(document.getElementById('fpMode')!.textContent).toBe('60');
    expect(document.getElementById('fpanel')!.classList.contains('on')).toBe(true);
  });

  it('Auto 档在无输入时给最高档，读数同时显示档位名与当前阶梯', () => {
    setMode('auto');
    init();

    expect(document.documentElement.dataset.fps).toBe('120');
    expect(document.getElementById('fpMode')!.textContent).toBe('auto · 120');
  });

  it('页面隐藏时停掉 rAF，恢复可见后重新拉起', () => {
    setMode('auto');
    init();
    const flip = (v: boolean): void => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: v });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    flip(true);
    flip(false);
    // 停机 / 拉起都是幂等的：连续两次同状态不抛错
    flip(false);
    flip(true);
    expect(document.documentElement.dataset.fps).toBe('120');
  });

  it('面板节点缺失时 togglePanel / init 也不崩', () => {
    document.getElementById('fpanel')?.remove();
    document.getElementById('fpMode')?.remove();
    expect(() => togglePanel()).not.toThrow();
    expect(() => init()).not.toThrow();
  });
});

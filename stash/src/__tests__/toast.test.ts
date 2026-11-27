// @vitest-environment happy-dom
/** toast 队列：连续提示排队播放（不再互相覆盖），并有上限防止无限堆积。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSkeleton, resetState } from './dom-skeleton';
import { toast, clearToast } from '../ui';

const el = (): HTMLElement => document.getElementById('toast')!;

beforeEach(() => {
  mountSkeleton();
  resetState();
  vi.useFakeTimers();
});

afterEach(() => {
  // 把剩余队列跑空：模块级 toastShowing / toastQueue 会跨用例保留
  vi.runAllTimers();
  vi.useRealTimers();
});

describe('toast 队列', () => {
  it('第一条立即显示，后续排队；每条播 1.8 秒后自动收起', () => {
    toast('第一条');
    toast('第二条');
    expect(el().textContent).toBe('第一条');
    expect(el().classList.contains('show')).toBe(true);

    vi.advanceTimersByTime(1800);
    expect(el().textContent).toBe('第二条');
    expect(el().classList.contains('show')).toBe(true);

    vi.advanceTimersByTime(1800);
    expect(el().classList.contains('show')).toBe(false);
  });

  it('连续刷屏只保留最近 5 条，不把提示排到十几秒后', () => {
    for (let i = 1; i <= 8; i++) toast(`t${i}`);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(el().textContent ?? '');
      vi.advanceTimersByTime(1800);
    }
    // 正在显示的是 t1；队列上限 5，丢掉了最早的 t2 / t3
    expect(seen).toEqual(['t1', 't4', 't5', 't6', 't7', 't8']);
  });

  it('报错提示带 hot 标记，播完后下一普通提示不带 hot', () => {
    toast('出错了', true);
    toast('普通提示');
    expect(el().classList.contains('hot')).toBe(true);
    vi.advanceTimersByTime(1800);
    expect(el().textContent).toBe('普通提示');
    expect(el().classList.contains('hot')).toBe(false);
  });

  it('没有 toast 节点时静默忽略，不抛错', () => {
    document.getElementById('toast')?.remove();
    expect(() => toast('无处显示')).not.toThrow();
  });

  it('运行遮罩（纯黑）打开时吞掉提示；快捷菜单打开后恢复', () => {
    document.getElementById('launchLayer')!.classList.add('on');
    toast('不该出现');
    expect(el().classList.contains('show')).toBe(false);

    // 快捷菜单本身有界面：它的操作反馈照常显示
    document.getElementById('qmenu')!.classList.add('show');
    toast('菜单提示');
    expect(el().classList.contains('show')).toBe(true);
    expect(el().textContent).toBe('菜单提示');
  });

  it('进入纯黑遮罩前 clearToast 立即收起提示并清空排队', () => {
    toast('旧提示');
    toast('排队提示');
    expect(el().classList.contains('show')).toBe(true);
    clearToast();
    expect(el().classList.contains('show')).toBe(false);
    // 队列已清空：推进时间不会把「排队提示」补播出来
    vi.advanceTimersByTime(5000);
    expect(el().classList.contains('show')).toBe(false);
  });
});

// @vitest-environment happy-dom
/** 跃迁转场队列：全屏开关这类幂等动作在转场期间必须「丢弃」而不是排队，
 *  否则同一按键的第二次投递会在动画播完后把刚进入的全屏又切回去。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endSplash, initSplash, previewBootAnim, warpBusy, warpToggle } from '../splash';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('endSplash', () => {
  it('设置页预览：核心 / 跃迁会挂出动画层，关闭档不播', () => {
    previewBootAnim('off');
    expect(document.querySelector('#warpSplash')).toBeNull();
    previewBootAnim('core');
    expect(document.querySelector('#warpSplash')).not.toBeNull();
  });

  it('数据先于动画就绪时提前收尾，不再干等满 3s', async () => {
    let done = false;
    const boot = initSplash().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);

    endSplash();
    // 先等满最短亮场 1.2s，再走 340ms 淡出
    await vi.advanceTimersByTimeAsync(150);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await boot;
    expect(done).toBe(true);
  });

  it('2× 时最短亮场仍保持 1.1s，不会一闪而过', async () => {
    localStorage.setItem('vnAnimSpeed', '2');
    let done = false;
    const boot = initSplash().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    endSplash();
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await boot;
    expect(done).toBe(true);
    localStorage.removeItem('vnAnimSpeed');
  });

  it('没有在播时是空操作', () => {
    expect(() => endSplash()).not.toThrow();
  });
});

describe('warpToggle', () => {
  it('dropIfBusy：转场进行中再请求直接丢弃，不排队成反向切换', async () => {
    const run = vi.fn();
    const first = warpToggle(run, true);
    expect(warpBusy()).toBe(true);

    const second = warpToggle(run, true, { dropIfBusy: true });
    await expect(second).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled(); // 第一次还没到白闪峰值

    await vi.advanceTimersByTimeAsync(2000);
    await first;
    expect(run).toHaveBeenCalledTimes(1); // 被丢弃的那次从未执行
    expect(warpBusy()).toBe(false);
  });

  it('默认仍然排队：两次请求依次执行，不丢', async () => {
    const order: number[] = [];
    const first = warpToggle(() => {
      order.push(1);
    }, true);
    const second = warpToggle(() => {
      order.push(2);
    }, true);

    await vi.advanceTimersByTimeAsync(2000);
    await first;
    await vi.advanceTimersByTimeAsync(2000);
    await second;
    expect(order).toEqual([1, 2]);
    expect(warpBusy()).toBe(false);
  });
});

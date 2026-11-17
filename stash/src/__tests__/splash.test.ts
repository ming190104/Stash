// @vitest-environment happy-dom
/** 跃迁转场队列：全屏开关这类幂等动作在转场期间必须「丢弃」而不是排队，
 *  否则同一按键的第二次投递会在动画播完后把刚进入的全屏又切回去。
 *  冷启动与全屏切换共用同一段完整跃迁，时长公式与速度倍率也完全一致。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSplash, previewBootAnim, warpBusy, warpToggle } from '../splash';
import type { BootAnim } from '../types';

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
  localStorage.removeItem('vnBootAnim');
  localStorage.removeItem('vnAnimSpeed');
});

describe('initSplash', () => {
  it('设置页预览：跃迁会挂出动画层，关闭档不播', () => {
    previewBootAnim('off');
    expect(document.querySelector('#warpSplash')).toBeNull();
    previewBootAnim('warp');
    expect(document.querySelector('#warpSplash')).not.toBeNull();
  });

  it('EVA 四档：按档建层、写配色与时长，换档整层重建', async () => {
    const cases: Array<[BootAnim, string]> = [
      ['eva01', '01'],
      ['eva02', 'aska'],
      ['evaNerv', 'nerv'],
      ['eva00', '00'],
    ];
    for (const [mode, pal] of cases) {
      previewBootAnim(mode);
      const el = document.getElementById('warpSplash')!;
      expect(el.classList.contains('mode-eva')).toBe(true);
      expect(el.dataset.pal).toBe(pal);
      expect(el.querySelector('.eva')).not.toBeNull();
      expect(el.querySelector('.ev-word-main')?.textContent).toBe('STASH');
      expect(el.style.getPropertyValue('--dur')).toBe('5000ms');
      await vi.advanceTimersByTimeAsync(5300);
    }
  });

  it('冷启动完整播放 5s：数据先就绪也不会提前收尾', async () => {
    let done = false;
    const boot = initSplash().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(4500);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    await boot;
    expect(done).toBe(true);
  });

  it('关闭档直接返回，不挂动画层', async () => {
    localStorage.setItem('vnBootAnim', 'off');
    await initSplash();
    expect(document.querySelector('#warpSplash')).toBeNull();
  });

  it('2× 时整段缩到 2.5s，而不是一闪而过', async () => {
    localStorage.setItem('vnAnimSpeed', '2');
    let done = false;
    const boot = initSplash().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    await boot;
    expect(done).toBe(true);
  });
});

describe('warpToggle', () => {
  it('dropIfBusy：转场进行中再请求直接丢弃，不排队成反向切换', async () => {
    const run = vi.fn();
    const first = warpToggle(run, true);
    expect(warpBusy()).toBe(true);

    const second = warpToggle(run, true, { dropIfBusy: true });
    await expect(second).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled(); // 还没到白闪峰值

    await vi.advanceTimersByTimeAsync(5200);
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

    await vi.advanceTimersByTimeAsync(5200);
    await first;
    await vi.advanceTimersByTimeAsync(5200);
    await second;
    expect(order).toEqual([1, 2]);
    expect(warpBusy()).toBe(false);
  });

  it('全屏切换与冷启动共用同一段跃迁：1× / 1.5× / 2× 时长一致', async () => {
    const cases: Array<[string, string]> = [
      ['1', '5000ms'],
      ['1.5', '3333ms'],
      ['2', '2500ms'],
    ];
    for (const [speed, dur] of cases) {
      localStorage.setItem('vnAnimSpeed', speed);
      const turn = warpToggle(() => undefined, true);
      await vi.advanceTimersByTimeAsync(50);
      const el = document.getElementById('warpSplash')!;
      expect(el.style.getPropertyValue('--wv-dur')).toBe(dur);
      await vi.advanceTimersByTimeAsync(5300);
      await turn;
    }
  });

  it('跳过时先把换边补上，不让人卡在旧的全屏状态', async () => {
    const fn = vi.fn();
    const turn = warpToggle(fn, true);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).not.toHaveBeenCalled(); // 白闪在 3s，还没到

    dispatchEvent(new KeyboardEvent('keydown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await turn;
  });
});

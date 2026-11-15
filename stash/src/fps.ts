/** FPS 面板 + 帧率档位 + Auto 阶梯（总案 3.4）。
 *  - dataset.fps 驱动 CSS 档位选择器（动效时长 / 预解码窗口）
 *  - Auto：交互 120 → 静止 2s 降 90 → 20s 降 60 → 60s 停 rAF（下一次输入自动拉起）
 *  - 手动档只保留「不可见全停」
 */

import type { FpsMode } from './types';
import { state, touch } from './state';

let frames = 0;
let lastSample = performance.now();
let lastInput = performance.now();
let fpsValue = 0;
let rafHandle = 0;
let stopped = false;
/** 页面不可见导致的停机（与「空闲 60s 停机」区分：只有可见时才允许被输入拉起） */
let hidden = false;

export function panelVisible(): boolean {
  return localStorage.getItem('fpsPanel') === '1';
}

export function togglePanel(): void {
  const on = !panelVisible();
  localStorage.setItem('fpsPanel', on ? '1' : '0');
  document.getElementById('fpanel')?.classList.toggle('on', on);
}

function currentMode(): FpsMode {
  return state.settings?.fpsMode ?? 'auto';
}

/** Auto 阶梯的当前降档结果（仅显示与 CSS 用；60s 停 rAF 由 tick 执行） */
function autoTier(): FpsMode {
  const idle = performance.now() - lastInput;
  if (idle > 20_000) return '60';
  if (idle > 2_000) return '90';
  return '120';
}

function effectiveFps(): FpsMode {
  const mode = currentMode();
  if (mode === 'auto') return autoTier();
  return mode;
}

function applyMode(): void {
  const fps = effectiveFps();
  if (document.documentElement.dataset.fps !== fps) {
    document.documentElement.dataset.fps = fps;
  }
  const el = document.getElementById('fpMode');
  if (el) el.textContent = `${currentMode()}${currentMode() === 'auto' ? ` · ${fps}` : ''}`;
}

function start(): void {
  if (!stopped) return;
  stopped = false;
  frames = 0;
  lastSample = performance.now();
  rafHandle = requestAnimationFrame(tick);
}

function stop(): void {
  if (stopped) return;
  stopped = true;
  cancelAnimationFrame(rafHandle);
}

function tick(): void {
  if (stopped) return;
  frames++;
  const now = performance.now();
  if (now - lastSample >= 1000) {
    fpsValue = Math.round((frames * 1000) / (now - lastSample));
    frames = 0;
    lastSample = now;
    const el = document.getElementById('fpNow');
    if (el && panelVisible()) {
      el.textContent = String(fpsValue);
      el.parentElement!.classList.toggle('low', fpsValue < 55);
    }
    applyMode();
    // Auto 60s 无输入：连 rAF 一起停（省电）；下一次 keydown/pointerdown 由 hook 拉起
    if (currentMode() === 'auto' && now - lastInput > 60_000) {
      stop();
      return;
    }
  }
  rafHandle = requestAnimationFrame(tick);
}

export function init(): void {
  const hook = () => {
    lastInput = performance.now();
    touch();
    if (!hidden) start(); // 空闲停机 / 手动档不可见停机后，任意输入重新拉起
  };
  for (const ev of ['keydown', 'pointerdown', 'wheel'] as const) {
    window.addEventListener(ev, hook, { passive: true, capture: true });
  }
  const el = document.getElementById('fpanel');
  el?.classList.toggle('on', panelVisible());
  applyMode();
  rafHandle = requestAnimationFrame(tick);
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden;
    if (hidden) stop();
    else start();
  });
}

/** B1/B2 平台基线简测（总案 3.1）：空转 rAF + 8 个 translate3d 动画元素 */
export async function runBaseline(): Promise<string[]> {
  const results: string[] = [];

  // B1：空转 rAF 1 秒计数
  await new Promise<void>((res) => {
    let n = 0;
    const t0 = performance.now();
    const loop = () => {
      n++;
      if (performance.now() - t0 >= 1000) {
        results.push(`B1 空转 rAF：${n} fps（≥115 达标）${n >= 115 ? ' ✓' : ' ✗'}`);
        res();
      } else requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  // B2：8 个 translate3d 动画元素跑 3 秒
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999';
  const els: HTMLElement[] = [];
  for (let i = 0; i < 8; i++) {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${i * 60}px;top:${i * 40}px;width:40px;height:40px;
      background:#FF8E9E;will-change:transform;
      animation:b2move 1s linear infinite alternate`;
    els.push(d);
    layer.appendChild(d);
  }
  const style = document.createElement('style');
  style.textContent = '@keyframes b2move{to{transform:translate3d(300px,120px,0)}}';
  document.head.appendChild(style);
  document.body.appendChild(layer);

  await new Promise<void>((res) => {
    let n = 0;
    const t0 = performance.now();
    const loop = () => {
      n++;
      if (performance.now() - t0 >= 3000) {
        const fps = Math.round((n * 1000) / (performance.now() - t0));
        results.push(`B2 8 元素动画：${fps} fps（≥115 达标）${fps >= 115 ? ' ✓' : ' ✗'}`);
        res();
      } else requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  layer.remove();
  style.remove();
  return results;
}

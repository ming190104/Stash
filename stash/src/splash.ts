/** 冷启动动画（设置 · 外观 → 启动动画）：
 *    warp = 流光跃迁 5.0s（默认）/ eva01·eva02·evaNerv·eva00 = EVA 起动序列 5.0s / off = 关闭。
 *  全屏切换复用同一段完整动画，和冷启动共用同一个速度倍率与时长公式。
 *  视觉只用 transform / opacity；跃迁走主题令牌（各主题自动适配），
 *  EVA 自带三套机体配色（初号机 / 明日香 / NERV）。
 *  换边发生在白闪峰值那一刻，藏在遮罩下完成。 */

import { cachedAnimSpeed, cachedBootAnim } from './ui';
import { playBootSfx, stopBootSfx } from './boot-sfx';
import { buildEva, startMeters, type EvaPal } from './splash-eva';
import type { BootAnim } from './types';

/** 冷启动与全屏切换在 1× 下的实际时长：叙事完整播完，跳过交给任意键 / 触摸 */
const BOOT_MS = 5000;
/** 冷启动时长下限的基准值：极端倍率下也不至于一闪而过 */
const MIN_BOOT_MS = 1200;
/** 高速档的时长下限：倍率再高也保留 1.1s 亮场 */
const MIN_BOOT_FLOOR_MS = 1100;
/** 收尾淡出时长：在运动时间轴末尾接棒，总时长正好等于 motion */
const FADE_MS = 340;
/** 白闪峰值占运动时间轴的比例：全屏换边压在这一帧下 */
const WARP_FLASH_AT = 0.6;
/** EVA 的白闪峰值在 66.2%（1× = 3.31s） */
const EVA_FLASH_AT = 0.662;

type EvaBoot = 'eva01' | 'eva02' | 'evaNerv' | 'eva00';
const EVA_PAL: Record<EvaBoot, EvaPal> = { eva01: '01', eva02: 'aska', evaNerv: 'nerv', eva00: '00' };

function isEva(anim: BootAnim): anim is EvaBoot {
  return anim === 'eva01' || anim === 'eva02' || anim === 'evaNerv' || anim === 'eva00';
}

/** 冷启动时长下限按时长倍率换算：极端倍率下仍保留 1.1s 亮场。
 *  正常 1× / 1.5× / 2× 都由 BOOT_MS / speed 决定，不会碰到下限。 */
function bootMinMs(speed: number): number {
  return Math.max(MIN_BOOT_FLOOR_MS, Math.round(MIN_BOOT_MS / speed));
}
const STREAKS = 40;
const TRAILS = 14;

let overlay: HTMLDivElement | null = null;
/** 当前层是按哪一档建的：换档（跃迁 ↔ 初号机 ↔ 明日香 ↔ NERV）时整层重建 */
let built = '';
/** 每次起播的序号：连续预览时，旧实例的收尾不能去动新动画的类名与音频 */
let seq = 0;
/** 切换串行队列：保证连续点击按顺序换边 */
let queue: Promise<void> = Promise.resolve();
/** 是否有转场在跑（含排队中）：全屏这种幂等开关靠它丢弃重复请求 */
let pending = 0;

/** 首帧遮罩（index.html 内联样式）：WebView 白底 / 样式未生效的那一下由它盖住。
 *  启动动画层已挂上（或明确不播）后调用，淡出再移除，避免遮挡界面。 */
export function hideBootCover(): void {
  const cover = document.getElementById('bootCover');
  if (!cover) return;
  cover.classList.add('gone');
  setTimeout(() => cover.remove(), 260);
}

export function warpBusy(): boolean {
  return pending > 0;
}

function reduced(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function mk(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** S-03 流光跃迁的元素树：
 *  外层短光丝 + 内层长拖尾（负延迟错峰）→ 核心亮点 → 三道加速环 → 刻度环 →
 *  白闪 + 两道横向速度线 → HUD 四角 / 状态条 / 逐字字标 / 副标题 / 底部进度。 */
function buildWarp(el: HTMLDivElement): void {
  // 外层光丝：短、快、亮；--o 给每根不同的透明度，纵深靠它而不是靠数量
  const field = mk('wv-field');
  for (let i = 0; i < STREAKS; i++) {
    const s = mk('wv-streak');
    s.style.setProperty('--a', `${((i / STREAKS) * 360 + (i % 2) * 0.8).toFixed(1)}deg`);
    s.style.setProperty('--o', (0.35 + (i % 5) * 0.125).toFixed(3));
    s.style.height = `${30 + (i % 4) * 14}px`;
    s.style.animationDelay = `calc(var(--wv-dur) * ${(-(i % 8) * 0.012).toFixed(3)})`;
    field.appendChild(s);
  }

  // 内层拖尾：长、慢、半透明，稍微错开角度制造厚度
  const trail = mk('wv-trail');
  for (let i = 0; i < TRAILS; i++) {
    const s = mk('wv-trailrow');
    s.style.setProperty('--a', `${((i / TRAILS) * 360 + 3.2).toFixed(1)}deg`);
    s.style.height = `${120 + (i % 3) * 40}px`;
    s.style.animationDelay = `calc(var(--wv-dur) * ${(-(0.02 + (i % 6) * 0.014)).toFixed(3)})`;
    trail.appendChild(s);
  }

  // 中心亮点 + 三道加速环 + 末段收束环
  const core = mk('wv-core');
  const rings = mk('wv-rings');
  rings.append(document.createElement('i'), document.createElement('i'), document.createElement('i'), document.createElement('i'));

  // 白闪时的横向速度线
  const burst = mk('wv-burst');
  burst.append(document.createElement('i'), document.createElement('i'));

  // HUD：两个角 + 一行机名，和核心启动同一套取景框
  const hud = mk('wv-hud');
  hud.appendChild(span('wv-corner wv-tl', ''));
  hud.appendChild(span('wv-corner wv-br', ''));
  hud.appendChild(span('wv-t1', 'STASH // WARP DRIVE'));

  // 顶部状态条：WARP DRIVE → LINK LOCKED → LIBRARY READY
  const read = mk('wv-read');
  read.append(span('wv-s1', 'WARP DRIVE'), span('wv-s2', 'LINK LOCKED'), span('wv-s3', 'LIBRARY READY'));

  // 字标：逐字立起
  const word = mk('wv-word');
  for (const ch of 'STASH') word.appendChild(span('', ch));

  // 副标题 + 底部进度
  const sub = mk('wv-sub');
  sub.append(document.createElement('i'), span('', 'GAME LIBRARY'), document.createElement('i'));
  const prog = mk('wv-prog');
  prog.appendChild(document.createElement('b'));

  el.append(
    field,
    trail,
    core,
    rings,
    mk('wv-ticks'),
    burst,
    mk('wv-flash'),
    hud,
    read,
    word,
    sub,
    prog,
    mk('wv-vig')
  );
}

/** 取（必要时重建）动画层：换档时整层重建，避免上一档的元素与动画残留 */
function ensure(anim: BootAnim): HTMLDivElement | null {
  const mode: BootAnim = anim === 'off' ? 'warp' : anim;
  // 层可能已被外部移除（测试重置 DOM、或未来换容器）：脱落的节点不能复用
  if (overlay && overlay.isConnected && built === mode) return overlay;
  const app = document.getElementById('app');
  if (!app) return null;
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  const el = document.createElement('div');
  el.id = 'warpSplash';
  el.setAttribute('aria-hidden', 'true');
  if (mode === 'warp') {
    el.classList.add('mode-warp');
    buildWarp(el);
  } else {
    el.classList.add('mode-eva');
    const pal = EVA_PAL[mode as EvaBoot];
    el.dataset.pal = pal;
    el.appendChild(buildEva(pal));
  }
  app.appendChild(el);
  overlay = el;
  built = mode;
  return el;
}

/** EVA 舞台等比缩放到启动层：1280×720 是唯一坐标系，非 16:9 时两侧留黑 */
function fitEva(el: HTMLDivElement): void {
  const s = Math.min(el.clientWidth / 1280, el.clientHeight / 720);
  el.style.setProperty('--ev-scale', String(s > 0 ? s : 1));
}

/** 起播并等待：任意键 / 触摸可跳过；onFlash 在白闪峰值触发（全屏换边用）。
 *  motionMs 是运动时间轴的实际长度（已含速度倍率）；淡出接在末尾，总时长与它一致。
 *  sfx 与画面同一时刻起播、同一时刻收尾：跳过和自然结束都走 stopBootSfx。 */
function run(
  el: HTMLDivElement,
  motionMs: number,
  anim: BootAnim,
  onFlash?: () => void,
  flashAt = WARP_FLASH_AT,
): Promise<void> {
  const my = ++seq;
  el.classList.remove('on');
  void el.offsetWidth; // 强制重排：display:none 会取消动画，重新显示即从头播
  el.classList.add('on');
  playBootSfx(motionMs, anim);

  // EVA：显示后才知道容器尺寸；顺带把遥测数字跑起来
  const eva = isEva(anim);
  if (eva) fitEva(el);
  const onResize = eva ? (): void => fitEva(el) : null;
  if (onResize) addEventListener('resize', onResize);
  const stopMeters = eva ? startMeters(el, motionMs) : null;

  return new Promise<void>((resolve) => {
    let done = false;
    let ending = false;
    let flashed = false;
    let fadeAnim: Animation | null = null;
    let timer = 0;
    let flashTimer = 0;

    const fireFlash = (): void => {
      if (flashed || my !== seq || !onFlash) return;
      flashed = true;
      onFlash();
    };

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(flashTimer);
      removeEventListener('keydown', skip, true);
      removeEventListener('pointerdown', skip, true);
      if (onResize) removeEventListener('resize', onResize);
      stopMeters?.();
      // 已被下一次起播接管：只解开自己的 promise，别去动新动画的类名与音频
      if (my === seq) {
        el.classList.remove('on');
        stopBootSfx();
        fadeAnim?.cancel();
      }
      fadeAnim = null;
      resolve();
    };
    /** 全屏切换要播满 5s：允许跳过，但跳过时先把换边补上，
     *  否则用户按了键却停在旧的全屏状态，还得再等一轮。 */
    const skip = (): void => {
      fireFlash();
      finish();
    };

    /** 收尾：不再把根动画硬跳到末尾淡出帧，而是在顶层叠一段透明度过渡，
     *  下层运动照原速跑完，观感是整体渐渐隐去，而不是画面突然切走。 */
    const smoothEnd = (): void => {
      if (done || ending) return;
      if (my !== seq) {
        finish();
        return;
      }
      clearTimeout(timer);
      if (typeof el.animate !== 'function') {
        finish();
        return;
      }
      ending = true;
      fadeAnim = el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: 'cubic-bezier(.4, 0, .2, 1)',
        fill: 'forwards',
      });
      // 取消时 finished 会以 AbortError 拒绝：这里先接住，避免变成未处理拒绝
      fadeAnim.finished?.catch(() => undefined);
      timer = window.setTimeout(finish, FADE_MS);
    };

    // 自然收尾：淡出正好在运动时间轴末尾结束，实际时长 = motionMs
    timer = window.setTimeout(smoothEnd, Math.max(0, motionMs - FADE_MS));
    addEventListener('keydown', skip, true);
    addEventListener('pointerdown', skip, true);
    if (onFlash) flashTimer = window.setTimeout(fireFlash, Math.round(motionMs * flashAt));
  });
}

/** 播一次启动动画。冷启动与全屏切换共用：时长、速度倍率、音效、换边位置完全一致。 */
function playAnim(anim: BootAnim, onFlash?: () => void): Promise<void> {
  const mode: BootAnim = anim === 'off' ? 'warp' : anim;
  const el = ensure(mode);
  // 改设置时已写入缓存，冷启动 / 切换都读同一份
  const speed = cachedAnimSpeed();
  const minMs = bootMinMs(speed);
  const motion = Math.round(Math.max(minMs + 200, BOOT_MS / speed));
  if (!el) {
    onFlash?.();
    return Promise.resolve();
  }
  el.style.setProperty('--wv-dur', `${motion}ms`);
  el.style.setProperty('--dur', `${motion}ms`);
  return run(el, motion, mode, onFlash, isEva(mode) ? EVA_FLASH_AT : WARP_FLASH_AT);
}

/** 设置页切换档位 / 速度时立即预览一次完整动画：否则改完要等下次启动才看得到，像「改了没反应」。
 *  预览同样按当前速度倍率播放；关闭档不播。 */
export function previewBootAnim(mode: BootAnim): void {
  if (reduced() || mode === 'off' || warpBusy()) return;
  void playAnim(mode);
}

/** 冷启动：按设置的档位播，窗口 / 全屏都播；系统「减少动态效果」时跳过。
 *  之前只在全屏模式播，导致窗口模式下改「启动与转场速度」完全无感。 */
export async function initSplash(): Promise<void> {
  if (reduced()) return;
  const mode = cachedBootAnim();
  if (mode === 'off') return;
  await playAnim(mode);
}

export interface WarpOptions {
  /** 转场进行中时直接丢弃本次请求，而不是排队。
   *  全屏开关这类「只有最终状态有意义」的动作必须用它：否则同一按键的第二次
   *  投递会在动画播完后把刚进入的全屏又切回去（日志里成对的进入 / 退出）。 */
  dropIfBusy?: boolean;
}

/** 全屏切换：进入 / 退出都播同一段完整动画（5s ÷ 速度倍率），换边藏在白闪峰值下。 */
export function warpToggle(
  run: () => void | Promise<void>,
  animate = true,
  opts: WarpOptions = {}
): Promise<void> {
  if (opts.dropIfBusy && pending > 0) return Promise.resolve();
  pending++;
  // 连续切换按顺序执行：第二次点击不会和第一次的换边抢，也不会被静默吞掉
  const turn = queue.then(() => runToggle(run, animate));
  queue = turn.catch(() => undefined);
  return turn.finally(() => {
    pending--;
  });
}

async function runToggle(fn: () => void | Promise<void>, animate: boolean): Promise<void> {
  // 只受系统「减少动态效果」控制；设置里的动效强度是幅度，不是开关
  if (!animate || reduced()) {
    await fn();
    return;
  }
  let failed = false;
  let failure: unknown;
  await playAnim(cachedBootAnim(), () => {
    // 立即接住换边的拒绝：否则要等动画播完才有人 await，会变成未处理拒绝
    try {
      const r = fn();
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).catch((err) => {
          failed = true;
          failure = err;
        });
      }
    } catch (err) {
      failed = true;
      failure = err;
    }
  });
  if (failed) throw failure;
}

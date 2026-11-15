/** 冷启动动画（设置 · 外观 → 启动动画）：
 *    core = S-01 核心启动 5.0s（默认）/ warp = S-03 流光跃迁 5.0s / off = 关闭。
 *  两套时长统一由 BOOT_MS 控制；速度档只缩放时间锚点，不改叙事顺序。
 *  全屏切换固定用核心压缩段（基准 1.0s，「全屏模式切换动画」），进入 / 退出都播。
 *  两套视觉都只用 transform / opacity，颜色全部走主题令牌（十套主题含白昼自动适配）；
 *  换边发生在锁定闪光那一刻，藏在遮罩下完成。 */

import { cachedAnimSpeed, cachedBootAnim } from './ui';
import type { BootAnim } from './types';

/** 核心启动 CSS 时间轴的撰写基准：warp.css 里所有 calc(3s * var(--k)) 都以它为准 */
const CORE_BASE_MS = 3000;
/** 两套冷启动动画在 1× 下的实际时长：叙事完整播完，跳过交给任意键 / 触摸 */
const BOOT_MS = 5000;
/** 全屏切换压缩段 */
const SWAP_MS = 1000;
/** 冷启动时长下限的基准值：极端速度倍率下也不至于一闪而过 */
const MIN_BOOT_MS = 1200;
/** 高速档的时长下限：倍率再高也保留 1.1s 亮场 */
const MIN_BOOT_FLOOR_MS = 1100;
/** 全屏压缩段的温和系数：冷启动 5.0s 已含最终节奏，压缩段仍保留原来的呼吸感 */
const CALM = 1.25;
/** 收尾淡出时长：在运动时间轴末尾接棒，总时长正好等于 motion */
const FADE_MS = 340;

/** 时长下限按时长倍率换算：全屏压缩段在高速档仍保留 1.1s 亮场；
 *  冷启动 5.0s / speed 远高于这个下限，这里作为极端倍率的兜底。 */
function bootMinMs(speed: number): number {
  return Math.max(MIN_BOOT_FLOOR_MS, Math.round(MIN_BOOT_MS / speed));
}
const STREAKS = 56;
const TRAILS = 20;

let overlay: HTMLDivElement | null = null;
/** 当前构建的是哪一套（设置切换后下次播放会重建） */
let kind: 'core' | 'warp' | null = null;
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

/** 遥测 / 日志行：左侧小字 + 右侧强调值 */
function kvRow(label: string, value: string): HTMLDivElement {
  const d = mk('');
  const b = document.createElement('b');
  b.textContent = value;
  d.append(label, ' ', b);
  return d;
}

/** S-01 核心启动的元素树 */
function buildCore(el: HTMLDivElement): void {
  // 库位网格底图
  const grid = mk('wp-grid');

  // 顶部状态条：SCANNING CORE → CORE LOCKED → LIBRARY READY
  const read = mk('wp-read');
  read.append(span('wp-s1', 'SCANNING CORE'), span('wp-s2', 'CORE LOCKED'), span('wp-s3', 'LIBRARY READY'));

  // 核心总成
  const orbit = mk('wp-orbit');
  orbit.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  const core = mk('wp-core');
  core.append(
    mk('wp-halo'),
    mk('wp-cross'),
    mk('wp-ticks'),
    mk('wp-ticks2'),
    mk('wp-arc'),
    orbit,
    mk('wp-sweep'),
    mk('wp-pulse'),
    mk('wp-pulse2'),
    mk('wp-settle'),
    mk('wp-hex'),
    mk('wp-dot')
  );

  // HUD：四角 + 电平条 + 角标
  const hud = mk('wp-hud');
  for (const c of ['wp-tl', 'wp-tr', 'wp-bl', 'wp-br']) hud.appendChild(span(`wp-corner ${c}`, ''));
  hud.appendChild(span('wp-meter wp-ml', ''));
  hud.appendChild(span('wp-meter wp-mr', ''));
  hud.append(
    span('wp-t1', 'STASH // LIBRARY CORE'),
    span('wp-t2', 'BOOT 1.0.3'),
    span('wp-t3', 'NODES 128'),
    span('wp-t4', '31.23N / 121.47E')
  );

  // 右侧遥测
  const side = mk('wp-side');
  side.append(
    kvRow('CORE\u00a0\u00a0TEMP', '36.2'),
    kvRow('LINK\u00a0\u00a0LATENCY', '04MS'),
    kvRow('INDEX\u00a0\u00a0BUFFERS', '16/16'),
    kvRow('SCAN\u00a0\u00a0SECTOR', '0x7F')
  );

  // 左下挂载日志（第三行带闪烁光标）
  const log = mk('wp-log');
  log.append(kvRow('MOUNT\u00a0\u00a0LIBRARY', 'OK'), kvRow('INDEX\u00a0\u00a0COVERS', '128'));
  const ready = kvRow('LINK\u00a0\u00a0\u00a0SESSION', 'READY');
  const cursor = document.createElement('i');
  cursor.className = 'wp-cursor';
  ready.appendChild(cursor);
  log.appendChild(ready);

  // 字标：逐字显影，再由扫描光带刷过
  const word = mk('wp-word');
  for (const ch of 'STASH') word.appendChild(span('', ch));

  // 副标题 + 底部进度
  const sub = mk('wp-sub');
  sub.append(document.createElement('i'), span('', 'GAME LIBRARY // 128 NODES'), document.createElement('i'));
  const prog = mk('wp-prog');
  prog.appendChild(document.createElement('b'));

  el.append(
    grid,
    read,
    core,
    hud,
    side,
    log,
    word,
    mk('wp-scan'),
    sub,
    prog,
    mk('wp-scanlines'),
    mk('wp-vig'),
    mk('wp-flash')
  );
}

/** S-03 流光跃迁的元素树：
 *  外层短光丝 + 内层长拖尾（负延迟错峰）→ 核心亮点 → 三道加速环 → 刻度环 →
 *  白闪 + 两道横向速度线 → HUD 四角 / 状态条 / 逐字字标 / 副标题 / 底部进度。 */
function buildWarp(el: HTMLDivElement): void {
  // 外层光丝：短、快、亮
  const field = mk('wv-field');
  for (let i = 0; i < STREAKS; i++) {
    const s = mk('wv-streak');
    s.style.setProperty('--a', `${((i / STREAKS) * 360 + (i % 2) * 0.8).toFixed(1)}deg`);
    s.style.height = `${30 + (i % 4) * 14}px`;
    s.style.animationDelay = `calc(var(--wv-dur) * ${(-(i % 5) * 0.02).toFixed(3)})`;
    field.appendChild(s);
  }

  // 内层拖尾：长、慢、半透明，稍微错开角度制造厚度
  const trail = mk('wv-trail');
  for (let i = 0; i < TRAILS; i++) {
    const s = mk('wv-trailrow');
    s.style.setProperty('--a', `${((i / TRAILS) * 360 + 3.2).toFixed(1)}deg`);
    s.style.height = `${120 + (i % 3) * 40}px`;
    s.style.animationDelay = `calc(var(--wv-dur) * ${(-(0.03 + (i % 4) * 0.025)).toFixed(3)})`;
    trail.appendChild(s);
  }

  // 中心亮点 + 三道加速环 + 末段收束环
  const core = mk('wv-core');
  const rings = mk('wv-rings');
  rings.append(document.createElement('i'), document.createElement('i'), document.createElement('i'), document.createElement('i'));

  // 白闪时的横向速度线
  const burst = mk('wv-burst');
  burst.append(document.createElement('i'), document.createElement('i'));

  // HUD：四角与角标
  const hud = mk('wv-hud');
  for (const c of ['wv-tl', 'wv-tr', 'wv-bl', 'wv-br']) hud.appendChild(span(`wv-corner ${c}`, ''));
  hud.append(span('wv-t1', 'STASH // WARP DRIVE'), span('wv-t2', 'LINK 04MS'));

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

/** 按档位取（必要时重建）转场层 */
function ensure(k: 'core' | 'warp'): HTMLDivElement | null {
  if (overlay && kind === k) return overlay;
  const app = document.getElementById('app');
  if (!app) return null;
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  kind = k;
  const el = document.createElement('div');
  el.id = 'warpSplash';
  el.setAttribute('aria-hidden', 'true');
  el.classList.add(k === 'core' ? 'mode-core' : 'mode-warp');
  if (k === 'core') buildCore(el);
  else buildWarp(el);
  app.appendChild(el);
  overlay = el;
  return el;
}

/** 起播并等待：boot=true 允许任意键 / 触摸跳过；onFlash 在锁定闪光峰值触发（用于换边）。
 *  motionMs 是运动时间轴的实际长度（已含速度倍率）；淡出接在末尾，总时长与它一致。 */
function run(el: HTMLDivElement, motionMs: number, boot: boolean, onFlash?: () => void): Promise<void> {
  el.classList.remove('on');
  void el.offsetWidth; // 强制重排：display:none 会取消动画，重新显示即从头播
  el.classList.add('on');

  return new Promise<void>((resolve) => {
    let done = false;
    let ending = false;
    let fadeAnim: Animation | null = null;
    let timer = 0;

    const finish = (): void => {
      if (done) return;
      done = true;
      el.classList.remove('on');
      clearTimeout(timer);
      fadeAnim?.cancel();
      fadeAnim = null;
      removeEventListener('keydown', skip, true);
      removeEventListener('pointerdown', skip, true);
      resolve();
    };
    const skip = (): void => finish();

    /** 收尾：不再把根动画硬跳到末尾淡出帧，而是在顶层叠一段透明度过渡，
     *  下层运动照原速跑完，观感是整体渐渐隐去，而不是画面突然切走。 */
    const smoothEnd = (): void => {
      if (done || ending) return;
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

    if (boot) {
      // 冷启动允许任意键 / 触摸跳过；全屏切换不做跳过，避免换边被掐断
      addEventListener('keydown', skip, true);
      addEventListener('pointerdown', skip, true);
    }
    // 锁定闪光在 CSS 时间轴的 36.5%（核心 1.02s + 0.14 × 0.55s），换边要压在它正下方
    if (onFlash) setTimeout(onFlash, Math.round(motionMs * 0.365));
  });
}

/** 播一次核心启动 / 压缩段。boot=true 为冷启动整段。 */
function playCore(boot: boolean, onFlash?: () => void): Promise<void> {
  const el = ensure('core');
  // 速度倍率只缩放这两段转场；改设置时已写入缓存，冷启动 / 切换都读同一份
  const speed = cachedAnimSpeed();
  // 全屏压缩段仍走最短亮场；冷启动 5.0s / speed 远高于它，只作为极端倍率兜底
  const minMs = bootMinMs(speed);
  // 冷启动按 BOOT_MS 取整段（不再额外乘 CALM）；压缩段保留原来的 1.25 呼吸感
  const base = boot ? BOOT_MS / speed : SWAP_MS / speed;
  const motion = boot
    ? Math.round(Math.max(minMs + 200, base))
    : Math.round(Math.max(minMs + 200, base) * CALM);
  if (!el) {
    onFlash?.();
    return Promise.resolve();
  }
  // CSS 时间轴仍按 3.0s 撰写，--k 把整段换算到实际 motion
  el.style.setProperty('--k', String(motion / CORE_BASE_MS));
  // boot 决定用整段排版还是压缩排版（压缩段去掉遥测 / 日志 / 网格 / 进度）
  el.classList.toggle('boot', boot);
  return run(el, motion, boot, onFlash);
}

/** 播一次流光跃迁（只用于冷启动）。 */
function playWarp(): Promise<void> {
  const el = ensure('warp');
  const speed = cachedAnimSpeed();
  const minMs = bootMinMs(speed);
  const motion = Math.round(Math.max(minMs + 200, BOOT_MS / speed));
  if (!el) return Promise.resolve();
  el.style.setProperty('--wv-dur', `${motion}ms`);
  return run(el, motion, true);
}

/** 设置页切换档位 / 速度时立即预览一次完整动画：否则改完要等下次启动才看得到，像「改了没反应」。
 *  预览同样按当前速度倍率播放；关闭档不播。 */
export function previewBootAnim(mode: BootAnim): void {
  if (reduced() || mode === 'off' || warpBusy()) return;
  if (mode === 'warp') void playWarp();
  // 预览播完整版核心启动；压缩段只用于全屏换边，避免设置页看到的不是启动动画本身
  else void playCore(true);
}

/** 冷启动：按设置的档位播，窗口 / 全屏都播；系统「减少动态效果」时跳过。
 *  之前只在全屏模式播，导致窗口模式下改「启动与转场速度」完全无感。 */
export async function initSplash(): Promise<void> {
  if (reduced()) return;
  const mode = cachedBootAnim();
  if (mode === 'off') return;
  await (mode === 'warp' ? playWarp() : playCore(true));
}

export interface WarpOptions {
  /** 转场进行中时直接丢弃本次请求，而不是排队。
   *  全屏开关这类「只有最终状态有意义」的动作必须用它：否则同一按键的第二次
   *  投递会在动画播完后把刚进入的全屏又切回去（日志里成对的进入 / 退出）。 */
  dropIfBusy?: boolean;
}

/** 全屏切换：进入 / 退出都播核心压缩段（1.0s），换边藏在锁定闪光下。 */
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
  await playCore(false, () => {
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

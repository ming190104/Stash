/** 冷启动动画（设置 · 外观 → 启动动画）：
 *    core = S-01 核心启动 3.0s（默认）/ warp = S-03 流光跃迁 2.2s / off = 关闭。
 *  全屏切换固定用核心压缩段 1.0s（「全屏模式切换动画」），进入 / 退出都播。
 *  两套视觉都只用 transform / opacity，颜色全部走主题令牌（十套主题含白昼自动适配）；
 *  换边发生在锁定闪光那一刻，藏在遮罩下完成。 */

import { cachedAnimSpeed, cachedBootAnim, cachedFullscreen } from './ui';

/** 核心启动整段基准时长（CSS 时间轴按 3.0s 写死） */
const CORE_MS = 3000;
/** 全屏切换压缩段 */
const SWAP_MS = 1000;
/** 流光跃迁整段 */
const WARP_MS = 2200;
/** 冷启动最短亮场：数据再快也先立住 1.2s 再进淡出 */
const MIN_BOOT_MS = 1200;
const STREAKS = 56;
const TRAILS = 20;

let overlay: HTMLDivElement | null = null;
/** 当前构建的是哪一套（设置切换后下次播放会重建） */
let kind: 'core' | 'warp' | null = null;
/** 切换串行队列：保证连续点击按顺序换边 */
let queue: Promise<void> = Promise.resolve();
/** 是否有转场在跑（含排队中）：全屏这种幂等开关靠它丢弃重复请求 */
let pending = 0;
/** 冷启动转场提前收尾的钩子（null = 没在播 / 已经收尾） */
let earlyEnd: (() => void) | null = null;

/** 数据与首屏先于动画就绪时提前收尾：把整段根动画跳到淡出起点，
 *  内部元素定格当作收尾帧，剩余 6%（核心）/ 14%（跃迁）仍按原关键帧淡出。
 *  没在播、已播完、或设置里关了启动动画时都是空操作。 */
export function endSplash(): void {
  earlyEnd?.();
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

  // 顶部状态条：SCANNING CORE → CORE LOCKED
  const read = mk('wp-read');
  read.append(span('wp-s1', 'SCANNING CORE'), span('wp-s2', 'CORE LOCKED'));

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
    span('wp-t2', 'BOOT 1.0.1'),
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

  // 中心亮点 + 三道加速环
  const core = mk('wv-core');
  const rings = mk('wv-rings');
  rings.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));

  // 白闪时的横向速度线
  const burst = mk('wv-burst');
  burst.append(document.createElement('i'), document.createElement('i'));

  // HUD：四角与角标
  const hud = mk('wv-hud');
  for (const c of ['wv-tl', 'wv-tr', 'wv-bl', 'wv-br']) hud.appendChild(span(`wv-corner ${c}`, ''));
  hud.append(span('wv-t1', 'STASH // WARP DRIVE'), span('wv-t2', 'LINK 04MS'));

  // 顶部状态条：WARP DRIVE → LINK LOCKED
  const read = mk('wv-read');
  read.append(span('wv-s1', 'WARP DRIVE'), span('wv-s2', 'LINK LOCKED'));

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

/** 起播并等待：boot=true 允许任意键 / 触摸跳过；onFlash 在锁定闪光峰值触发（用于换边） */
function run(el: HTMLDivElement, dur: number, boot: boolean, onFlash?: () => void): Promise<void> {
  el.classList.remove('on');
  void el.offsetWidth; // 强制重排：display:none 会取消动画，重新显示即从头播
  el.classList.add('on');

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      earlyEnd = null;
      el.classList.remove('on');
      clearTimeout(timer);
      removeEventListener('keydown', skip, true);
      removeEventListener('pointerdown', skip, true);
      resolve();
    };
    const skip = (): void => finish();
    let timer = window.setTimeout(finish, dur);

    if (boot) {
      // 冷启动允许任意键 / 触摸跳过；全屏切换不做跳过，避免换边被掐断
      addEventListener('keydown', skip, true);
      addEventListener('pointerdown', skip, true);
      const started = performance.now();
      const jump = (): void => {
        // 只跳根元素的整段动画：内部元素定格正好当成收尾帧，之后的淡出仍由原关键帧完成
        const root = el.getAnimations?.()[0];
        const full = Number(root?.effect?.getComputedTiming().duration ?? 0);
        if (!root || !Number.isFinite(full) || full <= 0) {
          finish();
          return;
        }
        // 淡出起点与 CSS 关键帧一致：wpc-out 94% / wv-out 86%
        const fadeAt = el.classList.contains('mode-core') ? 0.94 : 0.86;
        root.currentTime = full * fadeAt;
        clearTimeout(timer);
        timer = window.setTimeout(finish, Math.max(120, Math.round(full * (1 - fadeAt))));
      };
      earlyEnd = () => {
        // 保底亮 1.2s：数据再快也先让启动画面立住，之后才进淡出
        const wait = Math.max(0, MIN_BOOT_MS - (performance.now() - started));
        clearTimeout(timer);
        if (wait > 0) timer = window.setTimeout(jump, wait);
        else jump();
        earlyEnd = null;
      };
    }
    if (onFlash) setTimeout(onFlash, Math.round(dur * 0.365));
  });
}

/** 播一次核心启动 / 压缩段。boot=true 为冷启动整段。 */
function playCore(boot: boolean, onFlash?: () => void): Promise<void> {
  const el = ensure('core');
  // 速度倍率只缩放这两段转场；改设置时已写入缓存，冷启动 / 切换都读同一份
  const dur = Math.round((boot ? CORE_MS : SWAP_MS) / cachedAnimSpeed());
  if (!el) {
    onFlash?.();
    return Promise.resolve();
  }
  el.style.setProperty('--k', String(dur / CORE_MS));
  // boot 决定用整段排版还是压缩排版（压缩段去掉遥测 / 日志 / 网格 / 进度）
  el.classList.toggle('boot', boot);
  return run(el, dur, boot, onFlash);
}

/** 播一次流光跃迁（只用于冷启动）。 */
function playWarp(): Promise<void> {
  const el = ensure('warp');
  const dur = Math.round(WARP_MS / cachedAnimSpeed());
  if (!el) return Promise.resolve();
  el.style.setProperty('--wv-dur', `${dur}ms`);
  return run(el, dur, true);
}

/** 冷启动：按设置的档位播；仅全屏模式播，窗口模式直接进库。 */
export async function initSplash(): Promise<void> {
  if (reduced() || !cachedFullscreen()) return;
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

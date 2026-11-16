/** 交互音效：方向移动 / 确认 / 返回 / 开关 / 报错 / 启动。
 *  全部用 WebAudio 现场合成，不打包任何音频文件（安装包体积与离线可用性都不受影响）。
 *  - 首次交互时才创建 AudioContext：浏览器自动播放策略要求一次用户手势；
 *  - 总音量跟随设置（`sound.enabled` / `sound.gain`），关闭后既有节点立即静音；
 *  - 全部是 20–160ms 的短音，长按方向键时 move 另有 55ms 节流，不会连成噪音。 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let gain = 0.6;
let lastMove = 0;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6);

/** 设置回灌 / 改设置时调用：只改总增益，不重建上下文 */
export function applySoundSettings(s: { sound?: { enabled?: boolean; gain?: number } }): void {
  enabled = s.sound?.enabled !== false;
  gain = clamp01(s.sound?.gain ?? 0.6);
  if (master) master.gain.value = enabled ? gain * 0.5 : 0;
}

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = gain * 0.5;
      master.connect(ctx.destination);
    } catch {
      return null; // 无音频设备：静默降级，绝不能让交互抛错
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 启动动画音效复用同一个上下文与总增益：
 *  另开一个 AudioContext 会和交互音效各走一套音量，用户调音量时只关掉一半声音。
 *  音效总开关关闭时返回 null，启动音同样静默。 */
export function audioBus(): { ctx: AudioContext; master: GainNode } | null {
  const c = ac();
  if (!c || !master) return null;
  return { ctx: c, master };
}

/** 单个音：可选从 freq 滑到 to，delay 用于两三个音组成短动机 */
function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  vol: number,
  opts: { to?: number; delay?: number } = {},
): void {
  const c = ac();
  if (!c || !master) return;
  const t0 = c.currentTime + (opts.delay ?? 0);
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (opts.to) o.frequency.exponentialRampToValueAtTime(Math.max(40, opts.to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

export const sfx = {
  /** 方向移动 / 摇杆导航（长按重复时 55ms 内只响一次） */
  move(): void {
    const now = performance.now();
    if (now - lastMove < 55) return;
    lastMove = now;
    tone(1500, 0.022, 'sine', 0.09);
  },
  /** A / 确认：上五度两连音 */
  confirm(): void {
    tone(740, 0.05, 'sine', 0.12);
    tone(1108, 0.07, 'sine', 0.1, { delay: 0.045 });
  },
  /** B / 返回：下滑音 */
  back(): void {
    tone(520, 0.07, 'sine', 0.1, { to: 392 });
  },
  /** 开关 / 勾选：按方向给不同音高 */
  toggle(on: boolean): void {
    tone(on ? 880 : 520, 0.045, 'triangle', 0.1);
  },
  /** 菜单键 / 快捷键面板 */
  menu(): void {
    tone(660, 0.06, 'triangle', 0.1, { to: 880 });
  },
  /** 报错 toast */
  error(): void {
    tone(196, 0.12, 'triangle', 0.12);
    tone(165, 0.16, 'triangle', 0.1, { delay: 0.06 });
  },
  /** 启动游戏：三音上行 */
  launch(): void {
    [523, 659, 784].forEach((f, i) => tone(f, 0.09, 'sine', 0.1, { delay: i * 0.06 }));
  },
};

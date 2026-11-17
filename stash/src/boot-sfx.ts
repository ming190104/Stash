/** 启动动画音效：与 splash 的运动时间轴同源，不另讲一个故事。
 *  连续层跟着画面里真实发生的运动走（光丝 / 加速环 / 刻度），只保留两记硬事件：白闪、就绪。
 *  - 全部 WebAudio 现场合成，不打包音频文件；
 *  - 复用 sfx.ts 的 AudioContext 与总增益，设置里关掉音效就一起静默；
 *  - 所有时刻以 base 为原点、按 K 缩放，速度档改的是整段时间，不改叙事顺序。
 *  - 冷启动与全屏切换共用这一段，时长与画面完全一致。 */

import { audioBus } from './sfx';
import type { BootAnim } from './types';

/** 与 splash.ts 的 BOOT_MS 对齐：基准速度下音频正好铺满画面 */
const BOOT_MS = 5000;
/** 复合音的峰值比单音高，总线留一点余量，避免 2× 时几个音叠在一起削波 */
const VOLUME = 0.9;
/** EVA 三套谱叠得更多，总线再收一点，剩下的交给压缩器 */
const EVA_VOLUME = 0.86;

type ToneOpts = {
  f0: number;
  f1?: number;
  at?: number;
  dur?: number;
  gain?: number;
  attack?: number;
  release?: number;
  type?: OscillatorType;
  pan?: number;
};

type NoiseOpts = {
  at?: number;
  dur?: number;
  gain?: number;
  attack?: number;
  release?: number;
  f0?: number;
  f1?: number;
  type?: BiquadFilterType;
  q?: number;
  pan?: number;
  /** 声像从 pan 线性移到 pan1：扫描 / 刷光用它贴住画面里的横向运动 */
  pan1?: number;
};

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let base = 0;
let K = 1;

function getNoise(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = Math.floor(c.sampleRate * 2);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

/** 打击 / 摩擦通用的包络：起音到峰值，保持，再指数落回静音 */
function env(
  c: AudioContext,
  at: number,
  peak: number,
  dur: number,
  attack: number,
  release: number,
): GainNode {
  const g = c.createGain();
  const a = Math.max(0.001, Math.min(attack, dur * 0.5));
  const r = Math.max(0.01, Math.min(release, dur - a - 0.002));
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + a);
  const hold = at + dur - r;
  if (hold > at + a) g.gain.setValueAtTime(Math.max(0.0002, peak), hold);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  return g;
}

function panned(c: AudioContext, node: AudioNode, p: number): AudioNode {
  if (!p) return node;
  const s = c.createStereoPanner();
  s.pan.value = Math.max(-1, Math.min(1, p));
  node.connect(s);
  return s;
}

function tone(c: AudioContext, dest: AudioNode, o: ToneOpts): void {
  const at = base + (o.at ?? 0) * K;
  const dur = Math.max(0.012, (o.dur ?? 0.2) * K);
  const osc = c.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(20, o.f0), at);
  if (o.f1 && o.f1 !== o.f0) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), at + dur);
  }
  const g = env(c, at, o.gain ?? 0.02, dur, (o.attack ?? 0.005) * K, (o.release ?? dur * 0.6) * K);
  osc.connect(g);
  panned(c, g, o.pan ?? 0).connect(dest);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

function noise(c: AudioContext, dest: AudioNode, o: NoiseOpts): void {
  const at = base + (o.at ?? 0) * K;
  const dur = Math.max(0.012, (o.dur ?? 0.4) * K);
  const src = c.createBufferSource();
  src.buffer = getNoise(c);
  src.loop = true;
  const flt = c.createBiquadFilter();
  flt.type = o.type ?? 'bandpass';
  flt.frequency.setValueAtTime(Math.max(40, o.f0 ?? 800), at);
  if (o.f1 && o.f1 !== o.f0) {
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), at + dur);
  }
  flt.Q.value = o.q ?? 0.8;
  const g = env(c, at, o.gain ?? 0.015, dur, (o.attack ?? 0.05) * K, (o.release ?? 0.18) * K);
  src.connect(flt);
  flt.connect(g);
  if (o.pan1 == null) {
    panned(c, g, o.pan ?? 0).connect(dest);
  } else {
    const p = c.createStereoPanner();
    p.pan.setValueAtTime(Math.max(-1, Math.min(1, o.pan ?? 0)), at);
    p.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, o.pan1)), at + dur);
    g.connect(p);
    p.connect(dest);
  }
  src.start(at);
  src.stop(at + dur + 0.05);
}

function click(c: AudioContext, dest: AudioNode, at: number, freq: number, gain = 0.008, pan = 0): void {
  tone(c, dest, { f0: freq, dur: 0.012, type: 'sine', gain, at, attack: 0.001, release: 0.004, pan });
}

/** 刻度：间隔从 gap0 收到 gap1，正好是「越转越快」的那段 */
function ticks(
  c: AudioContext,
  dest: AudioNode,
  t0: number,
  dur: number,
  gap0: number,
  gap1: number,
  freq: number,
  gain: number,
): void {
  let t = 0;
  let i = 0;
  while (t < dur) {
    const f = t / dur;
    click(c, dest, t0 + t, freq + (i % 4) * 90, gain * (0.62 + 0.38 * f), i % 2 ? 0.05 : -0.05);
    t += gap0 + (gap1 - gap0) * f;
    i++;
  }
}

function ringBoom(c: AudioContext, dest: AudioNode, at: number, gain: number): void {
  tone(c, dest, { f0: 58, f1: 42, dur: 0.5, type: 'sine', gain, at, attack: 0.008, release: 0.46 });
  noise(c, dest, {
    at, dur: 0.42, type: 'lowpass', f0: 220, q: 0.6, gain: gain * 0.35, attack: 0.02, release: 0.38,
  });
}

function subHit(c: AudioContext, dest: AudioNode, at: number, gain: number, f0: number, f1: number, dur = 0.55): void {
  tone(c, dest, { f0, f1, dur, type: 'sine', gain, at, attack: 0.004, release: dur * 0.9 });
}

/** 硬事件：一记点击 + 中频 + 低频鼓包，三件套同时落在一个时刻 */
function impact(c: AudioContext, dest: AudioNode, at: number, gain: number, f0: number, f1: number): void {
  click(c, dest, at, 3000, gain * 0.2);
  tone(c, dest, { f0: 1240, dur: 0.18, type: 'triangle', gain: gain * 0.28, at, attack: 0.002, release: 0.16 });
  subHit(c, dest, at, gain, f0, f1, 0.58);
}

/** 就绪：两套动画共用的品牌声，换动画不换它 */
function confirm(c: AudioContext, dest: AudioNode, at: number, gain = 0.012): void {
  click(c, dest, at, 2400, gain, 0.04);
  click(c, dest, at + 0.006, 1500, gain * 0.55, 0.04);
  tone(c, dest, { f0: 659.25, dur: 0.34, type: 'sine', gain: gain * 1.5, at, attack: 0.003, release: 0.3, pan: 0.04 });
}

/* ===== EVA 三套谱：与 design/launch-eva.html 共用同一张时间表 =====
   .00 通电 · .40/.54 条纹合闸 · .10–.62 画框起笔 · .58–1.25 MAGI
   .70–2.90 扫描（NERV） / .80–2.70 神经电路（01） / .45–4.30 火星（明日香）
   2.10/2.45 心跳（01） · 2.55–3.40 警告 · 3.30 光爆
   3.60–3.90 铭牌/切削 · 3.70–3.86 字标 · 4.10–4.30 接地 · 4.50–4.95 收尾 */

type AirOpts = {
  f0: number;
  f1?: number;
  dur: number;
  gain: number;
  type?: BiquadFilterType;
  q?: number;
  attack?: number;
  release?: number;
};

/** 极短的金属瞬态：条纹合闸、数据刻度、火星都用它 */
function evaClick(c: AudioContext, dest: AudioNode, at: number, f: number, gain = 0.006): void {
  noise(c, dest, { at, dur: 0.035, type: 'bandpass', f0: f, q: 2.2, gain, attack: 0.001, release: 0.03 });
}

/** 低频冲击：落锁、心跳、光爆 */
function evaHit(
  c: AudioContext,
  dest: AudioNode,
  at: number,
  f0: number,
  f1: number,
  dur: number,
  gain: number,
): void {
  tone(c, dest, { f0, f1, dur, gain, at, attack: 0.003, release: dur * 0.94 });
}

/** 确认音 / 声呐：正弦为主，长度决定是“叮”还是“余响” */
function evaBell(
  c: AudioContext,
  dest: AudioNode,
  at: number,
  f: number,
  dur: number,
  gain: number,
  type: OscillatorType = 'sine',
  attack = 0.006,
): void {
  tone(c, dest, { f0: f, dur, type, gain, at, attack, release: dur * 0.92 });
}

/** 噪声层：底噪、扫描、刀锋、溅起 */
function evaAir(c: AudioContext, dest: AudioNode, at: number, o: AirOpts): void {
  noise(c, dest, { at, ...o });
}

/** 初号机 · 生物：湿的低频、互相拍频的正弦、两记心跳；没有锯齿 */
function evaScore01(c: AudioContext, out: AudioNode): void {
  evaHit(c, out, 0, 64, 36, 0.55, 0.07);
  evaAir(c, out, 0, { f0: 260, f1: 900, dur: 0.5, gain: 0.015, attack: 0.02 });

  // 画框起笔：四次很轻的落笔
  [0.12, 0.22, 0.32, 0.42].forEach((t, i) => evaClick(c, out, t, 1400 + i * 240, 0.005));

  // 条纹合闸：两记湿的闷响，第二记更轻
  evaHit(c, out, 0.4, 72, 40, 0.34, 0.048);
  evaAir(c, out, 0.4, { f0: 700, f1: 380, dur: 0.2, gain: 0.011, q: 1.2 });
  evaHit(c, out, 0.54, 66, 38, 0.28, 0.032);

  // .10–3.1 底：两条近乎同频的正弦互相拍频，像 LCL 里的回声
  tone(c, out, { f0: 41, f1: 47, dur: 3.0, gain: 0.02, at: 0.1, attack: 0.9, release: 1.0 });
  tone(c, out, { f0: 61.5, f1: 66, dur: 2.9, gain: 0.01, at: 0.2, attack: 0.9, release: 1.0, type: 'triangle' });
  // 123Hz 的二次谐波：小音箱上也能听见“呼吸”
  tone(c, out, { f0: 123, f1: 132, dur: 2.8, gain: 0.006, at: 0.3, attack: 0.9, release: 0.9, type: 'triangle' });
  evaAir(c, out, 0.1, { f0: 130, f1: 320, dur: 3.1, gain: 0.012, attack: 0.8, release: 1.0, type: 'lowpass' });

  // MAGI：三记温的正弦确认，间距比其余两套松
  [523.25, 659.25, 783.99].forEach((f, i) => evaBell(c, out, 0.58 + i * 0.2, f, 0.55, 0.0075, 'sine', 0.02));

  // 数据刻度：稀疏、偏软
  for (let t = 0.75, i = 0; t < 3.0; t += 0.075, i++) {
    tone(c, out, { f0: 1200 + (i % 4) * 180, dur: 0.02, type: 'sine', gain: 0.003, at: t, attack: 0.002, release: 0.018 });
  }

  // .80–2.70 神经电路：电流由低往上爬，节点处补四记突触轻响
  evaAir(c, out, 0.8, { f0: 380, f1: 2600, dur: 1.9, gain: 0.008, attack: 0.5, release: 0.7 });
  [1.62, 1.82, 1.98, 2.13].forEach((t, i) => evaClick(c, out, t, 3200 + i * 340, 0.0055));

  // 2.10 / 2.45 心跳与数字搏动同一拍：两记“lub”，第二记更重
  [2.1, 2.45].forEach((t, i) => {
    evaHit(c, out, t, 58 + i * 2, 36, 0.24, 0.052 + i * 0.012);
    evaAir(c, out, t + 0.012, { f0: 520, f1: 260, dur: 0.16, gain: 0.009, q: 1.1 });
  });

  // .95–3.15 同步率：呼吸般上扬的正弦
  tone(c, out, { f0: 154, f1: 392, dur: 2.15, type: 'sine', gain: 0.012, at: 0.95, attack: 0.7, release: 0.7 });
  tone(c, out, { f0: 155.5, f1: 394, dur: 2.1, type: 'triangle', gain: 0.0055, at: 0.97, attack: 0.7, release: 0.7 });

  // 2.65–3.35 警告：不是警笛，是两记低音兽吼 + 轻微拍频
  tone(c, out, { f0: 220, f1: 214, dur: 0.5, type: 'triangle', gain: 0.014, at: 2.66, attack: 0.05, release: 0.44 });
  tone(c, out, { f0: 231, f1: 225, dur: 0.5, type: 'triangle', gain: 0.01, at: 2.66, attack: 0.05, release: 0.44 });
  tone(c, out, { f0: 165, f1: 158, dur: 0.52, type: 'triangle', gain: 0.015, at: 2.98, attack: 0.05, release: 0.47 });

  // 3.30 光爆：次低频砸下去，尾部带一点湿的液体感
  evaHit(c, out, 3.3, 104, 26, 1.0, 0.1);
  evaAir(c, out, 3.3, { f0: 3200, f1: 150, dur: 0.55, gain: 0.065, type: 'lowpass' });
  evaAir(c, out, 3.31, { f0: 4600, dur: 0.3, gain: 0.009, type: 'highpass' });
  evaAir(c, out, 3.33, { f0: 900, f1: 260, dur: 0.55, gain: 0.016, q: 1.2 });
  tone(c, out, { f0: 2450, f1: 2370, dur: 0.8, type: 'triangle', gain: 0.0045, at: 3.32, attack: 0.002, release: 0.76 });

  // 3.70 字标：C–G–C 的暖三音，跟着字母逐个落定
  evaBell(c, out, 3.72, 392, 0.5, 0.0095, 'sine', 0.008);
  evaBell(c, out, 3.79, 587.33, 0.45, 0.0065, 'sine', 0.008);
  evaBell(c, out, 3.86, 783.99, 0.5, 0.004, 'triangle', 0.01);

  // 接地线亮起两次：两记很短的电流“嗒”
  [3.76, 4.1].forEach((t) => {
    evaClick(c, out, t, 5200, 0.0045);
    tone(c, out, { f0: 3100, f1: 2900, dur: 0.05, type: 'sine', gain: 0.003, at: t, attack: 0.002, release: 0.045 });
  });

  // 4.15–4.95 收尾：一次呼气
  evaAir(c, out, 4.15, { f0: 900, f1: 180, dur: 0.8, gain: 0.012, attack: 0.2, release: 0.72, type: 'lowpass' });
  tone(c, out, { f0: 48, f1: 40, dur: 0.8, gain: 0.01, at: 4.15, attack: 0.25, release: 0.72 });
}

/** 明日香 · 兵器：金属拍击、密一倍的刻度、四记快闪警告、刀锋一记横切 */
function evaScoreAska(c: AudioContext, out: AudioNode): void {
  evaAir(c, out, 0, { f0: 2800, dur: 0.14, gain: 0.026, type: 'highpass' });
  evaHit(c, out, 0, 190, 60, 0.3, 0.045);
  evaClick(c, out, 0, 4200, 0.009);

  // .10–.62 画框：一条快速伺服滑轨，收尾一记锁止
  evaAir(c, out, 0.1, { f0: 1200, f1: 4400, dur: 0.32, gain: 0.011, attack: 0.02, q: 1.8 });
  evaClick(c, out, 0.62, 3000, 0.007);

  // 条纹合闸：两记金属拍击，第二记更脆
  [0.4, 0.54].forEach((t, i) => {
    evaAir(c, out, t, { f0: 3400, f1: 1200, dur: 0.09, gain: 0.024 - i * 0.006, q: 1.4 });
    evaClick(c, out, t, 2600 + i * 500, 0.0065);
    tone(c, out, { f0: 980 - i * 180, f1: 280, dur: 0.1, type: 'triangle', gain: 0.0055, at: t, attack: 0.002, release: 0.09 });
  });

  // .12–3.2 张力底：细锯齿 + 高频空气，像装备通电待击
  tone(c, out, { f0: 96, f1: 104, dur: 3.0, gain: 0.007, at: 0.12, attack: 0.8, release: 0.8, type: 'sawtooth' });
  evaAir(c, out, 0.12, { f0: 2400, dur: 3.0, gain: 0.0035, attack: 0.7, release: 0.8, type: 'highpass' });

  // 火星：.45–4.30 稀疏爆点，越到后面越密
  let t = 0.45;
  while (t < 4.3) {
    const life = (t - 0.45) / 3.85;
    evaClick(c, out, t, 4200 + Math.random() * 2600, 0.002 + life * 0.0024);
    t += 0.34 - life * 0.2 + Math.random() * 0.18;
  }

  // MAGI：三记逼近的方波装填音
  [1568, 1760, 1975].forEach((f, i) => {
    tone(c, out, { f0: f * 1.12, dur: 0.045, type: 'square', gain: 0.0075, at: 0.58 + i * 0.045, attack: 0.001, release: 0.04 });
  });

  // 数据刻度：密一倍，带扫频感
  for (let tt = 0.7, i = 0; tt < 3.0; tt += 0.048, i++) {
    tone(c, out, { f0: (2400 + (i % 6) * 320) * 1.12, dur: 0.012, type: 'square', gain: 0.003, at: tt, attack: 0.001, release: 0.01 });
  }

  // .95–3.15 同步率：棘轮一格一格咬上去，底下垫一条上扫锯
  for (let tt = 0.95, i = 0; tt < 2.95; tt += 0.055, i++) {
    tone(c, out, { f0: (900 + i * 16) * 1.12, dur: 0.016, type: 'square', gain: 0.0022, at: tt, attack: 0.001, release: 0.014 });
  }
  tone(c, out, { f0: 240, f1: 1180, dur: 2.0, type: 'sawtooth', gain: 0.01, at: 0.98, attack: 0.4, release: 0.6 });

  // 2.55–3.40 快闪警告：四记短鸣，和 ev-warn-fast 的四个亮拍对齐
  [2.55, 2.75, 2.95].forEach((tt) => {
    tone(c, out, { f0: 1244 * 1.12, dur: 0.075, type: 'square', gain: 0.018, at: tt, attack: 0.002, release: 0.06 });
    evaClick(c, out, tt, 3600, 0.0055);
  });
  // 第四拍拉长压到光爆前，制造“警报没停就炸了”的错位
  tone(c, out, { f0: 1244 * 1.12, dur: 0.22, type: 'square', gain: 0.019, at: 3.15, attack: 0.002, release: 0.18 });
  evaAir(c, out, 2.9, { f0: 600, f1: 3800, dur: 0.38, gain: 0.011, attack: 0.1, q: 1.2 });

  // 3.30 光爆：鞭击式，先脆后沉，尾巴短
  evaAir(c, out, 3.3, { f0: 5200, f1: 900, dur: 0.2, gain: 0.045, q: 0.8 });
  evaHit(c, out, 3.3, 128, 40, 0.5, 0.07);
  tone(c, out, { f0: 3150, f1: 3050, dur: 0.9, type: 'triangle', gain: 0.0055, at: 3.31, attack: 0.002, release: 0.85 });
  tone(c, out, { f0: 3280, f1: 3180, dur: 0.9, type: 'triangle', gain: 0.0035, at: 3.31, attack: 0.002, release: 0.85 });

  // 3.65–3.90 切削：刀锋掠过 + 一记硬止
  evaAir(c, out, 3.66, { f0: 6800, f1: 1700, dur: 0.22, gain: 0.024, attack: 0.006, q: 2.4 });
  tone(c, out, { f0: 4186, dur: 0.5, type: 'triangle', gain: 0.004, at: 3.72, attack: 0.002, release: 0.46 });
  tone(c, out, { f0: 2793, dur: 0.4, type: 'triangle', gain: 0.0028, at: 3.73, attack: 0.002, release: 0.36 });
  evaClick(c, out, 3.9, 3000, 0.0055);

  // 3.70 字标：两记短促的装填确认，比另外两套更高更硬
  tone(c, out, { f0: 880 * 1.12, dur: 0.22, type: 'square', gain: 0.007, at: 3.72, attack: 0.002, release: 0.2 });
  tone(c, out, { f0: 1320 * 1.12, dur: 0.18, type: 'triangle', gain: 0.0055, at: 3.8, attack: 0.002, release: 0.16 });

  // 4.50 收尾：伺服回位，干脆利落地停
  evaAir(c, out, 4.5, { f0: 3000, f1: 800, dur: 0.22, gain: 0.011, q: 1.5 });
  evaClick(c, out, 4.72, 2400, 0.0045);
}

/** 零号机：与 NERV 同源的设施底噪，叠加一条更冷的下行正弦与高音点 */
function evaScore00(c: AudioContext, out: AudioNode): void {
  evaScoreNerv(c, out);
  tone(c, out, { f0: 61.7, dur: 3, gain: 0.006, at: 0.3, attack: 0.9, release: 1, type: 'sine' });
  tone(c, out, { f0: 1174, dur: 0.5, gain: 0.0045, at: 1.12, attack: 0.012, release: 0.4, type: 'sine' });
}

/** NERV · 设施：液压、绘图仪、扫描下行与声呐锁定；警告是广播两音 */
function evaScoreNerv(c: AudioContext, out: AudioNode): void {
  evaHit(c, out, 0, 66, 38, 0.5, 0.06);
  evaAir(c, out, 0, { f0: 900, f1: 200, dur: 0.38, gain: 0.02, type: 'lowpass' });
  evaClick(c, out, 0, 1800, 0.006);

  // .10/.22/.32/.42 画框：四记等距落笔，和四条边一一对应
  [0.1, 0.22, 0.32, 0.42].forEach((tt, i) => {
    tone(c, out, { f0: 1800 + i * 120, dur: 0.03, type: 'square', gain: 0.005, at: tt, attack: 0.001, release: 0.026 });
    evaClick(c, out, tt, 2200, 0.0035);
  });
  evaClick(c, out, 0.62, 1800, 0.005);

  // 条纹合闸：机构落锁，两记一样重
  [0.4, 0.54].forEach((tt) => {
    evaHit(c, out, tt, 58, 42, 0.3, 0.038);
    evaClick(c, out, tt, 1500, 0.0055);
  });

  // 底：设施房间的空调低鸣 + 一条很稳的电源音
  evaAir(c, out, 0.08, { f0: 220, dur: 3.2, gain: 0.011, attack: 0.7, release: 0.9, type: 'lowpass' });
  tone(c, out, { f0: 55, dur: 3.2, gain: 0.012, at: 0.08, attack: 0.8, release: 0.9 });
  tone(c, out, { f0: 82.5, dur: 3.1, gain: 0.0045, at: 0.18, attack: 0.8, release: 0.9, type: 'triangle' });

  // .70–2.90 测绘扫描：一条持续下行的带通噪声，就是画面上那条扫描带
  evaAir(c, out, 0.7, { f0: 2600, f1: 480, dur: 2.2, gain: 0.012, attack: 0.25, release: 0.35, q: 2.2 });
  tone(c, out, { f0: 1320, f1: 240, dur: 2.2, type: 'sine', gain: 0.004, at: 0.7, attack: 0.25, release: 0.4 });

  // 1.30 锁定：一声干净的声呐，带回声
  evaBell(c, out, 1.3, 1568 * 0.92, 0.7, 0.008, 'sine', 0.004);
  evaBell(c, out, 1.46, 1568 * 0.92, 0.5, 0.003, 'sine', 0.004);

  // MAGI：三记机构化的长确认音，几乎等距
  [1046.5, 1318.5, 1568].forEach((f, i) => evaBell(c, out, 0.58 + i * 0.19, f * 0.92, 0.4, 0.006));

  // 数据刻度：慢而准，像挂钟
  for (let tt = 0.75; tt < 3.0; tt += 0.09) {
    tone(c, out, { f0: 1400, dur: 0.018, type: 'square', gain: 0.002, at: tt, attack: 0.001, release: 0.016 });
  }

  // .95–3.15 同步率：稳压上升的五度 + 齿轮一格一格的定位音
  tone(c, out, { f0: 196, f1: 294, dur: 2.15, type: 'triangle', gain: 0.009, at: 0.95, attack: 0.6, release: 0.7 });
  tone(c, out, { f0: 392, f1: 588, dur: 2.1, type: 'sine', gain: 0.0045, at: 0.97, attack: 0.7, release: 0.7 });
  for (let tt = 0.95, i = 0; tt < 2.9; tt += 0.12, i++) evaClick(c, out, tt, 1900 + i * 26, 0.0032);

  // 2.65–3.35 警告：设施广播的两音循环，比明日香低、比初号机硬
  let n = 0;
  for (let tt = 2.65; tt < 3.3; tt += 0.34) {
    tone(c, out, { f0: (n % 2 ? 554 : 740) * 0.92, dur: 0.26, type: 'square', gain: 0.013, at: tt, attack: 0.004, release: 0.22 });
    n++;
  }
  evaClick(c, out, 2.64, 1200, 0.0055);

  // 3.30 光爆：整块甲板砸下来的实心冲击
  evaHit(c, out, 3.3, 86, 30, 0.9, 0.09);
  evaAir(c, out, 3.3, { f0: 1800, f1: 140, dur: 0.5, gain: 0.055, type: 'lowpass' });
  tone(c, out, { f0: 392, dur: 1.1, type: 'triangle', gain: 0.0055, at: 3.31, attack: 0.002, release: 1.05 });
  tone(c, out, { f0: 784, dur: 0.8, type: 'sine', gain: 0.003, at: 3.32, attack: 0.002, release: 0.76 });

  // 3.60–3.90 铭牌：先走纸，3.78 整块落位时盖章
  evaAir(c, out, 3.6, { f0: 800, f1: 2600, dur: 0.28, gain: 0.008, attack: 0.02, q: 1.2 });
  evaHit(c, out, 3.78, 72, 34, 0.34, 0.05);
  evaClick(c, out, 3.78, 2600, 0.0055);

  // 3.82 字标确认：两记很干净的正弦，像终端“叮”
  evaBell(c, out, 3.82, 1046.5 * 0.92, 0.45, 0.0075);
  evaBell(c, out, 3.84, 1568 * 0.92, 0.35, 0.004);

  // 收尾：空调声收掉 + 一记继电器
  evaAir(c, out, 4.2, { f0: 220, f1: 160, dur: 0.7, gain: 0.007, attack: 0.2, release: 0.55, type: 'lowpass' });
  evaClick(c, out, 4.62, 1600, 0.0045);
}

/** 跃迁：穿越颗粒 → 三次环 → 刻度 → 速度线 → 白闪 → 落款 → 扫光 → 尾 */
function warpBed(c: AudioContext, out: AudioNode): void {
  noise(c, out, { at: 0, dur: 3.0, type: 'bandpass', f0: 400, f1: 2200, q: 0.9, gain: 0.012, attack: 0.5, release: 1.0 });
  ticks(c, out, 0.1, 2.9, 0.09, 0.022, 1700, 0.0042);
  tone(c, out, { f0: 1400, dur: 0.06, gain: 0.006, at: 0.5, attack: 0.001, release: 0.05 });
  tone(c, out, { f0: 700, dur: 0.09, gain: 0.005, at: 0.5, attack: 0.001, release: 0.08 });
  ringBoom(c, out, 0.7, 0.03);
  ringBoom(c, out, 0.98, 0.022);
  ringBoom(c, out, 1.26, 0.016);
  noise(c, out, { at: 1.6, dur: 1.4, type: 'bandpass', f0: 900, q: 2.2, gain: 0.0055, attack: 0.3, release: 0.5 });
  click(c, out, 2.97, 2400, 0.005);
  tone(c, out, { f0: 200, f1: 150, dur: 0.16, gain: 0.012, at: 2.97, attack: 0.003, release: 0.14 });
  noise(c, out, { at: 3.4, dur: 0.8, type: 'highpass', f0: 2200, q: 0.7, gain: 0.005, attack: 0.24, release: 0.3, pan: -0.45, pan1: 0.45 });
  noise(c, out, { at: 3.0, dur: 2.0, type: 'lowpass', f0: 200, q: 0.6, gain: 0.008, attack: 0.5, release: 1.5 });
  tone(c, out, { f0: 48, dur: 1.9, gain: 0.006, at: 3.0, attack: 0.5, release: 1.3 });
  confirm(c, out, 4.2, 0.012);
}

function warpHit(c: AudioContext, out: AudioNode): void {
  noise(c, out, { at: 2.9, dur: 0.03, type: 'highpass', f0: 3000, q: 0.8, gain: 0.011, attack: 0.002, release: 0.028 });
  impact(c, out, 2.97, 0.055, 60, 36);
}

/** 起播：motionMs 是含速度倍率的实际时长，音频整段按它缩放；
 *  anim 决定用哪套谱——跃迁一套，EVA 三套配色各一套。 */
export function playBootSfx(motionMs: number, anim: BootAnim = 'warp'): void {
  stopBootSfx();
  const io = audioBus();
  if (!io) return;
  ctx = io.ctx;
  K = motionMs / BOOT_MS;
  // 起播留一点调度余量：第一帧就被调用时，currentTime 附近的排程会赶不上
  base = ctx.currentTime + 0.03;

  const out = ctx.createGain();
  bus = out;

  if (anim === 'warp') {
    out.gain.value = VOLUME;
    out.connect(io.master);
    warpBed(ctx, out);
    warpHit(ctx, out);
    return;
  }

  // EVA：三套谱的动态差很多，总线上串一台压缩器；环境不支持时直连
  out.gain.value = EVA_VOLUME;
  const comp = typeof ctx.createDynamicsCompressor === 'function' ? ctx.createDynamicsCompressor() : null;
  if (comp) {
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    out.connect(comp);
    comp.connect(io.master);
  } else {
    out.connect(io.master);
  }

  if (anim === 'eva02') evaScoreAska(ctx, out);
  else if (anim === 'evaNerv') evaScoreNerv(ctx, out);
  else if (anim === 'eva00') evaScore00(ctx, out);
  else evaScore01(ctx, out);
}

/** 停止 / 跳过 / 收尾：90ms 淡出再断开，不要一刀切出咔哒声 */
export function stopBootSfx(): void {
  if (!bus || !ctx) return;
  const c = ctx;
  const old = bus;
  bus = null;
  const t = c.currentTime;
  try {
    old.gain.cancelScheduledValues(t);
    old.gain.setValueAtTime(Math.max(0.0001, old.gain.value), t);
    old.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  } catch {
    /* 上下文已关闭：直接断开即可 */
  }
  setTimeout(() => {
    try {
      old.disconnect();
    } catch {
      /* noop */
    }
  }, 160);
}

/** 手柄键位映射的共享常量与归一化（Rust input.rs 的白名单与此处一一对应）。 */

import type { PadMap, PadTuning } from './types';

/** 默认 Xbox 布局：旧配置缺 padMap 时兜底 */
export const PAD_DEFAULT: PadMap = {
  accept: 'south',
  back: 'east',
  menu: 'start',
  x: 'west',
  y: 'north',
  r: 'rb',
  lb: 'lb',
};

/** 物理键名 → 键帽文字（未知值显示 —，不静默当成 A）。
 *  lt / rt 是 XInput 的两个扳机：掌机的背键常被驱动映射成这两颗。 */
export const PAD_KEY_LABEL: Record<string, string> = {
  south: 'A',
  east: 'B',
  west: 'X',
  north: 'Y',
  start: 'Start',
  select: 'Select',
  mode: 'Mode',
  lb: 'LB',
  rb: 'RB',
  lt: 'LT',
  rt: 'RT',
};

/** 手柄布局：决定键帽显示 A/B/X/Y 还是 ✕/○/□/△ 或 B/A/Y/X。 */
export type PadKind = 'xbox' | 'playstation' | 'nintendo';

/** 三套键帽。物理键名不变，只换 glyph——手感与键位表完全一致。 */
const PAD_GLYPHS: Record<PadKind, Record<string, string>> = {
  xbox: { south: 'A', east: 'B', west: 'X', north: 'Y', start: '≡', select: '⧉', mode: '◉', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT' },
  playstation: { south: '✕', east: '○', west: '□', north: '△', start: '≡', select: '⧉', mode: 'PS', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2' },
  nintendo: { south: 'B', east: 'A', west: 'Y', north: 'X', start: '+', select: '−', mode: 'Home', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR' },
};

/** 按名称猜布局（Windows 上 DualSense 常显示为 "Wireless Controller"）。 */
export function padKindOf(name: string): PadKind {
  const n = name.toLowerCase();
  // Xbox 必须先判：Sony 在 Windows 上的设备名也叫 "Wireless Controller"，
  // 早期把这条泛匹配放在最前面，会把 Xbox 手柄误判成 PlayStation 键帽。
  if (/xbox|microsoft|xinput/.test(n)) return 'xbox';
  if (/switch|joy-?con|pro controller|nintendo/.test(n)) return 'nintendo';
  if (/dualsense|dualshock|playstation|sony|\bps[45]\b|wireless controller/.test(n)) {
    return 'playstation';
  }
  return 'xbox';
}

/** 物理键名 → 当前布局的键帽文字；未知值显示 —，不静默当成 A。 */
export function padGlyph(key: string, kind: PadKind = 'xbox'): string {
  return PAD_GLYPHS[kind]?.[key] ?? PAD_KEY_LABEL[key] ?? '—';
}

/** 旧配置只有 abSwap、没有键位表：把互换结果回填进 padMap，
 *  否则设置页会显示「A/B 互换 = 开」但键位表还是 A/B 默认，一保存就把互换悄悄关掉。 */
export function normalizePadMap(s: { abSwap?: boolean; padMap?: PadMap }): PadMap {
  const base: PadMap = { ...PAD_DEFAULT, ...s.padMap };
  if (s.abSwap && base.accept === 'south' && base.back === 'east') {
    return { ...base, accept: 'east', back: 'south' };
  }
  return base;
}

/** 手感默认值：与 Rust 端 PadTuning::default() 严格一致（有单测对拍）。 */
export const PAD_TUNING_DEFAULT: PadTuning = {
  deadzone: 0.28,
  repeatMs: 60,
  mouseSpeed: 11,
};

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 逐字段收敛：旧配置没有 padTuning、手改配置写进 NaN / 越界都不能让摇杆失灵。 */
export function normalizePadTuning(raw: unknown): PadTuning {
  const r = (raw ?? {}) as Partial<PadTuning>;
  return {
    deadzone: clampNum(r.deadzone, 0.1, 0.45, PAD_TUNING_DEFAULT.deadzone),
    repeatMs: Math.round(clampNum(r.repeatMs, 40, 200, PAD_TUNING_DEFAULT.repeatMs)),
    mouseSpeed: clampNum(r.mouseSpeed, 4, 24, PAD_TUNING_DEFAULT.mouseSpeed),
  };
}

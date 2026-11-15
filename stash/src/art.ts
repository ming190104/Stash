/** 未匹配降级态的占位美术（UI 规范 5.2：正式设计而非临时效果）。
 *  产出与 ui-mockup 的 artHTML 同构：多层渐变 bg + 星光色 s1/s2，
 *  供 .art::before 的 radial 星点层使用；按 id 确定性选择。 */

export interface ArtVars { bg: string; s1: string; s2: string }

interface Palette { a: string; b: string; light: string; mid: string; spark: string }

/** 覆盖 mockup 十部作品的色调域：樱粉/天蓝/冬灰/紫金/夏空/夜城/暖白/酒紫/黑钢/星蓝 */
const PALETTES: Palette[] = [
  { a: '#e07a92', b: '#fbe4ea', light: 'rgba(255,214,224,.9)', mid: 'rgba(240,150,170,.55)', spark: 'rgba(232,90,110,.5)' },
  { a: '#6f9fd0', b: '#e9f1f8', light: 'rgba(255,255,255,.85)', mid: 'rgba(140,180,225,.5)', spark: 'rgba(120,160,220,.5)' },
  { a: '#a9b8c6', b: '#8fa0b0', light: 'rgba(255,255,255,.8)', mid: 'rgba(200,215,230,.5)', spark: 'rgba(255,255,255,.6)' },
  { a: '#5c4a78', b: '#efb163', light: 'rgba(250,200,110,.9)', mid: 'rgba(200,90,110,.45)', spark: 'rgba(200,110,90,.5)' },
  { a: '#3877ad', b: '#d6e9f4', light: 'rgba(255,255,255,.9)', mid: 'rgba(255,255,255,.5)', spark: 'rgba(255,255,255,.55)' },
  { a: '#23262e', b: '#363b46', light: 'rgba(255,120,120,.8)', mid: 'rgba(120,140,170,.25)', spark: 'rgba(255,180,180,.35)' },
  { a: '#7f9cc0', b: '#f0e7d9', light: 'rgba(250,230,200,.8)', mid: 'rgba(255,200,150,.45)', spark: 'rgba(255,220,180,.5)' },
  { a: '#221826', b: '#43263c', light: 'rgba(230,190,120,.75)', mid: 'rgba(200,140,90,.4)', spark: 'rgba(212,175,110,.4)' },
  { a: '#14141d', b: '#2c2940', light: 'rgba(160,150,200,.6)', mid: 'rgba(120,110,160,.35)', spark: 'rgba(140,130,190,.4)' },
  { a: '#0b1322', b: '#33507c', light: 'rgba(255,255,255,.95)', mid: 'rgba(120,160,220,.5)', spark: 'rgba(180,200,255,.5)' },
];

export function paletteFor(id: string): Palette {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

/** 组合 bg：双 radial 高光 + 主 linear 渐变（与 mockup G[].bg 同构） */
export function placeholderArt(id: string): ArtVars {
  const p = paletteFor(id);
  const bg =
    `radial-gradient(120% 85% at 30% 12%,${p.light} 0%,${p.light.replace(/[\d.]+\)$/, '0)')} 55%),` +
    `radial-gradient(90% 70% at 85% 35%,${p.mid} 0%,${p.mid.replace(/[\d.]+\)$/, '0)')} 60%),` +
    `linear-gradient(178deg,${p.a} 0%,${p.b} 100%)`;
  return { bg, s1: 'rgba(255,255,255,.9)', s2: p.spark };
}

/** 兼容旧接口：单行 style 字符串 */
export function placeholderStyle(id: string): string {
  const { bg, s1, s2 } = placeholderArt(id);
  return `background:${bg};--s1:${s1};--s2:${s2}`;
}

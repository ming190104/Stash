/** 设置页各页签共用的小工具：分段选择器 / 主题表 / 手柄键位表 / 文件名。 */
import { PAD_DEFAULT, padGlyph, type PadKind } from '../../padmap';
import type { FpsMode, PadMap, Settings, ThemeName } from '../../types';
import { esc } from '../../ui';

export const FPS_MODES: FpsMode[] = ['auto', '120', '90', '60'];

/** 主题：值与 app.css 的 html[data-theme] 一一对应。
 *  选择器不再铺一排色点，而是收成「一个下拉按钮 + 共用菜单」，掌机上更好扫读。 */
export const THEME_OPTS: { v: ThemeName; label: string }[] = [
  { v: 'cinema', label: '影院暗色' },
  { v: 'oled', label: 'OLED 纯黑' },
  { v: 'sakura', label: '樱夜' },
  { v: 'frost', label: '冷雾' },
  { v: 'contrast', label: '高对比' },
  { v: 'amber', label: '琥珀' },
  { v: 'iris', label: '紫苑' },
  { v: 'moss', label: '苔庭' },
  { v: 'crimson', label: '绯红' },
  { v: 'daybreak', label: '白昼' },
];
export const THEME_LABEL: Record<ThemeName, string> = Object.fromEntries(
  THEME_OPTS.map((t) => [t.v, t.label]),
) as Record<ThemeName, string>;

/** 可改的动作（方向键 / 摇杆是固定导航，不在此列） */
const PAD_ACTIONS: { k: keyof PadMap; label: string }[] = [
  { k: 'accept', label: '确认 / 启动' },
  { k: 'back', label: '返回' },
  { k: 'menu', label: '快捷菜单' },
  { k: 'x', label: '多选 / 批量' },
  { k: 'y', label: '详情 / 结局 / 筛选' },
  { k: 'r', label: '收藏 / 分类右' },
  { k: 'lb', label: '分类左' },
];

/** 手柄键位表；`captureKey` = 正在等待按键的那一行（null = 不在改键态）。
 *  `kind` 决定键帽画 A/B/X/Y、✕/○/□/△ 还是 B/A/Y/X。 */
export function padRowsHTML(
  s: Settings,
  captureKey: keyof PadMap | null,
  kind: PadKind = 'xbox',
): string {
  const map = s.padMap ?? PAD_DEFAULT;
  return PAD_ACTIONS.map(
    (a) => `<button class="pmrow${captureKey === a.k ? ' cap' : ''}" data-pad="${a.k}">
      <span>${a.label}</span>
      <span class="pmkey">${captureKey === a.k ? '按手柄按键…' : padGlyph(map[a.k], kind)}</span>
    </button>`,
  ).join('');
}

/** 只显示文件名，完整路径放 title，避免长路径把行撑破 */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 分段选择器（页签里的「帧率 / 布局 / 动效 / 字号 / 音量」共用） */
export function segHTML(id: string, items: { v: string; label: string }[], cur: string): string {
  return `<div class="seg" id="${id}">${items.map((m) => `<b class="${m.v === cur ? 'on' : ''}" data-v="${m.v}" role="button" tabindex="0">${esc(m.label)}</b>`).join('')}</div>`;
}

/** 手柄手感用的分段选择器：与 segHTML 同形，额外带 data-tuning，接线时按字段名取值。 */
export function tuneSegHTML(
  id: string,
  items: { v: string; label: string }[],
  cur: string,
  key: string,
): string {
  return `<div class="seg" id="${id}" data-tuning="${key}">${items
    .map(
      (m) =>
        `<b class="${m.v === cur ? 'on' : ''}" data-v="${m.v}" role="button" tabindex="0">${esc(m.label)}</b>`,
    )
    .join('')}</div>`;
}

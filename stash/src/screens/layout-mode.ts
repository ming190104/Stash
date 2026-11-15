/** 当前布局皮肤：`html[data-layout]` 由 applyLayout 写入，非法 / 缺省按经典处理。
 *  库屏、Hero、测试共用同一判断，避免两处各写一份（漏改时 hero 与轨道表现不一致）。 */

import type { LayoutName } from '../types';

export function layoutMode(): LayoutName {
  const l = document.documentElement.dataset.layout;
  return l === 'list' || l === 'wall' ? l : 'classic';
}

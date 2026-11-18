/** 首帧 UI 缓存：settings.json 是唯一权威，这里只是读盘前的一帧预览。
 *
 *  旧实现把 theme / layout / bootAnim / animSpeed / fullscreen 各写一个 localStorage key，
 *  等于在 settings.json 与 state.settings 之外又散落出五个「真相」，改一处漏一处就会出现
 *  「设置页显示新值、冷启动首帧还是旧样式」。现在统一收在一个 JSON 里读写；
 *  旧 key 只在首次读取时做一次迁移，之后不再写入。 */

export interface UiCache {
  theme?: string;
  layout?: string;
  bootAnim?: string;
  animSpeed?: number;
  fullscreen?: boolean;
}

const KEY = 'vnUiCache';
const LEGACY_KEYS = ['vnTheme', 'vnLayout', 'vnBootAnim', 'vnAnimSpeed', 'vnFullscreen'] as const;

function readLegacy(): UiCache {
  const out: UiCache = {};
  try {
    const theme = localStorage.getItem('vnTheme');
    if (theme !== null) out.theme = theme;
    const layout = localStorage.getItem('vnLayout');
    if (layout !== null) out.layout = layout;
    const boot = localStorage.getItem('vnBootAnim');
    if (boot !== null) out.bootAnim = boot;
    const speed = localStorage.getItem('vnAnimSpeed');
    if (speed !== null) {
      const n = Number(speed);
      if (Number.isFinite(n)) out.animSpeed = n;
    }
    const fs = localStorage.getItem('vnFullscreen');
    if (fs !== null) out.fullscreen = fs !== '0';
  } catch {
    /* 隐私模式：读不到就按默认值启动 */
  }
  return out;
}

function read(): UiCache {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === 'object' ? (v as UiCache) : {};
    }
    const legacy = readLegacy();
    if (Object.keys(legacy).length) {
      try {
        localStorage.setItem(KEY, JSON.stringify(legacy));
      } catch {
        /* 写不进去就先只在本次会话里用 */
      }
      // 迁移完成后删掉旧 key：留着它们就会重新变成第二份真相
      for (const k of LEGACY_KEYS) {
        try {
          localStorage.removeItem(k);
        } catch {
          /* 旧环境 / 测试桩没有 removeItem */
        }
      }
    }
    return legacy;
  } catch {
    return {};
  }
}

export function cacheGet<K extends keyof UiCache>(key: K): UiCache[K] {
  return read()[key];
}

/** 覆盖写若干字段（其余保留）：只写这一个 key */
export function cachePatch(patch: UiCache): void {
  const next = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式写不进去就忽略，下次启动按默认值 */
  }
}

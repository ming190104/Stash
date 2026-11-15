/** 详情屏背景链路：路径缓存 → 解码 → 切屏首帧直出。
 *
 *  背景优先级：作品自带图（非 capture 截图）> 后端缓存 `<id>_bg.jpg` > 商店横幅 > 封面 / 缩略图。
 *  这里只管「拿到图之后怎么上屏」与解码缓存；网络与目录扫描在 Rust 的 `detail_background`。
 *  库屏聚焦时预热（只查路径），切屏前把已解码的图直接铺上，避免第一帧黑场或旧封面残留。 */

import type { Game } from '../types';
import { asset, detailBackground } from '../ipc';
import { cssUrl } from '../ui';

/** 已经尝试过联网取背景图的作品：失败后本进程内不再重试（避免每次进详情都发请求） */
const bgTried = new Set<string>();

/** 已知的背景图路径（含「确实没有」）：库屏聚焦时预热，进详情就能一步到位。
 *  只做一次目录扫描（`detail_background` 不带 fetch），不发网络。 */
const bgKnown = new Map<string, string | null>();

/** 已转换 + 解码完成的背景图 URL：进详情前就备好，切屏首帧直接挂上。
 *  没有它的话，切屏后要等一次解码，中间那几帧背景层是空的（看起来就是黑闪）。 */
const bgReady = new Map<string, string>();

/** 当前 #detailArt 上画的是哪部作品：换作品时才知道要不要先卸掉旧图 */
let paintedId = '';

/** 背景是否已解码、可直接上屏（openDetail 用它决定要不要等预热） */
export function isDetailBgReady(id: string): boolean {
  return bgReady.has(id);
}

/** 库屏焦点变化时预热详情背景：进详情才发现有背景图的话，只能先铺本地图再换，
 *  那一帧的替换就是用户看到的「闪一下」。 */
export function warmDetailBg(id: string): void {
  if (bgKnown.has(id)) return;
  detailBackground(id)
    .then((p) => bgKnown.set(id, p))
    .catch(() => bgKnown.set(id, null));
}

/** 备齐一张可直接上屏的背景图：查路径（热缓存或一次目录扫描）→ 转 URL → 解码。
 *  库屏焦点会直接调它，`openDetail` 也会等它（最坏 400ms），所以切屏第一帧就有背景。 */
export async function prepareDetailBg(id: string): Promise<void> {
  let p = bgKnown.get(id);
  if (p === undefined) {
    try {
      p = await detailBackground(id);
    } catch {
      p = null;
    }
    bgKnown.set(id, p);
  }
  if (!p || bgReady.has(id)) return;
  try {
    const u = await asset(p);
    if (await preloadImage(u)) bgReady.set(id, u);
  } catch {
    /* 路径失效：paintDetailArt 会回落到本地图 */
  }
}

/** 背景图被换掉 / 清掉后，缓存里的路径与已解码 URL 都作废 */
export function forgetDetailBg(id: string): void {
  bgKnown.delete(id);
  bgReady.delete(id);
}

/** 换作品时立刻卸掉上一张背景并复位淡入：
 *  `.show` 常驻时旧图是不透明地硬切到新图（实测切屏后仍会露脸一帧以上）。 */
export function resetDetailArt(): void {
  const el = document.getElementById('detailArt');
  paintedId = '';
  if (!el) return;
  el.classList.remove('show');
  el.style.backgroundImage = '';
  document.getElementById('app')?.classList.remove('has-bg');
}

/** 切屏**之前**就把已解码的背景铺到 `#detailArt`，同时让整屏封面立即让位。
 *  `setScreen('detail')` 到 `renderDetail()` 之间隔着一次动态 import 的微任务，
 *  合成器完全可能先出一帧「详情屏 + 整屏封面（还是上一部的内容）」——
 *  用户看到的就是进详情闪一下封面。景已备好时这一步把那个窗口直接抹掉。 */
export function primeDetailArt(id: string): boolean {
  const u = bgReady.get(id);
  const el = document.getElementById('detailArt');
  const app = document.getElementById('app');
  if (!u || !el || !app) return false;
  paintedId = id;
  el.style.backgroundImage = cssUrl(u);
  el.classList.add('show');
  app.classList.add('has-bg');
  showDetailArtNow(true);
  return true;
}

/** 把 `#detailArt` 立刻亮到不透明度 1（整屏封面同步让位），两帧后交回 CSS。
 *  库屏上 CSS 让 `.detailart` 透明、`#kvArt` 恢复可见，所以切回详情时
 *  两层都会各跑一次 450ms 过渡——那半秒就是「又闪一下封面」。 */
function showDetailArtNow(hideCover: boolean): void {
  const el = document.getElementById('detailArt');
  if (!el) return;
  const kv = document.getElementById('kvArt');
  el.style.transition = 'none';
  el.style.opacity = '1';
  if (kv && hideCover) {
    kv.style.transition = 'none';
    kv.style.opacity = '0';
  }
  el.getBoundingClientRect();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.opacity = '';
      el.style.transition = '';
      if (kv) {
        kv.style.opacity = '';
        kv.style.transition = '';
      }
    }),
  );
}

/** 同一部作品再次进入详情：图还在 `#detailArt` 上，但库屏上被 CSS 藏了起来。
 *  直接亮出来，别再走一遍淡入。 */
function revealExistingArt(): void {
  const el = document.getElementById('detailArt');
  const app = document.getElementById('app');
  if (!el || !app || !el.style.backgroundImage) return;
  showDetailArtNow(app.classList.contains('has-bg'));
}

/** 从库 / 网格 / 数字键直切回详情屏：图已解码就瞬时亮出，否则退回「已经在层上的那张」。
 *  不做这一步的话，切屏后 `.detailart` 会从 0 淡入 450ms——那半秒里先露脸的就是整屏封面。 */
export function showDetailArtFor(id: string): void {
  if (!primeDetailArt(id)) revealExistingArt();
}

/** 详情背景优先用**作品自带的图**：`capture-*` 是本应用截的整屏图，
 *  老游戏常常把桌面、窗口边框一起拍进去，铺满整屏时完全不像背景。
 *  只有截屏时保持旧行为（取最新一张）。 */
function detailShot(g: Game): string | undefined {
  const shots = g.shots;
  if (!shots.length) return undefined;
  const own = shots.filter((p) => !/^capture-/i.test(p.split(/[\\/]/).pop() ?? ''));
  return own.length ? own[0] : shots[shots.length - 1];
}

/** 先解码再上屏：`background-image` 指向未解码的文件时，浏览器会先按透明/上一帧绘制，
 *  解码完再重绘——两次绘制之间的替换就是闪烁的来源。 */
function preloadImage(url: string): Promise<boolean> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      // onload 只保证字节到齐；decode() 才是「已解码、可立刻上屏」。
      // 换背景时元素本来就可见，少了这一步偶尔会露出一帧空白。
      if (typeof im.decode === 'function') im.decode().then(() => res(true), () => res(true));
      else res(true);
    };
    im.onerror = () => res(false);
    im.src = url;
  });
}

/** 详情屏整屏背景：**原作品的画面**优先，整屏铺满、不模糊、不裁切。
 *  换作品时先卸掉上一张（否则旧图在全不透明状态下硬切，看起来就是「闪一下原背景」），
 *  再按「已知背景图 → 本地图（截图 / 封面 / 缩略图）」选一张**解码完成后一次上屏**；
 *  只有不认识背景图时才先铺本地图过渡，然后问后端要真正的背景。 */
export function paintDetailArt(g: Game | null, isCurrent: () => boolean): void {
  const el = document.getElementById('detailArt');
  if (!el) return;
  // 详情屏的 .kv（整屏封面，z-index:1）盖在 #detailArt 之上：有真正的背景图时
  // 必须把它淡出，否则用户看到的永远是封面（这正是「背景不是原作品画面」的根因）
  const app = document.getElementById('app');
  if (!g) {
    resetDetailArt();
    return;
  }
  // 换作品：先把上一张卸掉并复位淡入，否则旧背景会在新图解码前露脸
  if (paintedId !== g.id) {
    resetDetailArt();
    paintedId = g.id;
  }
  let prio = 0;
  const paint = (u: string, p: number): void => {
    if (!isCurrent() || p < prio) return;
    prio = p;
    // 从隐藏直接变出来时不要 450ms 淡入：那半秒里背景是半透明的，等于先暗一下
    const hidden = !el.classList.contains('show');
    if (hidden) el.style.transition = 'none';
    el.style.backgroundImage = cssUrl(u);
    el.classList.add('show');
    if (hidden) {
      el.getBoundingClientRect(); // 强制应用当前样式，避免把「无过渡」也一起过渡掉
      el.style.transition = '';
    }
    // 首次上屏就有真背景：整屏封面（#kvArt，z-index:1）必须**立刻**让位。
    // 走 CSS 的 .45s 淡出的话，进详情的第一帧仍是整屏封面，看起来就是「先闪一张封面再变背景」。
    if (app && !app.classList.contains('has-bg')) {
      const kv = document.getElementById('kvArt');
      if (kv) kv.style.transition = 'none';
      app.classList.add('has-bg');
      if (kv) {
        kv.getBoundingClientRect();
        kv.style.transition = '';
      }
    } else {
      app?.classList.add('has-bg');
    }
  };
  /** 按顺序试一串候选图：解不出来（路径失效 / 文件被删）就试下一张；
   *  全都失败时交回 `onFail`，让调用方决定退回哪一层 */
  const showFirst = (list: string[], p: number, onFail?: () => void, i = 0): void => {
    const src = list[i];
    if (!src) {
      onFail?.();
      return;
    }
    asset(src)
      .then((u) =>
        preloadImage(u).then((ok) => {
          if (ok) paint(u, p);
          else showFirst(list, p, onFail, i + 1);
        }),
      )
      .catch(() => showFirst(list, p, onFail, i + 1));
  };

  // 本地兜底：作品自带的图 → 封面 → 缩略图
  const locals = [...new Set([detailShot(g), g.cover, g.thumb].filter((x): x is string => !!x))];
  const paintLocals = (): void => {
    // 先挂 has-bg 等解码：否则打开详情的头一帧会先闪一下整屏封面。
    // 用 toggle 而不是 add：上一部有图、这一部封面/缩略图/截图全没有时必须清掉，
    // 否则 #kvArt 一直淡出、#detailArt 又没图画，详情页只剩模糊环境层。
    app?.classList.toggle('has-bg', locals.length > 0);
    showFirst(locals, 1);
  };
  const known = bgKnown.get(g.id);
  const ready = bgReady.get(g.id);
  if (ready) {
    // 切屏前就解码好了：第一次绘制直接有背景，不会出现空的背景层
    paint(ready, 2);
  } else if (typeof known === 'string') {
    // 已经知道有背景图：直接等它解码上屏，不拿本地图做过渡（那一帧的替换就是闪烁）
    showFirst([known], 2, paintLocals);
  } else if (known === null) {
    // 明确没有背景图：本地图就是终态
    paintLocals();
  }
  // known === undefined（没预热到）：先什么都不画，等下面那次 IPC 回来再决定。
  // 这段空窗里详情显示的是封面——本来就是这一部的内容，不会出现「别的图」。
  // 已有背景图：优先级更高，覆盖本地图（缓存里没有 / 刚被换过时在这条链上补齐）
  detailBackground(g.id)
    .then((p) => {
      if (!isCurrent()) return;
      bgKnown.set(g.id, p);
      if (p) {
        showFirst([p], 2, paintLocals);
        return;
      }
      // 确实没有背景图：这时才铺本地图（有预热过的话上面已经画过了，重画无副作用）
      paintLocals();
      if (bgTried.has(g.id)) return;
      bgTried.add(g.id);
      // 没有缓存：去 SteamGridDB 取一张商店横幅；失败静默，仍用本地图
      return detailBackground(g.id, true).then((q) => {
        if (!q) return;
        bgKnown.set(g.id, q);
        if (isCurrent()) showFirst([q], 3);
      });
    })
    .catch(() => {
      // 问不到背景图（IPC 失败）：退回本地图，别让详情页空着
      if (isCurrent()) paintLocals();
    });
}

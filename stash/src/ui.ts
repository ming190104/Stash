/** 通用小部件：toast、相对时间格式化、按压反馈。
 *  toast 走 innerHTML（支持 <span class="kk acc">▶</span> 键位标记，mockup 同款），
 *  动态内容在汇点 safeToast 统一处理：只保留键帽 span，其余按纯文本转义。 */

import { esc, setRawHTML, domEpochNo } from './html';
import { sfx } from './sfx';
import type { BootAnim, LayoutName, ThemeName } from './types';

export { esc };

let toastTimer = 0;
/** 是否正有一条提示在显示（决定新提示是立即播还是排队） */
let toastShowing = false;
/** 待播队列：连续提示不再互相覆盖（匹配进度 / 连点开关时不会丢消息） */
const toastQueue: { msg: string; hot: boolean }[] = [];
const TOAST_SHOW_MS = 1800;
/** 队列上限：极端连点不把提示排到十几秒后，超出丢最早的一条 */
const TOAST_QUEUE_MAX = 5;

const THEMES: ThemeName[] = ['cinema', 'oled', 'sakura', 'frost', 'contrast', 'amber', 'iris', 'moss', 'crimson', 'daybreak', 'eva01', 'eva02', 'nerv'];
const LAYOUTS: LayoutName[] = ['classic', 'list', 'wall'];

/** 应用主题：写 html[data-theme]，并缓存一份用于下次启动首帧（避免设置读盘前的闪色） */
export function applyTheme(name: string | undefined): void {
  const t = (THEMES as string[]).includes(name ?? '') ? (name as ThemeName) : 'cinema';
  if (document.documentElement.dataset.theme !== t) {
    document.documentElement.dataset.theme = t;
  }
  try {
    localStorage.setItem('vnTheme', t);
  } catch {
    /* 隐私模式写不进去就忽略 */
  }
}

export function cachedTheme(): ThemeName {
  try {
    const t = localStorage.getItem('vnTheme') ?? 'cinema';
    return (THEMES as string[]).includes(t) ? (t as ThemeName) : 'cinema';
  } catch {
    return 'cinema';
  }
}

/** 应用布局皮肤：写 html[data-layout]，缓存一份供下次启动首帧（与主题各走各的，可自由组合）。
 *  cache=false 用于 ?layout= 目检入口：只切当前会话，不污染用户已保存的布局。 */
export function applyLayout(name: string | undefined, cache = true): void {
  const l = (LAYOUTS as string[]).includes(name ?? '') ? (name as LayoutName) : 'classic';
  if (document.documentElement.dataset.layout !== l) {
    document.documentElement.dataset.layout = l;
  }
  if (!cache) return;
  try {
    localStorage.setItem('vnLayout', l);
  } catch {
    /* 隐私模式写不进去就忽略 */
  }
}

/** 启动 / 全屏转场速度：只缩放这两处的时长，不碰库内动效。 */
/** 转场速度档位只有 1× / 1.5× / 2×；旧数据里的 0.5× 回落到 1× */
export function normalizeAnimSpeed(v: number | undefined): number {
  return v === 1.5 || v === 2 ? v : 1;
}

/** 冷启动动画档位：warp 流光跃迁 / 三档 EVA 起动序列 / off 关闭 */
const BOOT_ANIMS: BootAnim[] = ['warp', 'eva01', 'eva02', 'evaNerv', 'off'];

export function normalizeBootAnim(v: unknown): BootAnim {
  return (BOOT_ANIMS as unknown[]).includes(v) ? (v as BootAnim) : 'warp';
}

/** 记住档位，供下次冷启动在设置读盘前就能选对动画。 */
export function applyBootAnim(v: unknown): BootAnim {
  const m = normalizeBootAnim(v);
  try {
    localStorage.setItem('vnBootAnim', m);
  } catch {
    /* 隐私模式写不进去就忽略 */
  }
  return m;
}

export function cachedBootAnim(): BootAnim {
  try {
    return normalizeBootAnim(localStorage.getItem('vnBootAnim') ?? 'warp');
  } catch {
    return 'warp';
  }
}

/** 记住速度，供下次冷启动在设置读盘前就能按同一速度播放。 */
export function applyAnimSpeed(speed: number | undefined): number {
  const v = normalizeAnimSpeed(speed);
  try {
    localStorage.setItem('vnAnimSpeed', String(v));
  } catch {
    /* 隐私模式写不进去就忽略 */
  }
  return v;
}

export function cachedAnimSpeed(): number {
  try {
    const raw = localStorage.getItem('vnAnimSpeed');
    return raw ? normalizeAnimSpeed(Number(raw)) : 1;
  } catch {
    return 1;
  }
}

export function cachedLayout(): LayoutName {
  try {
    const l = localStorage.getItem('vnLayout') ?? 'classic';
    return (LAYOUTS as string[]).includes(l) ? (l as LayoutName) : 'classic';
  } catch {
    return 'classic';
  }
}

/**
 * 动效强度：设置里的「柔和」档，或系统「减少动态效果」偏好，满足任一就整档关闭。
 * 系统偏好必须跟着生效——掌机 / 长时间游玩时用户常在系统层就关掉动画，
 * 只认应用内开关会让这档设置形同失效。
 */
export function applyMotion(soft: boolean): void {
  const reduce =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('app')?.classList.toggle('motion-soft', soft || reduce);
}

/** 设计基准画布（总案 §1）：所有坐标按 1280×720 写死，适配只做整层等比缩放 */
export const STAGE_W = 1280;
export const STAGE_H = 720;
/** 大屏上限 2×：4K 上放太大反而字少、封面过大，2× 后四周留边更舒服 */
export const MAX_STAGE_SCALE = 2;

/**
 * 舞台缩放比：窗口不足按比例缩小（不压扁、不裁切），大屏按比例放大但不超过 2×。
 * 宽高比不是 16:9 时取较小的一边，另一侧留边——绝不非等比拉伸。
 */
export function stageScale(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.min(width / STAGE_W, height / STAGE_H, MAX_STAGE_SCALE);
}

/** 可选字号档位（设置 · 外观）：只放大文字，不动封面 / 分区 / 轨道几何 */
export const FONT_SCALES = [0.9, 1, 1.12, 1.25] as const;
export function normalizeFontScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  return Math.min(1.25, Math.max(0.9, n));
}

/** 把字号比例写到根变量：app.css 里所有 font-size 都是 calc(Npx * var(--fs,1)) */
export function applyFontScale(v: unknown): void {
  const fs = normalizeFontScale(v);
  document.documentElement.style.setProperty('--fs', String(fs));
  // 特大字号下部分装饰元素要单独隐藏 / 放大；CSS 无法直接比较 var()，同步一份 data 属性给选择器
  document.documentElement.dataset.fsScale = String(fs);
}

/** 全屏时隐藏右上角的三个窗口按钮：无边框全屏里它们既用不上又压在画面上 */
export function applyFullscreenUI(on: boolean): void {
  document.documentElement.dataset.fs = on ? '1' : '';
  // 触摸设备切全屏时，仍处于焦点的输入框会让 Windows 弹出触摸键盘：先收掉焦点
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    active.blur();
  }
  try {
    localStorage.setItem('vnFullscreen', on ? '1' : '0');
  } catch {
    /* 隐私模式写不进去就忽略，下次启动按默认全屏 */
  }
}

/** 上次退出时是否全屏。冷启动的跃迁只在全屏下播，此时设置还没读盘。 */
export function cachedFullscreen(): boolean {
  try {
    return localStorage.getItem('vnFullscreen') !== '0';
  } catch {
    return true;
  }
}

/** toast 里唯一允许的标记是键帽 `<span class="kk …">`。
 *  错误信息会带文件名 / 标题 / 后端 message，不能当 HTML 信任：
 *  其余标签一律拆壳留文字，属性（含 onerror / onclick）一律丢弃。 */
const TOAST_CLASS = new Set(['kk', 'acc', 'key', 'dim']);
function safeToast(s: string): string {
  if (!s.includes('<')) return s;
  // 非浏览器环境（单测无 DOMParser）退化为全量转义：宁可丢键帽样式，也不留注入面
  if (typeof DOMParser === 'undefined') return esc(s);
  const doc = new DOMParser().parseFromString(`<body>${s}</body>`, 'text/html');
  let out = '';
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      out += esc(n.nodeValue ?? '');
      return;
    }
    if (n.nodeType !== 1) return; // 注释 / 处理指令直接丢
    const el = n as HTMLElement;
    if (el.tagName === 'SPAN') {
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => TOAST_CLASS.has(c));
      out += cls.length ? `<span class="${cls.join(' ')}">` : '<span>';
      el.childNodes.forEach(walk);
      out += '</span>';
      return;
    }
    el.childNodes.forEach(walk); // 其它标签：拆壳保留文字
  };
  doc.body.childNodes.forEach(walk);
  return out;
}

/** 统一取用户可读的错误文案：后端 AppError 是 `{ code, message }`，
 *  直接 `String(err)` 只会显示 `[object Object]`（真实踩过的坑）。 */
export function errMsg(e: unknown): string {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' && m ? m : String(e);
}

/** 给「用 div/span 拼出来的可点元素」补键盘语义：role=button + tabindex + Enter/Space。
 *  只用于浮层 / 详情里的零散控件；轨道 / 网格卡片已有整屏方向键导航，不逐个塞进 Tab 顺序。 */
export function clickable(el: HTMLElement): void {
  if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    // 拦住冒泡：全局 Enter / A 是「当前屏确认」，不能在元素与屏幕两级各触发一次
    e.stopPropagation();
    el.click();
  });
}

/** 本地路径 → CSS url()：转义反斜杠/引号/换行，避免 meta.json 的 cover 破坏样式表 */
export function cssUrl(u: string): string {
  return `url("${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\a ')}")`;
}

/** 播一条并按时收起；收起后若有排队，立刻接上下一条（中间不空闪） */
function playToast(el: HTMLElement, t: { msg: string; hot: boolean }): void {
  setRawHTML(el, t.msg);
  el.classList.toggle('hot', t.hot);
  el.classList.add('show');
  toastShowing = true;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove('show');
    toastShowing = false;
    const next = toastQueue.shift();
    if (next) playToast(el, next);
  }, TOAST_SHOW_MS);
}

export function toast(msg: string, hot = false): void {
  if (hot) sfx.error(); // 报错音立即响，不等排到队列：连续失败时用户需要立刻听到
  const el = document.getElementById('toast');
  if (!el) return;
  const safe = safeToast(msg);
  if (toastShowing) {
    if (toastQueue.length >= TOAST_QUEUE_MAX) toastQueue.shift();
    toastQueue.push({ msg: safe, hot });
    return;
  }
  playToast(el, { msg: safe, hot });
}

/** 按压反馈（mockup press 同款）：手柄 / 键盘激活时先缩一下再回弹——
 *  没有这层，按键就像"没反应"。`.kp` 规则见 app.css（`.cta` / `.ghost`），卡片走 `.press`。
 *  ms 默认 140，与 UI 规范 6.1 的「按压反馈 140ms」一致。 */
export function press(sel: string | HTMLElement | null, ms = 140): void {
  const el = typeof sel === 'string' ? document.querySelector<HTMLElement>(sel) : sel;
  if (!el) return;
  const h = el as HTMLElement & { _kp?: number };
  h.classList.add('kp');
  clearTimeout(h._kp);
  h._kp = window.setTimeout(() => el.classList.remove('kp'), ms);
}

/** 卡片按压反馈（`.card.press`，与 `.kp` 分开：卡片用 !important 压过 .focus 变换） */
export function pressCard(card: HTMLElement | null, ms = 140): void {
  if (!card) return;
  const h = card as HTMLElement & { _press?: number };
  h.classList.add('press');
  clearTimeout(h._press);
  h._press = window.setTimeout(() => h.classList.remove('press'), ms);
}

/* ============ 焦点环（手柄 / 键盘可见焦点） ============
   app.css 定义了 `.tg.focus / .mini.focus / .cta.focus / .ghost.focus /
   .seg b.focus / .inp.focus / .linkbtn.focus / .back.focus / .tbtn.focus /
   #snav button.focus`，但此前没有任何 JS 挂过这些 class——卡片走的是
   `.card.focus`（轨道自己驱动），于是设置页与详情页的控件在掌机上
   "按下去看不见焦点"。同 `.kp` 属一类缺口（规则在、接线缺）。
   与 CSS 规则一一对应的可聚焦选择器集中在这里，避免三处各写一遍再漏一处。 */
export const RING_SEL =
  '.tg,.mini,.cta,.ghost,.seg b[data-v],.inp,.back,.tbtn,.linkbtn,.dstar,.pmrow,.snav button,.cand-card';

/** 收集容器内可聚焦控件（文档序，与视觉顺序一致）。
 *  同一份 DOM 上多次调用（手柄连发 / 环移动后紧接着取列表）复用上次结果：
 *  每个元素读 `offsetParent` 都会强制布局，控件多时连发明显掉帧。
 *  用 DOM 版本号失效：任何 setRawHTML / clearHTML 之后自动重算。 */
const RING_CACHE = new WeakMap<ParentNode, { els: HTMLElement[]; epoch: number }>();

export function ringEls(root: ParentNode = document): HTMLElement[] {
  const epoch = domEpochNo();
  const hit = RING_CACHE.get(root);
  if (hit && hit.epoch === epoch) return hit.els;
  const els = [...root.querySelectorAll<HTMLElement>(RING_SEL)].filter(
    // 隐藏元素不进焦点环（例如 data-act 区域被 display:none 收起的候选面板）
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
  RING_CACHE.set(root, { els, epoch });
  return els;
}

/** 给一组元素中的第 i 个挂 `.focus`，返回夹紧后的索引 */
export function ringFocus(els: HTMLElement[], i: number): number {
  if (!els.length) return 0;
  const k = Math.max(0, Math.min(els.length - 1, i));
  els.forEach((el, j) => el.classList.toggle('focus', j === k));
  // 手柄焦点环与 DOM 焦点同步，Tab / 键盘操作不会停留在旧控件上
  els[k].focus({ preventScroll: true });
  els[k].scrollIntoView({ block: 'nearest' });
  return k;
}

export function ringClear(els: HTMLElement[]): void {
  els.forEach((el) => el.classList.remove('focus'));
}

/** 激活焦点元素：输入框取焦点让用户打字，其余走 click */
export function ringActivate(el: HTMLElement | undefined): void {
  if (!el) return;
  if (el.tagName === 'INPUT') (el as HTMLInputElement).focus();
  else el.click();
}

export function fmtRelative(ts: number | null): string {
  if (!ts) return '从未游玩';
  const d = Date.now() / 1000 - ts;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} 分钟前`;
  if (d < 86400) return `${Math.round(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString('zh-CN');
}

/** 累计时长（秒 → 「12 小时 6 分」）。不足 1 分钟显示「不足 1 分」，未游玩显示「—」 */
export function fmtDuration(secs: number): string {
  if (!secs || secs <= 0) return '—';
  if (secs < 60) return '不足 1 分';
  const h = Math.floor(secs / 3600);
  let m = Math.round((secs % 3600) / 60);
  let hh = h;
  if (m === 60) {
    // 3599s 会四舍五入成「60 分」，进位成 1 小时
    hh += 1;
    m = 0;
  }
  if (!hh) return `${m} 分`;
  return m ? `${hh} 小时 ${m} 分` : `${hh} 小时`;
}

/** 简介「中文优先」：Bangumi 的简介常被合并成「日文原文 + 分隔线 + 中文补充」，
 *  详情与列表只露前三行，日文会先把位置占满。这里按空行 / 纯符号分隔线切块，
 *  把纯中文段落提到前面，其余保持原顺序；没有中文段落就原样返回（不破坏排版）。 */
export function cnFirst(text: string): string {
  const isSep = (l: string): boolean => /^[-—–=_*~·.…]{3,}$/.test(l.trim());
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (isSep(line) || !line.trim()) {
      if (cur.length) {
        blocks.push(cur.join('\n').trim());
        cur = [];
      }
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n').trim());
  // 中文判定：有汉字且一个假名都没有（日文段落几乎必然出现假名）
  const isCn = (b: string): boolean => {
    const han = (b.match(/[\u4e00-\u9fff]/g) || []).length;
    const kana = (b.match(/[\u3040-\u30ff]/g) || []).length;
    return han >= 4 && kana === 0;
  };
  const cn = blocks.filter(isCn);
  if (!cn.length || blocks[0] === cn[0]) return text;
  return [...cn, ...blocks.filter((b) => !isCn(b))].join('\n\n');
}


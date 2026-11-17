/** NavIntent 统一分发：键盘 + 手柄（Rust nav://intent 事件）汇入同一入口。
 *  每屏注册自己的 handler；未注册的方向静默忽略（几何焦点引擎职责，总案 6.2）。
 *  Y/X/R 等语义键由各屏自行监听（与 mockup 的 document keydown 分发一致）。 */

import type { NavIntent, Screen } from './types';
import type { PadKind } from './padmap';
import { onEvent, padStatus, type PadStatus } from './ipc';
import { applyPadHints } from './keybar';
import { setScreen, state, gameById } from './state';
import { handleOverlayKey, modalState, openSearch, openFilter, showEmpty, showState, anyState, openHelp } from './overlay';
import { handleQuickKey, quickShown, toggleQuickMenu } from './quick';
import { setMulti } from './multi';
import { sfx } from './sfx';
import { skipSplash, splashActive } from './splash';
import { toast, esc } from './ui';

type Handler = (n: NavIntent) => void;
/** 意图来源：键盘（含系统键盘模拟）与手柄线程两条通道 */
type NavSource = 'key' | 'pad';
const handlers = new Map<Screen, Handler>();

export function registerHandler(screen: Screen, h: Handler): void {
  handlers.set(screen, h);
}

export function curScreen(): Screen {
  const el = document.querySelector('.screen.on') as HTMLElement | null;
  return (el?.dataset.s as Screen) ?? 'library';
}

/** 手柄意图 → 等价键码：复用键盘侧的守卫与状态层逻辑，避免两套实现走偏 */
function navCode(n: NavIntent): string | null {
  if (n.intent === 'accept') return 'Enter';
  if (n.intent === 'back') return 'Escape';
  if (n.intent === 'move') return `Arrow${n.dir[0].toUpperCase()}${n.dir.slice(1)}`;
  return null;
}

/** 手柄语义键 → 等价键码：复用各屏已有的 KeyX / KeyY / F1 处理，不写第二套实现 */
const SEMANTIC_CODE: Partial<Record<NavIntent['intent'], string>> = {
  actionX: 'KeyX',
  actionY: 'KeyY',
};

/** 手柄合成的键盘事件带此标记：屏幕可按来源区分。
 *  X 键由此不再兼作多选入口（手柄的多选改走 Select），键盘 M / X 的老习惯保留。 */
type PadKeyEvent = KeyboardEvent & { padNav?: boolean };

export function isPadNavEvent(e: KeyboardEvent): boolean {
  return (e as PadKeyEvent).padNav === true;
}

/** 视图切换（仅键盘 Q / E）：只在「库 ⇄ 网格」两套浏览视图之间切。
 *  手柄肩键不再参与切屏——用户在掌机上误按肩键不该把主界面甩走；
 *  详情 / 设置也不响应，屏幕停在当前这一屏。 */
function cycleView(): void {
  const cur = curScreen();
  if (cur !== 'library' && cur !== 'grid') return;
  setScreen(cur === 'library' ? 'grid' : 'library');
}

/** 一次物理按键可能被两条通道同时投递（手柄线程 + 系统的键盘模拟设备）：
 *  跨通道、间隔极短的同一意图只认先到的那条。同通道连按（键盘连点 / 手柄连按）不受影响。
 *  B / Start 也会被重复投递（连退两层、菜单开了又关），所以按 intent 统一去重；
 *  move 是长按连发，不参与。 */
const DUP_GAP_MS = 180;
let lastIntent: { key: string; at: number; from: NavSource } | null = null;

function intentKey(n: NavIntent): string {
  return n.intent === 'move' ? `move:${n.dir}` : n.intent;
}

function duplicateIntent(n: NavIntent, from: NavSource): boolean {
  if (n.intent === 'move') return false;
  const key = intentKey(n);
  const now = performance.now();
  const dup =
    lastIntent !== null && lastIntent.key === key && lastIntent.from !== from && now - lastIntent.at < DUP_GAP_MS;
  // 被丢弃时不刷新时间戳：真正的那次按键仍以先到者为起点
  if (!dup) lastIntent = { key, at: now, from };
  return dup;
}

export function dispatchNav(n: NavIntent, from: NavSource = 'key'): void {
  // 过场（冷启动 / 全屏切换）期间手柄输入只有一个有效含义：跳过。
  // 键盘与鼠标由过场层自己在捕获阶段吞掉，手柄不产生 DOM 事件，只能在这里挡。
  if (splashActive() && from === 'pad') {
    if (n.intent === 'accept' || n.intent === 'back' || n.intent === 'menu') skipSplash();
    return;
  }
  if (duplicateIntent(n, from)) {
    console.debug('[nav] 丢弃重复意图（同一按键的双通道投递）', n.intent, from);
    return;
  }
  // 交互音效：导航类动作统一在这里出声，各屏不必重复接
  if (n.intent === 'move') sfx.move();
  else if (n.intent === 'accept') sfx.confirm();
  else if (n.intent === 'back') sfx.back();
  else if (n.intent === 'menu') sfx.menu();
  // Start / 菜单键：任何屏都弹快捷菜单（P4）；模态层开着时不叠菜单，菜单自己开着则关掉
  if (n.intent === 'menu') {
    if (quickShown() || !modalState()) void toggleQuickMenu();
    return;
  }
  // 快捷菜单是模态层。注意：不能在这里直接 return —— 手柄不产生 keydown，
  // 方向 / A / B 只能靠下面合成的等价事件交给 handleQuickKey 消费；
  // 提前 return 会让手柄在菜单里完全失效（键盘仍正常，因为走的是另一条 keydown 路径）。
  const menuOpen = quickShown();
  // LB / RB：网格屏右上角分类 chips 左右切换；详情屏 RB 仍是「收藏」；
  // 库 / 设置不响应——肩键永远不切屏（用户要求「设置哪个界面就是哪个界面」）。
  if (n.intent === 'actionL' || n.intent === 'actionR') {
    if (menuOpen || anyState()) return;
    const cur = curScreen();
    if (cur === 'grid') {
      const dir = n.intent === 'actionL' ? -1 : 1;
      void import('./screens/grid').then((m) => m.cycleFilter(dir));
      return;
    }
    if (n.intent === 'actionR' && cur === 'detail') {
      const e = new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true });
      if (handleQuickKey(e)) return;
      if (handleOverlayKey(e)) return;
      window.dispatchEvent(e);
    }
    // 文件屏：LB 隐藏文件、RB 刷新，复用键盘的 KeyH / KeyR 路径
    if (cur === 'files') {
      const code = n.intent === 'actionL' ? 'KeyH' : 'KeyR';
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase(), bubbles: true }));
    }
    return;
  }
  // Y 在网格屏 = 筛选（手柄没有 F 键，筛选面板得能打开）；库屏 Y 仍是「详情」
  if (n.intent === 'actionY' && !menuOpen && !anyState() && curScreen() === 'grid') {
    openFilter();
    return;
  }
  // X / Y / Select：投递等价键盘事件，走同一套守卫（快捷菜单 / 状态层 / 输入框都不会穿透）
  const semantic = SEMANTIC_CODE[n.intent];
  if (semantic) {
    const e = new KeyboardEvent('keydown', { code: semantic, key: semantic, bubbles: true }) as PadKeyEvent;
    e.padNav = true;
    if (handleQuickKey(e)) return;
    if (handleOverlayKey(e)) return;
    if (menuOpen) return; // 菜单不认 X / Y：别把状态层开在菜单背后
    window.dispatchEvent(e);
    return;
  }
  // 手柄不走 keydown，必须在这里补状态层守卫（键盘路径已在上游拦过一次，重复调用无副作用）
  const code = navCode(n);
  if (code) {
    const e = new KeyboardEvent('keydown', { code, key: code, bubbles: true });
    // 菜单开着时这三类键先给菜单（↑↓ 移动 / A 执行 / B 关闭），消费不掉也不能落给屏幕
    if (handleQuickKey(e)) return;
    if (handleOverlayKey(e)) return;
    if (menuOpen) return;
  } else if (anyState() || menuOpen) {
    return; // 状态层 / 快捷菜单打开时，切屏等语义键不穿透
  }
  if (n.intent === 'switchView') {
    cycleView();
    return;
  }
  handlers.get(curScreen())?.(n);
}

const KEY_MAP: Record<string, NavIntent> = {
  ArrowUp: { intent: 'move', dir: 'up' },
  ArrowDown: { intent: 'move', dir: 'down' },
  ArrowLeft: { intent: 'move', dir: 'left' },
  ArrowRight: { intent: 'move', dir: 'right' },
  Enter: { intent: 'accept' },
  KeyA: { intent: 'accept' },
  NumpadEnter: { intent: 'accept' },
  Escape: { intent: 'back' },
  KeyB: { intent: 'back' },
  Backspace: { intent: 'back' },
  KeyQ: { intent: 'switchView' },
  KeyE: { intent: 'switchView' },
  ContextMenu: { intent: 'menu' },
};

/** 记住手柄布局与信息：键帽 glyph、键位页「手柄信息」都直接读 state。 */
function rememberPad(s: PadStatus): void {
  const kind = (s.kind as PadKind) || 'xbox';
  state.padKind = kind;
  state.padInfo = {
    name: s.name || '',
    kind,
    power: s.power || 'unknown',
    ff: !!s.ff,
  };
  applyPadHints(s.connected);
}

export function init(): void {
  window.addEventListener('keydown', (e) => {
    // 快捷菜单打开时优先消费方向/确认/返回
    if (handleQuickKey(e)) return;
    // 菜单键必须先于状态层兜底：游戏运行中（launchLayer）也要能弹快捷菜单去结束游戏
    if (e.code === 'ContextMenu') {
      dispatchNav({ intent: 'menu' });
      e.preventDefault();
      return;
    }
    // 状态层守卫：任一 P0 状态层打开（或搜索框聚焦）时，底层屏幕一律不响应
    if (handleOverlayKey(e)) return;

    // 数字 1-4 直切四屏（detail 需已有内容）
    if (/^Digit[1-4]$/.test(e.code)) {
      const order: Screen[] = ['library', 'grid', 'detail', 'settings'];
      const target = order[Number(e.code.slice(5)) - 1];
      // 详情必须有「仍可见」的作品：已移除 / 已隐藏的残留 detailId 一律不放行
      const dg = gameById(state.detailId);
      if (target === 'detail' && (!dg || dg.hidden)) return;
      if (target === 'detail') {
        // 直切详情：先把已解码的背景瞬时亮出，否则 `.detailart` 会从 0 淡入 450ms，
        // 那半秒里先露脸的是整屏封面（与从库屏进详情同一类残留）
        void import('./screens/library').then((m) => m.showDetailArtFor(dg!.id));
      }
      setScreen(target);
      e.preventDefault();
      return;
    }
    // 快捷键总览：F1 或 ?（Shift+/）。游戏运行遮罩打开时由上游守卫拦下，不叠层
    if (e.code === 'F1' || (e.code === 'Slash' && e.shiftKey)) {
      openHelp();
      e.preventDefault();
      return;
    }
    // P0 状态层入口：/ 搜索·排序面板，5 空态，6 加载骨架，7 失败态（与设计稿键位一致）
    if (e.code === 'Slash') {
      openSearch();
      e.preventDefault();
      return;
    }
    // 筛选面板：F（与 / 搜索并列，P1 标签 / 会社 / 年份分面）——只在库/网格两屏生效；
    // 从轨道打开时先切到网格，否则结果在身后看不见
    if (e.code === 'KeyF' && (curScreen() === 'library' || curScreen() === 'grid')) {
      if (curScreen() === 'library') setScreen('grid');
      openFilter();
      e.preventDefault();
      return;
    }
    // 调试键 5/6/7：空库 / 加载中 / 出错三个状态层的演示入口，仅开发构建可用。
    // 生产构建里 import.meta.env.DEV 是 false 常量，整段被摇树移除（与 mock 数据同机制）
    if (import.meta.env.DEV) {
      if (e.code === 'Digit5') {
        showEmpty('empty');
        return;
      }
      if (e.code === 'Digit6') {
        showState('loadingState');
        return;
      }
      if (e.code === 'Digit7') {
        showState('errorState');
        return;
      }
    }
    const n = KEY_MAP[e.code];
    if (!n) return;
    // 按住不放的系统连发不是新的一次确认：A / Enter 只在真正按下时生效
    if (e.repeat && n.intent === 'accept') return;
    e.preventDefault();
    dispatchNav(n, 'key');
  });

  // 手柄事件（Rust input.rs → nav://intent）
  void onEvent<NavIntent>('nav://intent', (n) => dispatchNav(n, 'pad'));
  // 连接 / 断开提示：拔插后立刻知道手柄是否被识别（启动时的那条可能早于页面就绪）
  void onEvent<PadStatus>('pad://status', (s) => {
    rememberPad(s);
    toast(s.connected ? `手柄已连接 · ${esc(s.name || '控制器')}` : '手柄已断开 · 回退键盘');
  });
  // 启动时补查一次：手柄线程起得比页面早，pad://status 可能已经发过去了
  void padStatus()
    .then(rememberPad)
    .catch(() => {});
  // Select：库 / 网格切换多选（手柄没有 M 键，X 留给「对当前对象的主操作」）。
  void onEvent<{ button: string }>('pad://button', (ev) => {
    if (ev.button !== 'select') return;
    if (splashActive() || anyState() || quickShown()) return;
    const cur = curScreen();
    if (cur !== 'library' && cur !== 'grid') return;
    setMulti(!state.gridMulti);
  });
}

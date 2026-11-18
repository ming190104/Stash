/** 快捷菜单（P4）：手柄 Start / 键盘菜单键弹出，掌机上不离开当前屏就能做五件事。
 *  层单独管理，但接进 overlay.anyState()，避免库屏快捷键在菜单上重复触发。 */

import { state, sortedGames, gridList, setScreen } from './state';
import { esc, toast, applyFullscreenUI } from './ui';
import { html, setHTML, setRawHTML } from './html';
import { promptConfirm, promptShown } from './prompt';
import { warpToggle, warpBusy } from './splash';
import { modalState, openSearch } from './overlay';
import { persist } from './settings-persist';
import { stopGame, getSettings, setFullscreen, TAURI } from './ipc';

export type MenuItem = {
  key: string;
  label: string;
  /** 显式允许 undefined：调用方常按条件传 hint（无提示时写 undefined） */
  hint?: string | undefined;
  /** 左侧小图（已转成可显示的 URL）：候选条目用，没有就只显示文字 */
  thumb?: string;
  /** 执行后菜单保持打开（如「随机一部」） */
  keepOpen?: boolean;
  /** 危险操作：焦点样式与普通项区分（退出应用 / 清空键位） */
  danger?: boolean;
  run: () => Promise<void> | void;
};
type Item = MenuItem;

function el(): HTMLElement | null {
  return document.getElementById('qmenu');
}

function ensure(): HTMLElement {
  let m = el();
  if (m) {
    wireBackdrop(m);
    return m;
  }
  m = document.createElement('div');
  m.id = 'qmenu';
  m.className = 'qmenu';
  setRawHTML(
    m,
    `<div class="qbox"><div class="qt">快捷菜单<span>Start / 菜单键</span></div><div class="qlist"></div>` +
      `<div class="qfoot"><span>↑↓ 选择</span><span>A / Enter 确认</span><span>B / Esc 返回</span></div></div>`,
  );
  document.getElementById('app')?.appendChild(m);
  wireBackdrop(m);
  return m;
}

/** 鼠标习惯：点菜单外的暗底 = 关闭（只绑一次；子菜单也一并收起） */
function wireBackdrop(m: HTMLElement): void {
  if (m.dataset.bd) return;
  m.dataset.bd = '1';
  m.addEventListener('click', (e) => {
    if (e.target === m) close();
  });
}

/** 全屏下最小化：进全屏时系统任务栏会被切成自动隐藏，直接 minimize 会让桌面
 *  「没有任务栏」；先退全屏让任务栏恢复，窗口重新聚焦时再回全屏。
 *  只临时退全屏，不写 settings.fullscreen —— 用户的全屏偏好保持不变。 */
let resumeFullscreen = false;
let focusHooked = false;

async function minimizeWindow(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const w = getCurrentWindow();
  if (!focusHooked) {
    focusHooked = true;
    await w.onFocusChanged(({ payload: focused }: { payload: boolean }) => {
      if (!focused || !resumeFullscreen) return;
      resumeFullscreen = false;
      void setFullscreen(true)
        .then(() => applyFullscreenUI(true))
        .catch((err) =>
          toast(`回到全屏失败：${esc(String((err as { message?: string })?.message ?? err))}`, true),
        );
    });
  }
  if (!state.settings?.fullscreen) {
    await w.minimize();
    return;
  }
  await setFullscreen(false);
  // UI 先同步成窗口模式：万一恢复时焦点事件没到，界面也不会停在「全屏」的假状态
  applyFullscreenUI(false);
  try {
    await w.minimize();
    // 最小化确认后再置位：避免注册监听时的初始焦点事件误触发「回全屏」
    resumeFullscreen = true;
  } catch (err) {
    // 最小化失败就把全屏补回来，别停在「设置是全屏、窗口不是」的半途状态
    await setFullscreen(true).catch(() => undefined);
    throw err;
  }
}

/** 随机挑一部并跳到它：库屏改轨道焦点，网格屏改网格焦点并重绘。
 *  键盘 R、快捷菜单「随机一部」与手柄「随机一部」共用这一条实现。 */
export async function pickRandomGame(): Promise<void> {
  // 只有库 / 网格有「随机」语义：详情 / 设置 / 文件屏调用时不能悄悄改背后库的焦点
  if (state.screen !== 'library' && state.screen !== 'grid') return;
  // 网格屏的可见集合与索引都独立于轨道：只改 state.focus 的话，
  // 网格画面不会动，等于「随机」在当前屏毫无反馈
  const onGrid = state.screen === 'grid';
  const list = onGrid ? gridList() : sortedGames();
  // 只按可见作品抽：隐藏 / 筛选后可能只剩 0~1 部，给一句提示而不是静默失败
  if (list.length < 2) {
    toast('可随机的作品不足 2 部');
    return;
  }
  const cur = onGrid ? state.gridFocus : state.focus;
  let i = Math.floor(Math.random() * list.length);
  if (i === cur) i = (i + 1) % list.length;
  if (onGrid) {
    state.gridFocus = i;
    (await import('./screens/grid')).renderGrid();
  } else {
    state.focus = i;
    (await import('./screens/library')).renderRail();
  }
  toast(`随机 · ${esc(list[i]!.title)}`);
}

function buildItems(): Item[] {
  const items: Item[] = [];
  if (state.running) {
    items.push({
      key: 'stop',
      label: '结束游戏',
      hint: 'X',
      run: async () => {
        await stopGame(state.running!);
      },
    });
  }
  // 全屏下顶栏的搜索 / 设置图标会隐藏，入口收到快捷菜单里
  items.push({ key: 'search', label: '搜索 · 排序', hint: '/', run: () => openSearch() });
  items.push({
    key: 'full',
    label: '切换全屏',
    run: async () => {
      // 转场进行中再来一次会排成反向切换（进入后 1.0s 又退出）：直接忽略
      if (warpBusy()) return;
      if (!state.settings) state.settings = await getSettings();
      const on = !state.settings.fullscreen;
      // 先记目标状态，连点两次时第二次才能算出反向；换边藏在锁定闪光下完成
      state.settings.fullscreen = on;
      try {
        await warpToggle(
          async () => {
            await setFullscreen(on);
            applyFullscreenUI(on);
          },
          true,
          { dropIfBusy: true }
        );
      } catch (err) {
        state.settings.fullscreen = !on;
        throw err;
      }
      // 走统一落盘队列：直接整份写旧快照会覆盖期间在设置页改的其它字段
      try {
        await persist();
      } catch (err) {
        // persist 已按磁盘值回滚 state.settings / data-fs / ui-cache，但窗口是
        // 直接调的 setFullscreen：不手动退回去就会停在「设置显示关、窗口仍全屏」，
        // 之后 minimizeWindow() 会按窗口模式最小化，任务栏又被自动隐藏。
        const back = !!state.settings?.fullscreen;
        await setFullscreen(back).catch(() => undefined);
        applyFullscreenUI(back);
        throw err;
      }
      toast(`全屏 · ${on ? '开' : '关'}`);
    },
  });
  // 随机一部：只在库 / 网格加入。其它屏的焦点语义不同，
  // 放一个点了只改背后库焦点、画面毫无反馈的条目没有意义。
  const randomPool = state.screen === 'grid' ? gridList() : state.screen === 'library' ? sortedGames() : [];
  if (randomPool.length > 1) {
    items.push({
      key: 'random',
      label: '随机一部',
      hint: 'R',
      keepOpen: true,
      run: pickRandomGame,
    });
  }
  if (state.screen !== 'settings') {
    items.push({ key: 'settings', label: '设置', run: () => setScreen('settings') });
  }
  // 全屏时顶栏窗口按钮被隐藏，这里给出等价的手柄入口，避免只能靠键盘关窗口
  if (TAURI) {
    items.push({
      key: 'min',
      label: '最小化窗口',
      run: () => minimizeWindow(),
    });
    items.push({
      key: 'quit',
      label: '退出应用',
      danger: true,
      hint: state.running ? '会结束游戏' : undefined,
      run: async () => {
        const ok = await promptConfirm({
          title: '退出 Stash？',
          sub: state.running ? '正在运行的游戏也会一并结束' : '下次可从开始菜单重新打开',
        });
        if (!ok) return;
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      },
    });
  }
  return items;
}

let items: Item[] = [];
let idx = 0;
/** 子菜单的上一级：B / Esc 先回这里 */
let parent: (() => void) | null = null;
/** 构建菜单是同步的：长按 Start 时防止并发重复构建 */
let opening = false;
/** 执行中是异步的（全屏 / 随机）：长按 A 不能连续触发同一个动作 */
let busy = false;

function paint(): void {
  const list = el()?.querySelector<HTMLElement>('.qlist');
  if (!list) return;
  setHTML(
    list,
    html`${items.map(
      (it, i) =>
        html`<button class="qitem${i === idx ? ' on' : ''}${it.thumb ? ' has-th' : ''}" data-k="${it.key}"${
          it.danger ? html` data-danger="1"` : ''
        }>${
          it.thumb ? html`<img class="qthumb" src="${it.thumb}" alt="" loading="lazy"/>` : ''
        }<b>${it.label}</b>${it.hint ? html`<span class="kk qhint">${it.hint}</span>` : ''}</button>`,
    )}`,
  );
  list.querySelectorAll<HTMLElement>('.qitem').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.k;
      const it = items.find((x) => x.key === k);
      if (it) void exec(it);
    });
  });
  // 列表可能超过一屏（详情菜单 + 子菜单）：键盘/手柄选中项必须跟着滚进视野
  list.querySelector<HTMLElement>('.qitem.on')?.scrollIntoView({ block: 'nearest' });
}

async function exec(it: Item): Promise<void> {
  if (busy) return;
  busy = true;
  // 先收起菜单再执行：输入框 / 表单类动作会在菜单右侧打开，两层叠着会互相遮挡
  if (!it.keepOpen) close();
  try {
    await it.run();
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  } finally {
    busy = false;
  }
}

export function quickShown(): boolean {
  return el()?.classList.contains('show') ?? false;
}

/** 打开任意动作菜单（快捷菜单与详情「更多操作」共用同一层与键位）。
 *  传 back 时该菜单是子菜单：B / Esc 先回上一层，而不是整个关掉。
 *  传 activeKey 时从该条目开始（主题 / 启动动画菜单用它停在当前值，
 *  否则焦点总在第一项，用户会以为当前值没被选中）。 */
export async function openMenu(
  title: string,
  sub: string,
  list: MenuItem[],
  opts?: { back?: () => void; activeKey?: string },
): Promise<void> {
  const m = ensure();
  // 菜单是模态层：先卸掉输入焦点。设置页正在输入时按 Start，若不主动失焦，
  // 打开菜单后字母仍会继续写进背后的输入框（A / Enter 也会被输入框吞掉）。
  const active = document.activeElement as HTMLElement | null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) active.blur();
  const t = m.querySelector<HTMLElement>('.qt');
  if (t) setRawHTML(t, `${esc(title)}<span>${esc(sub)}</span>`);
  items = list;
  const start = opts?.activeKey ? list.findIndex((x) => x.key === opts.activeKey) : -1;
  idx = start >= 0 ? start : 0;
  parent = opts?.back ?? null;
  m.classList.add('show');
  paint();
}

export async function toggleQuickMenu(): Promise<void> {
  if (quickShown()) {
    close();
    return;
  }
  // 与 dispatchNav 的菜单键守卫保持一致：搜索 / 筛选等状态层打开时不叠菜单。
  // 全局热键直接调本函数，不经过 nav 的守卫，所以校验必须放在这里。
  if (modalState()) return;
  // 先占位再 await：否则连按两次菜单键会两次都通过 quickShown() 检查，
  // 各自跑一遍 buildItems / openMenu（后一次把 idx 重置回 0）
  if (opening) return;
  opening = true;
  try {
    const list = buildItems();
    // 期间用户可能已打开搜索 / 筛选等状态层：迟到的菜单不能叠层
    if (modalState()) return;
    await openMenu('快捷菜单', 'Start / 菜单键', list);
  } finally {
    opening = false;
  }
}

export function close(): void {
  parent = null;
  el()?.classList.remove('show');
}

/** 菜单内按键：返回 true 表示已消费 */
export function handleQuickKey(e: KeyboardEvent): boolean {
  if (!quickShown()) return false;
  // 输入弹层盖在菜单上：方向键 / 字母必须先给输入框，不能驱动背后的菜单
  if (promptShown()) return false;
  if (e.code === 'Escape' || e.code === 'KeyB' || e.code === 'ContextMenu') {
    const up = parent;
    parent = null;
    if (up) up();
    else close();
    e.preventDefault();
    return true;
  }
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    if (!items.length) {
      e.preventDefault();
      return true;
    }
    const n = e.code === 'ArrowUp' ? -1 : 1;
    idx = (idx + n + items.length) % items.length;
    paint();
    e.preventDefault();
    return true;
  }
  // 左右键这里没有语义，但也必须吞掉：菜单是模态层，漏给下面会让轨道 / 网格焦点在菜单背后移动，
  // 关掉菜单时选中项莫名其妙跳走
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    return true;
  }
  if (e.code === 'Enter' || e.code === 'KeyA' || e.code === 'NumpadEnter') {
    const it = items[idx];
    if (it) void exec(it);
    e.preventDefault();
    return true;
  }
  return false;
}

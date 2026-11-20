/** 设置屏主控：页签路由、焦点环、改键捕获与各页签接线分发。
 *  八个页签：性能 / 外观 / 键位 / 启动 / 网络 / 库与统计 / 元数据 / 关于。
 *  页签内容模板在 ./settings-tabs/，交互接线在 ./settings/wire/，
 *  共享 UI 状态与落盘在 ./settings/ 下——本文件只保留「在哪一页、焦点在哪」的骨架。 */

import type { NavIntent, PadMap } from '../types';
import { TAURI, autostartEnabled, getSettings, listIgnored, onEvent } from '../ipc';
import { state, setScreen } from '../state';
import { registerHandler } from '../nav';
import { toast, esc, ringActivate, ringClear, ringEls } from '../ui';
import { setRawHTML } from '../html';
import { refreshPadHints } from '../keybar';
import { PAD_DEFAULT, PAD_KEY_LABEL, padGlyph } from '../padmap';
import { aboutHTML } from './settings-tabs/about';
import { appearanceHTML } from './settings-tabs/appearance';
import { keysHTML } from './settings-tabs/keys';
import { libraryTabHTML } from './settings-tabs/library';
import { metadataHTML } from './settings-tabs/metadata';
import { networkHTML } from './settings-tabs/network';
import { perfHTML } from './settings-tabs/perf';
import { startupHTML } from './settings-tabs/startup';
import { statsHTML } from './settings-tabs/stats';
import { sui, setRerender, rerender, panelEls, applyRing, enterRead, scrollPanel, setCapturePad } from './settings/ui';
import { persist } from '../settings-persist';
import { healthHTML, wireHealthFix } from './settings/health';
import { wireActions } from './settings/actions';
import { wirePerf } from './settings/wire/perf';
import { wireAppearance } from './settings/wire/appearance';
import { wireKeys } from './settings/wire/keys';
import { wireStartup } from './settings/wire/startup';
import { wireNetwork } from './settings/wire/network';
import { wireLibraryTab } from './settings/wire/libraryTab';
import { wireMetadataTab } from './settings/wire/metadata';
import { wireAbout, loadLogIssues } from './settings/wire/about';

setRerender(() => void renderSettings());

/** 空态 / 状态层共用的库入口保持从本文件导出，调用方不必知道动作被拆到了 settings/actions */
export { addManualGame } from './settings/actions';

/** 进入面板时的首焦点：键位页右上角「恢复默认」在 DOM 里排在映射行之前，
 *  直接取 0 会让 A 落到清空键位上，必须跳到第一条映射。 */
function panelEntryIndex(): number {
  if (sui.tab === 2) {
    const i = panelEls().findIndex((el) => el.classList.contains('pmrow'));
    if (i >= 0) return i;
  }
  // 元数据：首个焦点避开「开始匹配」——误按 A 会立刻发起一轮网络匹配；
  // 落到只读的「测试」上，主操作仍然只差一次 ↓。
  if (sui.tab === 6) {
    const i = panelEls().findIndex((el) => el.dataset.act === 'probe');
    if (i >= 0) return i;
  }
  return 0;
}

/** 按元素矩形找视觉相邻控件：↑↓ 优先同列，←→ 优先同行。
 *  两列面板不能再按 DOM 顺序走——外观页的 DOM 是「左 1、右 1、左 2、右 2」，
 *  线性上下会从右列斜跳到左列的下一行，看起来像方向键坏了。
 *  返回 -1 表示该方向没有控件。 */
function spatialTarget(
  els: HTMLElement[],
  idx: number,
  dir: 'up' | 'down' | 'left' | 'right',
): number {
  const cur = els[idx];
  if (!cur) return -1;
  const c = cur.getBoundingClientRect();
  if (c.width <= 0 && c.height <= 0) return -1;
  const cx = (c.left + c.right) / 2;
  const cy = (c.top + c.bottom) / 2;
  // 用「行」的矩形判断同列 / 同行，而不是按钮本身：
  // 右对齐的分段选择器（动效强度）和上一行左对齐的选择器可能完全不相交，
  // 按按钮矩形算会把它当成另一列，↑↓ 就会直接跳过整行。
  const cellSel = '.srow,.pitem,.pmrow,.cand-card,.sp-item,.flt-opt,.bg-card,.end-row,.lrow,.gcell,.wall-cell';
  const cell = (el: HTMLElement): DOMRect => (el.closest<HTMLElement>(cellSel) ?? el).getBoundingClientRect();
  const cc = cell(cur);
  // 单列面板（性能 / 启动 / 网络）里左右键只在同一行内找控件；
  // 允许斜跳到别行会让「帧率最后一档再按右」突然跳到上方的全屏开关。
  const bodyW = document.getElementById('sbody')?.clientWidth ?? cc.width;
  const multiCol = cc.width < bodyW * 0.7;
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  /** ←→ 的斜向兜底：只在向右时启用（右列与左列行高不齐也要能过去） */
  let diag = -1;
  let diagScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < els.length; i++) {
    if (i === idx) continue;
    const el = els[i];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    const x = (r.left + r.right) / 2;
    const y = (r.top + r.bottom) / 2;
    const rc = cell(el);
    const overlapX = Math.min(cc.right, rc.right) - Math.max(cc.left, rc.left);
    const overlapY = Math.min(cc.bottom, rc.bottom) - Math.max(cc.top, rc.top);
    // 同一个 cell 里上下堆叠的按钮（元数据「开始匹配 / 取消」）中心差一个按钮高，
    // 仅凭行容器重叠会把它算成同一行，↓ 就会直接跳过下面那个。
    const sameRow =
      overlapY > Math.min(cc.height, rc.height) * 0.5 &&
      Math.abs(y - cy) < Math.max(c.height, r.height) * 0.75;
    const sameCol = overlapX > Math.min(cc.width, rc.width) * 0.5;
    if (dir === 'up' || dir === 'down') {
      if (sameRow) continue; // 同一行里的另一个控件不参与上下移动
      const d = dir === 'down' ? y - cy : cy - y;
      if (d <= 1) continue;
      // 跨列只作为兜底：同方向同列没有控件时，才允许斜着过去
      const score = d + Math.abs(x - cx) * 0.2 + (sameCol ? 0 : 100000);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    } else {
      const d = dir === 'right' ? x - cx : cx - x;
      if (d <= 1) continue;
      const score = d + Math.abs(y - cy) * 0.2;
      if (sameRow) {
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      } else if (multiCol && dir === 'right') {
        // 左键绝不斜跳：列边再按 ← 直接回页签列，否则会「从开始体检跳到上一行的添加游戏库」
        if (score < diagScore) {
          diagScore = score;
          diag = i;
        }
      }
    }
  }
  if (best < 0) best = diag;
  if (best < 0) return -1;
  // 只有上下进入分段选择器时才停在当前值（一行里各档紧凑，↑↓ 落到当前档最直观）；
  // 左右必须按几何邻项走——左右只移焦点，若也吸附到 .on，焦点就永远停在当前档，
  // 未选中的档位再也到不了，等于分段值无法修改。
  if (dir === 'up' || dir === 'down') {
    const bestEl = els[best];
    if (!bestEl) return -1;
    const seg = bestEl.closest<HTMLElement>('.seg');
    const on = seg?.querySelector<HTMLElement>('b.on');
    if (on) {
      const onIdx = els.indexOf(on);
      if (onIdx >= 0) return onIdx;
    }
  }
  return best;
}

/** 开关补无障碍语义：模板里的 .tg 是一个空按钮，读屏只会念「按钮」。
 *  按同一行标题补 aria-label，并把 on/off 映射成 role=switch + aria-checked；
 *  翻开关的是各页签自己的 click 处理，这里等它跑完再同步状态。 */
function decorateSwitches(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.tg').forEach((el) => {
    const name = el.closest('.srow')?.querySelector('.lab b')?.textContent?.trim();
    if (!name) return;
    el.setAttribute('role', 'switch');
    el.setAttribute('aria-label', name);
    el.setAttribute('aria-checked', String(el.classList.contains('on')));
    el.addEventListener('click', () => {
      setTimeout(() => el.setAttribute('aria-checked', String(el.classList.contains('on'))), 0);
    });
  });
}

export async function renderSettings(): Promise<void> {
  if (!state.settings) state.settings = await getSettings();
  const s = state.settings;
  // 离开键位页签时退出改键态：否则回来会看到一个仍在「按手柄按键…」的行
  if (sui.capturePad && sui.tab !== 2) setCapturePad(null);
  const body = document.getElementById('sbody');
  if (!body) return;

  // 匹配完成会随时重建面板：先记下正在输入的框，重建后把值与光标还回去。
  // 只认真正的输入框：鼠标点过的开关按钮同样是 activeElement，而按钮没有 selectionStart，
  // 恢复时调 setSelectionRange 会抛 TypeError（点完任意开关再按方向键就能复现）
  const ae = document.activeElement;
  const keep =
    (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) &&
    ae.id &&
    body.contains(ae)
      ? {
          id: ae.id,
          value: ae.value,
          start: ae.selectionStart ?? 0,
          end: ae.selectionEnd ?? 0,
        }
      : null;

  // 顶栏面包屑跟着当前页签走：之前固定写「本地游戏库」，切到性能 / 外观页仍显示同一句话
  const navBtns = document.querySelectorAll('#snav button');
  navBtns.forEach((b, i) => b.classList.toggle('on', i === sui.tab));
  const crumb = document.getElementById('setCrumb');
  const tabName = navBtns[sui.tab]?.textContent?.trim();
  if (crumb && tabName) crumb.textContent = `设置 / ${tabName}`;
  // 忽略列表只在启动时读过一次：本次会话里刚移除的作品不会自己出现在这里，
  // 因此每次进入「库与统计」都从磁盘重取一次（页内重渲染不重复拉）。
  if (sui.tab === 5 && sui.lastRenderedTab !== sui.tab) {
    try {
      state.ignored = await listIgnored();
    } catch (e) {
      console.warn('[settings] 读取忽略列表失败', e);
    }
  }
  if (sui.lastRenderedTab !== sui.tab) {
    body.scrollTop = 0;
    sui.lastRenderedTab = sui.tab;
  }

  // 每个页签的模板都在 ./settings-tabs/ 下：这里只做分发，事件接线统一在 wire() 里
  switch (sui.tab) {
    case 0:
      setRawHTML(body, perfHTML(s));
      break;
    case 1:
      setRawHTML(body, appearanceHTML(s));
      break;
    case 2:
      setRawHTML(body, keysHTML(s, sui.capturePad));
      break;
    case 3:
      setRawHTML(body, startupHTML(s));
      break;
    case 4:
      setRawHTML(body, networkHTML(s));
      break;
    case 5:
      // 统计是只读页，并进「库」页签：少一个页签，也让「库 → 统计」在同一处看完
      setRawHTML(body, libraryTabHTML(healthHTML()) + statsHTML());
      break;
    case 6:
      setRawHTML(body, metadataHTML());
      break;
    default:
      setRawHTML(body, aboutHTML());
  }

  wire(body);
  decorateSwitches(body);
  // 面板重建后重新挂焦点环（DOM 换了，旧引用已失效）。
  // 但用户正在输入框里打字时不能挂：applyRing 会把焦点抢到面板第一个控件上，
  // 表现为「每敲一下 / 后台刷新一次就跳出输入框」。
  if (keep) {
    const nav = document.getElementById('snav');
    ringClear(nav ? ringEls(nav) : []);
    ringClear(panelEls());
  } else {
    applyRing();
  }
  if (sui.tab === 3) void syncBootState();
  if (sui.tab === 7) void loadLogIssues();

  // 重建完成后把正在输入的框恢复原样（值与光标位置）
  if (keep) {
    const el = document.getElementById(keep.id);
    // 再判一次类型：节点可能已被换成别的控件（按钮 / 开关），不能对它们调 setSelectionRange
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = keep.value;
      el.focus();
      el.setSelectionRange(keep.start, keep.end);
    }
  }

  // 底部「还能滚」的渐隐由 .set::after 画；滚到底就收起，
  // 否则最后一行会被那层渐变压住（也避免内容只差几十像素时一直挂一条灰边）。
  // 监听只挂一次，页签重建不影响。
  const setBox = body.closest('.set');
  const syncAtEnd = () => {
    const reach = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    setBox?.classList.toggle('atend', reach);
  };
  if (!body.dataset.scrollSync) {
    body.dataset.scrollSync = '1';
    body.addEventListener('scroll', syncAtEnd, { passive: true });
  }
  syncAtEnd();
}

/** 启动项以注册表实况为准：用户可能在任务管理器里手动关掉，界面不能继续显示「开」 */
async function syncBootState(): Promise<void> {
  if (!TAURI || !state.settings) return;
  let real: boolean;
  try {
    real = await autostartEnabled();
  } catch (e) {
    // 查询失败就保持界面原状（不能把「查不到」当成「已关闭」）
    console.warn('[settings] 查询启动项失败', e);
    return;
  }
  const btn = document.getElementById('tgBoot');
  if (!btn || !state.settings) return; // 期间切走了页签
  if (real !== state.settings.autostart) state.settings.autostart = real;
  btn.classList.toggle('on', real);
}

/** 各页签的接线按当前页签分发（面板刚重建，控件一定是本页签那批） */
function wire(body: HTMLElement): void {
  switch (sui.tab) {
    case 0:
      wirePerf(body);
      break;
    case 1:
      wireAppearance(body);
      break;
    case 2:
      wireKeys(body);
      break;
    case 3:
      wireStartup(body);
      break;
    case 4:
      wireNetwork(body);
      break;
    case 5:
      wireLibraryTab(body);
      break;
    case 6:
      wireMetadataTab(body);
      break;
    case 7:
      wireAbout(body);
      break;
    default:
      break;
  }
  wireActions(body);
  wireHealthFix(body);
}

/** 从其它屏直达某个设置页签（空态「扫描游戏库 / Steam…」等入口共用） */
export function openSettingsTab(tab: number): void {
  const n = document.querySelectorAll('#snav button').length;
  sui.tab = Math.max(0, n ? Math.min(tab, n - 1) : tab);
  sui.zone = 'nav';
  setScreen('settings');
  void renderSettings();
}

export function initSettings(): void {
  // 离开设置屏时收起改键捕获：state 里的 screen-change 事件就是为这个场景发的，
  // 之前没人监听——在「手柄键位」进入捕获后直接按 B 回库屏，capturePad 会一直挂着，
  // 之后按下的物理键会被静默重绑到那一行
  window.addEventListener('screen-change', () => {
    if (state.screen !== 'settings' && sui.capturePad) setCapturePad(null);
  });
  // 鼠标 / Tab 焦点同步：点击或 DOM 焦点落到某个控件时，把手柄焦点环也移过去。
  // 否则「鼠标点了这一行的开关，再按手柄 A」激活的仍是环停着的旧控件。
  const sbody = document.getElementById('sbody');
  sbody?.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const els = panelEls();
    const hit = els.find((el) => el === t || el.contains(t));
    if (!hit) return;
    const i = els.indexOf(hit);
    if (sui.zone === 'panel' && sui.panelIdx === i) return;
    sui.zone = 'panel';
    sui.panelIdx = i;
    applyRing();
  });
  sbody?.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const els = panelEls();
    const i = els.indexOf(t);
    if (i < 0 || (sui.zone === 'panel' && sui.panelIdx === i)) return;
    sui.zone = 'panel';
    sui.panelIdx = i;
    applyRing();
  });
  registerHandler('settings', (n: NavIntent) => {
    if (n.intent === 'back') {
      // 面板区内先退回页签列，再退才回游戏库——掌机上 B 不该一步跳出设置
      if (sui.zone === 'panel') {
        sui.zone = 'nav';
        applyRing();
        return;
      }
      setScreen('library');
      return;
    }
    if (n.intent === 'accept') {
      if (sui.zone === 'nav') {
        // 统计 / 关于是只读页：没有可聚焦控件，A / → 进入内容区滚动查看
        if (!panelEls().length) {
          enterRead();
          return;
        }
        sui.zone = 'panel';
        sui.panelIdx = panelEntryIndex();
        applyRing();
      } else if (!panelEls().length) {
        scrollPanel(1); // 内容区里 A = 向下一页
      } else {
        ringActivate(panelEls()[sui.panelIdx]);
      }
      return;
    }
    if (n.intent !== 'move') return;

    if (sui.zone === 'nav') {
      const tabs = document.querySelectorAll('#snav button').length;
      if (n.dir === 'up') sui.tab = (sui.tab + tabs - 1) % tabs;
      if (n.dir === 'down') sui.tab = (sui.tab + 1) % tabs;
      if (n.dir === 'right') {
        // 进面板：换页签后控件已重建，索引归零。
        // 只读页（统计 / 关于）没有控件，进内容区滚动查看。
        if (!panelEls().length) {
          enterRead();
          return;
        }
        sui.zone = 'panel';
        sui.panelIdx = panelEntryIndex();
        rerender();
        return;
      }
      rerender();
      return;
    }

    // 面板区：按几何位置做空间导航（双栏页签上下优先同列、左右优先同排）
    const els = panelEls();
    if (!els.length) {
      // 只读内容区：↑↓ 整页滚动，← / B 退回页签
      if (n.dir === 'up') scrollPanel(-1);
      else if (n.dir === 'down') scrollPanel(1);
      else {
        sui.zone = 'nav';
        applyRing();
      }
      return;
    }
    // ← / → 只移动焦点：不调分段值、不展开下拉、不拨开关。
    // 左右（左摇杆 / 十字键）在掌机上太容易误触，任何「顺手改一下」的设计
    // 都会变成误操作；改值 / 打开统一走 A。
    if (n.dir === 'up' || n.dir === 'down') {
      const t = spatialTarget(els, sui.panelIdx, n.dir);
      if (t >= 0) {
        sui.panelIdx = t;
        applyRing();
      } else {
        // 焦点已到可交互控件尽头：继续按上下翻只读内容（统计图 / 日志 / 长说明），
        // 焦点环留在最后一个控件上，不另起「只读尾部」模式
        scrollPanel(n.dir === 'down' ? 1 : -1);
      }
      return;
    }
    // ← / →：优先跨列；最左侧再按 ← 才退回页签列，最右侧再按 → 保持不动
    const t = spatialTarget(els, sui.panelIdx, n.dir);
    if (t >= 0) {
      sui.panelIdx = t;
      applyRing();
    } else if (n.dir === 'left') {
      sui.zone = 'nav';
      applyRing();
    }
  });
  // snav 点击
  document.querySelectorAll('#snav button').forEach((b, i) => {
    b.addEventListener('click', () => {
      sui.tab = i;
      sui.zone = 'nav'; // 鼠标点页签：焦点环回到页签列，别停在面板里
      rerender();
    });
  });

  // P5 · 改键捕获：pad://button 是物理键原始事件（不经过当前映射）。
  // 只认白名单键，未知键名直接忽略，避免写入让动作失联的值。
  void onEvent<{ button: string }>('pad://button', (ev) => {
    // 键位页的「按键测试」：不进入改键也能看到手柄识别到了什么
    if (state.screen === 'settings' && sui.tab === 2 && PAD_KEY_LABEL[ev.button]) {
      const testEl = document.querySelector('#padTest');
      if (testEl) testEl.textContent = `刚按下：${padGlyph(ev.button, state.padKind)}`;
    }
    if (!sui.capturePad || state.screen !== 'settings' || !state.settings) return;
    if (Date.now() < sui.captureAt) return; // 吞掉「按 A 激活这一行」的同一次按压
    if (!PAD_KEY_LABEL[ev.button]) return;
    // Select 固定用于库 / 网格的多选（nav 的 pad://button 监听无条件处理它）：
    // 允许改绑到这里会让一次按压同时触发该动作和多选切换
    if (ev.button === 'select') {
      toast('Select 固定用于多选，不能改绑');
      return;
    }
    const s = state.settings;
    const map: PadMap = { ...(s.padMap ?? PAD_DEFAULT) };
    const act = sui.capturePad;
    const old = map[act];
    // 撞键对调：原本占用这个键的动作改到本行原来的键上，避免一个键触发两件事
    if (ev.button !== old) {
      for (const k of Object.keys(map) as (keyof PadMap)[]) {
        if (k !== act && map[k] === ev.button) map[k] = old;
      }
    }
    map[act] = ev.button;
    s.padMap = map;
    // 开关状态跟随实际映射，避免「A/B 互换 = 关」但确认键其实在东侧
    s.abSwap = map.accept === 'east' && map.back === 'south';
    // 同一次按压已经用于绑定：紧接着到达的 nav://intent 必须丢弃，
    // 否则绑 A 会重新进入捕获、绑 Start 会弹菜单、绑 B 会退页签
    state.padMuteUntil = performance.now() + 150;
    setCapturePad(null);
    persist()
      .then(() => {
        refreshPadHints();
        rerender();
        toast(`手柄键位 · ${PAD_KEY_LABEL[ev.button]}`);
      })
      .catch((err) => {
        toast(esc(String((err as { message?: string })?.message ?? err)), true);
        rerender();
      });
  });
}

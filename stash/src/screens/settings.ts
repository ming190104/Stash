/** 设置屏主控：页签路由、焦点环、改键捕获与各页签接线分发。
 *  八个页签：性能 / 外观 / 键位 / 启动 / 网络 / 库与统计 / 元数据 / 关于。
 *  页签内容模板在 ./settings-tabs/，交互接线在 ./settings/wire/，
 *  共享 UI 状态与落盘在 ./settings/ 下——本文件只保留「在哪一页、焦点在哪」的骨架。 */

import type { NavIntent, PadMap } from '../types';
import { TAURI, autostartEnabled, getSettings, onEvent } from '../ipc';
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
import { sui, setRerender, rerender, panelEls, applyRing, enterRead, scrollPanel } from './settings/ui';
import { persist } from './settings/persist';
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
  if (sui.tab !== 2) return 0;
  const i = panelEls().findIndex((el) => el.classList.contains('pmrow'));
  return i >= 0 ? i : 0;
}

export async function renderSettings(): Promise<void> {
  if (!state.settings) state.settings = await getSettings();
  const s = state.settings;
  // 离开键位页签时退出改键态：否则回来会看到一个仍在「按手柄按键…」的行
  if (sui.capturePad && sui.tab !== 2) sui.capturePad = null;
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

  document.querySelectorAll('#snav button').forEach((b, i) => b.classList.toggle('on', i === sui.tab));
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
    if (state.screen !== 'settings' && sui.capturePad) sui.capturePad = null;
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

    // 面板区：上下遍历控件，左退回页签列
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
    if (n.dir === 'up') sui.panelIdx = (sui.panelIdx + els.length - 1) % els.length;
    if (n.dir === 'down') sui.panelIdx = (sui.panelIdx + 1) % els.length;
    if (n.dir === 'left') {
      sui.zone = 'nav';
      applyRing();
      return;
    }
    applyRing();
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
    sui.capturePad = null;
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

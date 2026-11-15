/** P0 状态层统一出口：层状态机 + 按键守卫 + 接线。
 *  各面板各自成模块（search / filter / empty / shots / endings），
 *  这里只做单例路由与对外导出，调用方（nav / screens）不必知道层被拆到了哪里。
 *
 *  导入规则（唯一定义，其它核心模块沿用）：nav / overlay / quick 及其面板模块
 *  一律 **动态 import** screens/*；screens/* 反过来 **静态 import** 核心模块。
 *  原因：screens 需要 registerHandler（nav），nav 又要调状态层；只有让核心→屏幕
 *  这条边保持懒加载，才不会形成 nav ↔ screens 的静态环。 */

import { state, setScreen } from './state';
import {
  anyState,
  emptyShown,
  filterShown,
  hideStates,
  launchShown,
  searchShown,
  showState,
  NATIVE_DEFAULT,
} from './layers';
import { promptShown, dismissPrompt, submitPrompt } from './prompt';
import { openSearch, searchFieldKey, searchKey, scheduleSearchRender, applySort } from './search';
import { openFilter, saveCurrentView, syncFilterChip, filterKey } from './filter';
import { showEmpty } from './empty';
import { shotsKey } from './shots';
import { bgKey } from './bgpanel';
import { candKey } from './candpanel';
import { endingsKey } from './endings';

export {
  anyState,
  bgShown,
  emptyShown,
  hideStates,
  launchShown,
  modalState,
  showState,
  openHelp,
  hideEmpty,
  showLoading,
  searchShown,
  filterShown,
  endShown,
  shotShown,
} from './layers';
export { openSearch, searchList, renderSearch, pushSearchHistory } from './search';
export { openFilter, renderFilter, syncFilterChip, saveCurrentView } from './filter';
export { filterDesc, showEmpty } from './empty';
export { openShots } from './shots';
export { openEndings } from './endings';

/** 返回 true 表示已消费该按键（底层屏幕不再响应）。
 *  焦点在输入框时要分两种情况：搜索框把 Esc / Enter / ↑↓ 交给候选列表；
 *  其余输入框（如设置页的代理地址）只吞掉会误触全局快捷键的键，方向键则
 *  先失焦再交回导航——否则掌机上进了输入框就出不来（B 会退屏、A 会激活别的控件）。 */
export function handleOverlayKey(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  const isField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

  if (isField && t.id === 'spInput') return searchFieldKey(e);

  if (isField) {
    if (promptShown()) {
      // 输入弹层且焦点在输入框：只接管 Esc；B / Backspace 属于正文，不能当取消键
      if (e.code === 'Escape') {
        dismissPrompt();
        e.preventDefault();
      }
      return true;
    }
    if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) {
      t.blur(); // 方向键先离开输入框，再交给导航决定去哪
      return false;
    }
    if (e.code === 'Escape') {
      t.blur();
      e.preventDefault();
      return true;
    }
    return true; // 打字期间不触发全局快捷键 / 退屏
  }

  if (promptShown()) {
    // 无输入焦点（手柄 / 点了按钮后）：A 确认、B 取消，方向键不穿透到底层屏幕
    if (e.code === 'Escape' || e.code === 'KeyB' || e.code === 'Backspace') {
      dismissPrompt();
      e.preventDefault();
      return true;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
      submitPrompt();
      e.preventDefault();
      return true;
    }
    if (NATIVE_DEFAULT.has(e.code)) e.preventDefault();
    return true;
  }

  if (searchShown()) return searchKey(e);

  if (launchShown()) {
    // 启动/运行遮罩：底层库屏一律不接收按键（否则焦点在遮罩背后偷偷移动、Enter 重复启动、Y 在背后开详情）。
    // X = 结束游戏，与遮罩上的键位提示一致；点击 #llStop 复用 library.ts 的唯一实现，不重复写 IPC 逻辑。
    if (e.code === 'KeyX') {
      (document.getElementById('llStop') as HTMLElement | null)?.click();
    }
    e.preventDefault();
    return true;
  }

  if (emptyShown()) {
    // 掌机上 A 必须能触发当前空态的主按钮：空库 = 添加游戏 exe，无结果 = 清除筛选
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
      const primary = (document.getElementById('emAdd') ??
        document.getElementById('emClear')) as HTMLElement | null;
      primary?.click();
      e.preventDefault();
      return true;
    }
  }

  if (document.getElementById('errorState')?.classList.contains('show')) {
    // 失败态同理：A = 重试（重新读库）
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
      (document.querySelector('#errorState [data-state="retry"]') as HTMLElement | null)?.click();
      e.preventDefault();
      return true;
    }
  }

  if (document.getElementById('endPanel')?.classList.contains('show')) return endingsKey(e);
  if (document.getElementById('shotPanel')?.classList.contains('show')) return shotsKey(e);
  if (document.getElementById('bgPanel')?.classList.contains('show')) return bgKey(e);
  if (document.getElementById('candPanel')?.classList.contains('show')) return candKey(e);
  if (filterShown()) return filterKey(e);

  if (!anyState()) return false;
  if (e.code === 'Escape' || e.code === 'Backspace' || e.code === 'KeyB') {
    hideStates();
    e.preventDefault();
    return true;
  }
  if (NATIVE_DEFAULT.has(e.code)) e.preventDefault();
  return true; // 任一状态层打开：只认关闭键，底层屏幕不响应
}

/* ============ 接线 ============ */

export function initOverlay(): void {
  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSearch()));

  const inp = document.getElementById('spInput') as HTMLInputElement | null;
  inp?.addEventListener('input', () => {
    state.query = inp.value;
    // 120ms 防抖：Enter / A 走 activateResult 里的 flushSearchRender，不会点到旧候选
    scheduleSearchRender();
  });

  document.querySelectorAll('#spSort b').forEach((b, i) => {
    b.addEventListener('click', () => applySort(i));
  });

  document.querySelectorAll('#errorState [data-state]').forEach((b) => {
    b.addEventListener('click', () => {
      if ((b as HTMLElement).dataset.state === 'retry') {
        // 刷新失败已在 refreshLibrary 统一提示，这里只兜住发射后不管的 Promise
        void import('./screens/library').then((m) => m.refreshLibrary().catch(() => undefined));
      } else setScreen('settings');
    });
  });

  document.getElementById('fBtn')?.addEventListener('click', openFilter);
  document.getElementById('saveView')?.addEventListener('click', () => {
    if (filterShown()) void saveCurrentView();
  });

  // 鼠标习惯：点面板外的暗底 = 关闭（面板是铺满的 .state，内容在 .sp-box / .flt-box 里，
  // 所以只有 target 恰好是面板自身时才算点了空白）。键盘 / 手柄仍走 Esc / B。
  for (const id of ['searchPanel', 'filterPanel', 'endPanel', 'shotPanel', 'helpPanel']) {
    const panel = document.getElementById(id);
    panel?.addEventListener('click', (e) => {
      if (e.target === panel) hideStates();
    });
  }
  syncFilterChip();
}

/** ?state= 直达（规格截图 / 目检）：search 搜索·排序 · filter 分面筛选 · empty 空库 · noresult 无结果 · loading 加载 · error 读取失败 */
export function applyStateParam(): void {
  const st = new URLSearchParams(location.search).get('state');
  if (st === 'search') openSearch();
  else if (st === 'filter') openFilter();
  else if (st === 'empty') showEmpty('empty');
  else if (st === 'noresult') showEmpty('noresult');
  else if (st === 'loading') showState('loadingState');
  else if (st === 'error') showState('errorState');
}

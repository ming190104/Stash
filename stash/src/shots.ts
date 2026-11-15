/** 截图查看器（详情页截图条点开）：← / → 切换，A 下一张，X 删除（二次确认）。 */

import { esc, toast, cssUrl } from './ui';
import { asset, deleteShot } from './ipc';
import { gameById } from './state';
import { hideStates, showState, NATIVE_DEFAULT } from './layers';

let shotList: string[] = [];
let shotIdx = 0;
/** 当前截图属于哪部作品（删除要走 IPC，必须有 id） */
let shotGame = '';
/** 删除的「再按一次确认」武装态：3 秒内不再按就自动取消 */
let shotArmTimer = 0;
/** 每次打开自增：异步取 URL 回来时若已关层 / 换图，丢弃旧结果 */
let shotToken = 0;

export function openShots(id: string, shots: string[], start = 0): void {
  shotList = shots.filter(Boolean);
  if (!shotList.length) return;
  shotGame = id;
  shotIdx = Math.min(Math.max(0, start), shotList.length - 1);
  const token = ++shotToken;
  disarmShotDel();
  showState('shotPanel');
  // 鼠标用户没有 A 键：点大图进下一张，不用去摸键盘
  const img = document.getElementById('shotvImg');
  if (img && !img.dataset.wired) {
    img.dataset.wired = '1';
    img.addEventListener('click', () => stepShot(1));
  }
  const del = document.getElementById('shotDel');
  if (del && !del.dataset.wired) {
    del.dataset.wired = '1';
    del.addEventListener('click', () => void deleteShotCur());
  }
  void renderShots(token);
}

async function renderShots(token = shotToken): Promise<void> {
  const img = document.getElementById('shotvImg');
  const cap = document.getElementById('shotvCap');
  if (!img) return;
  const src = shotList[shotIdx];
  if (cap) cap.textContent = shotList.length > 1 ? `${shotIdx + 1} / ${shotList.length}` : '';
  if (!src) {
    img.style.backgroundImage = 'none';
    return;
  }
  try {
    const u = await asset(src);
    if (token !== shotToken) return; // 期间已切到别的截图，旧 URL 不许回填
    img.style.backgroundImage = cssUrl(u);
  } catch {
    if (token !== shotToken) return;
    img.style.backgroundImage = 'none';
  }
}

function stepShot(step: number): void {
  if (shotList.length < 2) return;
  shotIdx = (shotIdx + step + shotList.length) % shotList.length;
  disarmShotDel(); // 换了一张图：之前的「确认删除」作废，别误删下一张
  void renderShots();
}

/** 删除按钮恢复成「删除这张」 */
function disarmShotDel(): void {
  clearTimeout(shotArmTimer);
  const btn = document.getElementById('shotDel');
  const txt = document.getElementById('shotDelTxt');
  if (txt) txt.textContent = '删除这张';
  btn?.classList.remove('arm');
}

/** 第一次按：按钮变红并提示再按一次（删除是本地文件，不可撤销） */
function armShotDel(): void {
  const btn = document.getElementById('shotDel');
  const txt = document.getElementById('shotDelTxt');
  if (txt) txt.textContent = '再按一次删除';
  btn?.classList.add('arm');
  clearTimeout(shotArmTimer);
  shotArmTimer = window.setTimeout(disarmShotDel, 3000);
}

async function deleteShotCur(): Promise<void> {
  const src = shotList[shotIdx];
  if (!src || !shotGame) return;
  const btn = document.getElementById('shotDel');
  if (!btn?.classList.contains('arm')) {
    armShotDel();
    return;
  }
  disarmShotDel();
  const id = shotGame;
  const token = shotToken;
  try {
    const left = await deleteShot(id, src);
    // 删除等待期间可能已换作品 / 重开面板，旧响应不得污染新一轮状态
    if (id !== shotGame || token !== shotToken) return;
    shotList = left;
    shotIdx = Math.min(shotIdx, Math.max(0, shotList.length - 1));
    const g = gameById(id);
    if (g) g.shots = left; // 详情 / Hero / 列表都吃这份内存数据
    toast(left.length ? `已删除这张截图 · 还剩 ${left.length} 张` : '已删除这张截图');
    void import('./screens/detail').then((m) => m.renderDetail());
    void import('./screens/library').then((m) => m.renderRail());
    if (!shotList.length) {
      hideStates();
      return;
    }
    void renderShots();
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

/** 截图查看器的按键（调用前已确认面板打开） */
export function shotsKey(e: KeyboardEvent): boolean {
  if (e.code === 'Escape' || e.code === 'KeyB' || e.code === 'Backspace') {
    hideStates();
    e.preventDefault();
    return true;
  }
  // 左右切图；A / Enter 等价「下一张」，单张时什么也不做（掌机上 A 不该有副作用）
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    stepShot(e.code === 'ArrowRight' ? 1 : -1);
    e.preventDefault();
    return true;
  }
  if (e.code === 'KeyX') {
    void deleteShotCur();
    e.preventDefault();
    return true;
  }
  if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
    stepShot(1);
    e.preventDefault();
    return true;
  }
  if (NATIVE_DEFAULT.has(e.code)) e.preventDefault();
  return true;
}

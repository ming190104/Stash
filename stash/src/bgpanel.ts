/** 背景图候选墙（详情 · 更多操作 · 背景图）：**上方画面 + 下方文字**的卡片，点选即应用。
 *
 *  候选由后端匹配（当前背景 / 目录实机图 / 商店横幅）并生成 16:9 缩略图，
 *  这里只负责排版、键鼠焦点与「选中了哪一个」——真正落盘由详情屏拿返回值后走 IPC，
 *  这样面板不必知道详情屏的刷新逻辑，也不会和 screens/* 形成静态环。 */

import { html, setHTML } from './html';
import { asset, backgroundCandidates, type BgCandidate } from './ipc';
import { hideStates, showState, NATIVE_DEFAULT } from './layers';

/** 面板返回的特殊选择：交给详情屏走「文件对话框 / 恢复自动」 */
export const BG_PICK = '@pick';
export const BG_AUTO = '@auto';

/** 卡片列数：方向键的上下步长与 CSS 的 grid-template-columns 必须一致 */
const BG_COLS = 4;

let items: BgCandidate[] = [];
let idx = 0;
/** 每次打开自增：异步候选 / 缩略图回来时若已关闭或换了一部作品，丢弃旧结果 */
let token = 0;
/** 等待用户选择的回调：关闭 / 选择时以 key 或 null 收尾 */
let settle: ((v: string | null) => void) | null = null;

/** 打开面板并等一个选择：返回候选 key、`BG_PICK` / `BG_AUTO`，关闭则 null */
export function openBgPanel(id: string, title: string): Promise<string | null> {
  const tok = ++token;
  // 上一次还没收尾（比如连点两次「背景图…」）：先按「关闭」结束，别让旧调用方永远 await
  settle?.(null);
  settle = null;
  items = [];
  idx = 0;
  const sub = document.getElementById('bgTitle');
  if (sub) sub.textContent = title;
  wirePanel();
  showState('bgPanel');
  paintTip('正在匹配背景候选…');
  const done = new Promise<string | null>((res) => {
    settle = res;
  });
  void load(id, tok);
  return done;
}

async function load(id: string, tok: number): Promise<void> {
  try {
    // 首屏只取本地候选（当前背景 / 目录截图）：打开面板立刻有卡片，不被网络拖住
    const local = await backgroundCandidates(id, false);
    if (tok !== token || !settle) return; // 已关闭 / 已重新打开
    items = local;
    // 默认焦点落在「当前背景」上：用户一眼能看到自己正在用哪张
    idx = Math.max(0, items.findIndex((c) => c.current));
    if (items.length) {
      paintCards();
      void fillThumbs(tok);
    }
    // 再补在线候选（SGDB 走 1 req/s 闸门，可能要几秒）；关闭面板后结果直接丢弃。
    // 不能按「数量是否变化」判断：在线候选与本地候选数量相同时整批会被丢掉。
    // 以服务端顺序为准，本地独有的候选追加在后面，按 key 去重。
    const all = await backgroundCandidates(id, true);
    if (tok !== token || !settle) return;
    const keep = items[idx]?.key;
    const merged = [...all];
    for (const c of items) {
      if (!merged.some((m) => m.key === c.key)) merged.push(c);
    }
    const changed =
      merged.length !== items.length ||
      merged.some((c, i) => c.key !== items[i]?.key);
    if (changed) {
      items = merged;
      const at = keep ? items.findIndex((c) => c.key === keep) : -1;
      idx = at >= 0 ? at : Math.max(0, items.findIndex((c) => c.current));
      paintCards();
      await fillThumbs(tok);
    }
    if (!items.length) {
      paintTip('没有匹配到背景候选 · 可用「指定图片」选一张本地图片');
    }
  } catch (e) {
    if (tok !== token) return;
    paintTip(`读取背景候选失败：${(e as { message?: string })?.message ?? String(e)}`);
  }
}

function paintCards(): void {
  const grid = document.getElementById('bgGrid');
  if (!grid) return;
  setHTML(
    grid,
    html`${items.map(
      (c, i) => html`<button class="bg-card${c.current ? ' on' : ''}" data-i="${i}" data-key="${c.key}" type="button">
  <span class="bg-th"><span class="bg-ph">载入中…</span>${c.current ? html`<b class="bg-badge">当前</b>` : ''}</span>
  <span class="bg-nm">${c.label}</span>
  <span class="bg-meta">${metaOf(c)}</span>
</button>`,
    )}`,
  );
  grid.querySelectorAll<HTMLElement>('.bg-card').forEach((el) => {
    const i = Number(el.dataset.i);
    // 鼠标点卡片即应用；悬停同步焦点，键盘接着从这张往下走
    el.addEventListener('click', () => choose(i));
    el.addEventListener('mouseenter', () => {
      idx = i;
      applyFocus();
    });
  });
  applyFocus();
}

/** 缩略图逐张挂上：都走 asset 协议（CSP 只放行 asset: / data:）；失败就留占位，不影响点选 */
async function fillThumbs(tok: number): Promise<void> {
  const grid = document.getElementById('bgGrid');
  if (!grid) return;
  await Promise.all(
    items.map(async (c) => {
      if (!c.thumb) return;
      const u = await asset(c.thumb).catch(() => '');
      if (tok !== token || !u) return;
      // 在线候选可能已重绘：按 key 找当前卡片，不能沿用过期索引贴错图
      const th = [...grid.querySelectorAll<HTMLElement>('.bg-card')]
        .find((card) => card.dataset.key === c.key)
        ?.querySelector<HTMLElement>('.bg-th');
      if (!th) return;
      const im = document.createElement('img');
      im.alt = '';
      im.loading = 'lazy';
      im.src = u;
      // 首屏本地候选与在线候选各会跑一次 fillThumbs：先摘掉旧图，避免同一张卡插两张
      th.querySelector('img')?.remove();
      th.querySelector('.bg-ph')?.remove();
      th.prepend(im);
    }),
  );
  if (tok !== token) return;
  // 后端没能生成缩略图的候选：占位文案从「载入中…」改成「无预览」，别一直转圈
  grid.querySelectorAll<HTMLElement>('.bg-ph').forEach((ph) => {
    ph.textContent = '无预览';
  });
}

function metaOf(c: BgCandidate): string {
  const src =
    c.source === 'current'
      ? '正在使用'
      : c.source === 'local'
        ? '游戏目录'
        : c.source === 'sgdb'
          ? 'SteamGridDB'
          : '';
  const dim = c.width && c.height ? `${c.width}×${c.height}` : '';
  return [src, dim].filter(Boolean).join(' · ') || '背景候选';
}

function paintTip(text: string): void {
  const grid = document.getElementById('bgGrid');
  if (grid) setHTML(grid, html`<div class="bg-tip">${text}</div>`);
}

function applyFocus(): void {
  const cards = [...document.querySelectorAll<HTMLElement>('#bgGrid .bg-card')];
  cards.forEach((c, i) => c.classList.toggle('focus', i === idx));
  cards[idx]?.scrollIntoView({ block: 'nearest' });
}

function choose(i: number): void {
  const c = items[i];
  if (!c) return;
  finish(c.key);
}

/** 收尾：先清空回调再关层，避免 hideStates 触发的重绘把结果重复交给详情屏 */
function finish(v: string | null): void {
  token++;
  const res = settle;
  settle = null;
  const grid = document.getElementById('bgGrid');
  if (grid) grid.replaceChildren();
  hideStates();
  res?.(v);
}

/** 面板自身只绑一次：点暗底 = 关闭（卡片点击已 stopPropagation 式地由自身处理） */
function wirePanel(): void {
  const panel = document.getElementById('bgPanel');
  if (!panel || panel.dataset.wired) return;
  panel.dataset.wired = '1';
  panel.addEventListener('click', (e) => {
    if (e.target === panel) finish(null);
  });
  document.getElementById('bgPick')?.addEventListener('click', () => finish(BG_PICK));
  document.getElementById('bgAuto')?.addEventListener('click', () => finish(BG_AUTO));
}

/** 面板按键（调用前已确认 bgPanel 打开）：方向键换焦点，A / Enter 应用，B / Esc 关闭 */
export function bgKey(e: KeyboardEvent): boolean {
  if (e.code === 'Escape' || e.code === 'KeyB' || e.code === 'Backspace') {
    finish(null);
    e.preventDefault();
    return true;
  }
  if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) {
    if (items.length) {
      const step =
        e.code === 'ArrowLeft'
          ? -1
          : e.code === 'ArrowRight'
            ? 1
            : e.code === 'ArrowUp'
              ? -BG_COLS
              : BG_COLS;
      idx = Math.min(items.length - 1, Math.max(0, idx + step));
      applyFocus();
    }
    e.preventDefault();
    return true;
  }
  if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
    if (items.length) choose(idx);
    e.preventDefault();
    return true;
  }
  // 文件对话框 / 恢复自动：键盘与手柄都能到（手柄 X / Y 会合成 KeyX / KeyY）
  if (e.code === 'KeyP' || e.code === 'KeyX') {
    finish(BG_PICK);
    e.preventDefault();
    return true;
  }
  if (e.code === 'KeyR' || e.code === 'KeyY') {
    finish(BG_AUTO);
    e.preventDefault();
    return true;
  }
  if (NATIVE_DEFAULT.has(e.code)) e.preventDefault();
  return true;
}

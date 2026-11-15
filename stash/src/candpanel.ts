/** 改绑 / 应用候选：把四源候选做成模态卡片墙 + 右侧详情预览。
 *
 *  设置 · 元数据里点「改绑… / 校正… / 连续确认…」都会进这里。
 *  A 应用（只写勾选的字段），F 进入字段勾选，X 取消匹配，B 关闭。
 *  传 queue 时按队列连续确认：应用成功自动检索下一部。 */

import type { MetaCandidate } from './types';
import { html, setHTML } from './html';
import { applyCandidate, asset, metaCandidates, unmatchGame, type MetaField } from './ipc';
import { hideStates, showState, NATIVE_DEFAULT } from './layers';
import { toast, cssUrl, esc } from './ui';
import { placeholderArt } from './art';

/** 卡片列数：方向键上下步长与 CSS 的 grid-template-columns 必须一致 */
const COLS = 4;

const LABEL: Record<MetaField, string> = {
  title: '标题',
  original: '原名',
  year: '年份',
  summary: '简介/标签',
  cover: '封面',
  score: '评分',
  length: '时长',
};

/** 各来源真正能提供的字段；其余字段在预览里不出现 */
const APPLICABLE: Record<MetaCandidate['source'], MetaField[]> = {
  bangumi: ['title', 'original', 'year', 'summary', 'cover', 'score'],
  moegirl: ['title', 'year', 'summary', 'cover'],
  egs: ['score', 'length'],
  kungal: ['title', 'original', 'year', 'summary', 'cover', 'score', 'length'],
};

/** 面板收尾结果：绑定 / 取消匹配 / 直接关闭（null） */
export type CandResult = 'bind' | 'unmatch' | null;

interface QueueItem {
  id: string;
  title: string;
}

let items: MetaCandidate[] = [];
let arts: string[] = [];
let idx = 0;
let gameId = '';
/** 每次打开自增：异步候选回来时若已关闭 / 已换作品，丢弃旧结果 */
let token = 0;
/** 等待结果的回调：选择 / 取消 / 关闭时收尾 */
let settle: ((v: CandResult) => void) | null = null;
/** 绑定 / 取消匹配进行中：连按 A 不重复发请求 */
let busy = false;
/** 请求已发出、用户先按了 B：界面收起，但结果回来后再把成功 / 失败交给调用方（否则库不刷新） */
let closing = false;
/** 勾选要写入的字段：跨候选保留，应用时与当前来源的可写字段取交集 */
let picked = new Set<MetaField>();
/** 批量确认队列（可空）；qIdx 指向当前作品 */
let queue: QueueItem[] = [];
let qIdx = 0;
/** 字段勾选模式：方向键在字段间移动，A 切换，B / F 退出 */
let fieldMode = false;
let fieldIdx = 0;
/** 批量队列里已成功应用过（中途按 B 也要让调用方刷新库） */
let appliedAny = false;

/** 打开候选面板并等结果：绑定成功 `bind`、取消匹配 `unmatch`、关闭 null。
 *  `queue` 给出时进入批量确认模式，应用后自动检索下一条。 */
export function openCandPanel(id: string, title: string, queueIn?: QueueItem[]): Promise<CandResult> {
  const tok = ++token;
  // 上一份还没收尾（连续点两部作品的改绑）：先按「关闭」结束，别让上一个调用方永远 await
  settle?.(null);
  settle = null;
  items = [];
  arts = [];
  idx = 0;
  gameId = id;
  busy = false;
  closing = false;
  picked = new Set<MetaField>(['title', 'original', 'year', 'summary', 'cover', 'score', 'length']);
  fieldMode = false;
  fieldIdx = 0;
  appliedAny = false;
  queue = queueIn?.length ? queueIn : [];
  qIdx = queue.findIndex((q) => q.id === id);
  if (qIdx < 0) {
    queue = [];
    qIdx = 0;
  }
  const sub = document.getElementById('candTitle');
  if (sub) sub.textContent = title;
  wirePanel();
  showState('candPanel');
  paintQueue();
  paintTip('四源并行检索中… Bangumi / 萌娘百科 / 批评空间 / 鲲 Galgame，请稍候');
  const done = new Promise<CandResult>((res) => {
    settle = res;
  });
  void load(id, tok);
  return done;
}

async function load(id: string, tok: number): Promise<void> {
  try {
    const list = await metaCandidates(id, 4);
    if (tok !== token || !settle) return;
    items = list;
    if (!items.length) {
      paintTip('没有候选 · 换个关键字，或直接在游戏目录放 meta.json');
      return;
    }
    const got = await Promise.all(
      items.map((c) => (c.thumb ? asset(c.thumb).catch(() => '') : Promise.resolve(''))),
    );
    if (tok !== token || !settle) return;
    arts = got;
    paintCards();
  } catch (e) {
    if (tok !== token) return;
    paintTip(`检索失败：${(e as { message?: string })?.message ?? String(e)}`);
  }
}

const SRC: Record<MetaCandidate['source'], string> = {
  bangumi: 'Bangumi',
  moegirl: '萌娘百科',
  egs: '批评空间',
  kungal: '鲲 Galgame',
};

/** 卡片副行：年份 + 该源自己的可比数字（EGS 用中央值 / 时长，其余用相似度） */
function metaLine(c: MetaCandidate): string {
  const bits: string[] = [];
  if (c.year != null) bits.push(String(c.year));
  if (c.source === 'egs' && c.egs) {
    if (c.egs.score != null) bits.push(`中央值 ${Math.round(c.egs.score)}`);
    if (c.egs.minutes != null) bits.push(`${Math.round(c.egs.minutes / 60)} 小时`);
  } else if (c.source === 'bangumi') {
    // 萌娘的 60 分只是「命中关键词」的固定分，不是可信度，不展示
    bits.push(`${c.score} 分`);
  } else if (c.source === 'kungal') {
    // 鲲的 score 是标题相似度，不是站内评分，标成「匹配」避免误读
    bits.push(`匹配 ${c.score}`);
  }
  return bits.join(' · ') || '—';
}

function artStyle(c: MetaCandidate, i: number): string {
  return arts[i]
    ? `background-image:${cssUrl(arts[i])}`
    : `background:${placeholderArt(String(c.key)).bg}`;
}

function paintCards(): void {
  const grid = document.getElementById('candGrid');
  if (!grid) return;
  setHTML(
    grid,
    html`${items.map((c, i) => html`<button class="cand-card${i === idx ? ' focus' : ''}" data-i="${i}" type="button">
  <span class="cand-art" style="${artStyle(c, i)}"><i class="cand-src">${SRC[c.source]}</i></span>
  <b class="cand-nm">${c.title}</b>
  <span class="cand-mt">${metaLine(c)}</span>
</button>`)}`,
  );
  grid.querySelectorAll<HTMLElement>('.cand-card').forEach((el) => {
    const i = Number(el.dataset.i);
    el.addEventListener('click', () => void pick(i));
    el.addEventListener('mouseenter', () => {
      idx = i;
      applyFocus();
    });
  });
  applyFocus();
}

function paintTip(text: string): void {
  const grid = document.getElementById('candGrid');
  if (grid) setHTML(grid, html`<div class="cand-tip">${text}</div>`);
  const prev = document.getElementById('candPrev');
  if (prev) setHTML(prev, html`<div class="cprev-empty">${text}</div>`);
}

/** 右侧预览：封面 / 标题 / 来源数据 / 简介 / 可写字段勾选 */
function paintPreview(): void {
  const box = document.getElementById('candPrev');
  if (!box) return;
  const c = items[idx];
  if (!c) {
    setHTML(box, html`<div class="cprev-empty">选中左侧候选查看详情</div>`);
    return;
  }
  const app = APPLICABLE[c.source];
  const chips = app.map(
    (f, i) =>
      html`<button class="cprev-chip${picked.has(f) ? ' on' : ''}${fieldMode && i === fieldIdx ? ' cur' : ''}" data-f="${f}" type="button">${LABEL[f]}</button>`,
  );
  setHTML(
    box,
    html`<div class="cprev-art" style="${artStyle(c, idx)}"></div>
<div class="cprev-h"><b>${c.title}</b><span>${SRC[c.source]} · ${metaLine(c)}</span></div>
<p class="cprev-sum">${(c.summary ?? '').trim() || '该来源没有简介'}</p>
<div class="cprev-f"><span class="cprev-fl">写入字段（F 切换，A 勾选）</span>${chips}</div>`,
  );
}

function paintQueue(): void {
  const el = document.getElementById('candQueue');
  if (el) el.textContent = queue.length ? `队列 ${qIdx + 1}/${queue.length}` : '';
}

function applyFocus(): void {
  const cards = [...document.querySelectorAll<HTMLElement>('#candGrid .cand-card')];
  cards.forEach((c, i) => c.classList.toggle('focus', i === idx));
  cards[idx]?.scrollIntoView({ block: 'nearest' });
  paintPreview();
}

function fieldsOf(c: MetaCandidate | undefined): MetaField[] {
  return c ? APPLICABLE[c.source] : [];
}

function toggleField(f: MetaField): void {
  if (!fieldsOf(items[idx]).includes(f)) return;
  if (picked.has(f)) picked.delete(f);
  else picked.add(f);
  paintPreview();
}

/** 应用成功 / 取消匹配后的流程：队列里还有下一部就原地换数据，否则收尾 */
function advance(kind: Exclude<CandResult, null>): void {
  if (closing) {
    finish(kind);
    return;
  }
  if (queue.length && qIdx < queue.length - 1) {
    qIdx++;
    const nx = queue[qIdx];
    gameId = nx.id;
    items = [];
    arts = [];
    idx = 0;
    busy = false;
    fieldMode = false;
    fieldIdx = 0;
    const sub = document.getElementById('candTitle');
    if (sub) sub.textContent = nx.title;
    paintQueue();
    paintTip('四源并行检索中… Bangumi / 萌娘百科 / 批评空间 / 鲲 Galgame，请稍候');
    void load(nx.id, token);
    return;
  }
  finish(kind);
}

async function pick(i: number): Promise<void> {
  if (busy) return;
  const c = items[i];
  if (!c) return;
  const my = token;
  busy = true;
  try {
    // 只写当前来源支持、且用户勾选的字段；空数组表示只确认条目
    const sel = APPLICABLE[c.source].filter((f) => picked.has(f));
    await applyCandidate(gameId, c.source, c.key, sel);
    if (my !== token) return; // 期间已换了另一部作品的候选墙：结果不落到新面板
    appliedAny = true;
    advance('bind');
  } catch (e) {
    if (my !== token) return;
    busy = false;
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
    if (closing) finish(null); // 面板已收起：把失败收尾掉，调用方不必等
  }
}

async function unmatch(): Promise<void> {
  if (busy || !gameId) return;
  const my = token;
  busy = true;
  try {
    await unmatchGame(gameId);
    if (my !== token) return;
    advance('unmatch');
  } catch (e) {
    if (my !== token) return;
    busy = false;
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
    if (closing) finish(null);
  }
}

/** 收尾：先清空回调再关层，避免 hideStates 触发的重绘把结果重复交出去 */
function finish(v: CandResult): void {
  // 绑定 / 取消匹配已发出时按 B：只收界面，等请求回来再交结果——
  // 立刻 resolve null 会让设置页错过刷新，列表上还是旧的绑定。
  if (busy && v === null) {
    closing = true;
    hideStates();
    return;
  }
  token++;
  const res = settle;
  settle = null;
  busy = false;
  closing = false;
  fieldMode = false;
  queue = [];
  qIdx = 0;
  const grid = document.getElementById('candGrid');
  if (grid) grid.replaceChildren();
  const prev = document.getElementById('candPrev');
  if (prev) prev.replaceChildren();
  paintQueue();
  hideStates();
  // 队列中途退出：前面已经写入的作品也要让调用方刷新
  res?.(v ?? (appliedAny ? 'bind' : null));
  appliedAny = false;
}

/** 面板自身只绑一次：点暗底关闭；字段芯片用委托（预览会随焦点重绘） */
function wirePanel(): void {
  const panel = document.getElementById('candPanel');
  if (!panel || panel.dataset.wired) return;
  panel.dataset.wired = '1';
  panel.addEventListener('click', (e) => {
    if (e.target === panel) finish(null);
  });
  document.getElementById('candUnmatch')?.addEventListener('click', () => void unmatch());
  document.getElementById('candPrev')?.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
    if (chip) toggleField(chip.dataset.f as MetaField);
  });
}

/** 面板按键（调用前已确认 candPanel 打开）：
 *  卡片模式：方向键换卡片，A 应用，X 取消匹配，F 进字段模式，B / Esc 关闭；
 *  字段模式：方向键换字段，A 勾选 / 取消，B / Esc / F 退回卡片。 */
export function candKey(e: KeyboardEvent): boolean {
  if (e.code === 'KeyF') {
    fieldMode = !fieldMode;
    fieldIdx = 0;
    paintPreview();
    e.preventDefault();
    return true;
  }
  if (fieldMode) {
    if (e.code === 'Escape' || e.code === 'KeyB' || e.code === 'Backspace') {
      fieldMode = false;
      paintPreview();
    } else if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) {
      const n = fieldsOf(items[idx]).length;
      if (n) {
        const step = e.code === 'ArrowLeft' || e.code === 'ArrowUp' ? -1 : 1;
        fieldIdx = (fieldIdx + step + n) % n;
        paintPreview();
      }
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
      const f = fieldsOf(items[idx])[fieldIdx];
      if (f) toggleField(f);
    }
    e.preventDefault();
    return true;
  }
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
              ? -COLS
              : COLS;
      idx = Math.min(items.length - 1, Math.max(0, idx + step));
      applyFocus();
    }
    e.preventDefault();
    return true;
  }
  if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
    if (items.length) void pick(idx);
    e.preventDefault();
    return true;
  }
  if (e.code === 'KeyX') {
    void unmatch();
    e.preventDefault();
    return true;
  }
  if (NATIVE_DEFAULT.has(e.code)) e.preventDefault();
  return true;
}

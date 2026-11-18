/** 结局 / 路线标记（P2）：A 达成/撤销 · Y 新增 · X 删除。 */

import type { EndMark } from './types';
import { esc, toast, clickable } from './ui';
import { setRawHTML } from './html';
import { updateEndings } from './ipc';
import { gameById, markLocalEdit, clearLocalEdit } from './state';
import { hideStates, showState, NATIVE_DEFAULT } from './layers';

let endGame = '';
let endIdx = 0;

export function openEndings(id: string): void {
  endGame = id;
  endIdx = 0;
  showState('endPanel');
  renderEndings();
}

function endingsOf(): EndMark[] {
  return gameById(endGame)?.endings ?? [];
}

function renderEndings(): void {
  const box = document.getElementById('endList');
  const title = document.getElementById('endTitle');
  const g = gameById(endGame);
  const list = endingsOf();
  const done = list.filter((e) => e.done).length;
  if (title) {
    title.textContent = g
      ? list.length
        ? `${g.title} · ${done}/${list.length} 达成`
        : `${g.title} · 尚未记录`
      : '';
  }
  if (!box) return;
  if (!list.length) {
    setRawHTML(
      box,
      `<div class="snap-empty">还没有结局记录。按 Y 新增一条（END 1、END 2…），通关一条就勾一条。</div>`,
    );
    return;
  }
  endIdx = Math.min(Math.max(0, endIdx), list.length - 1);
  setRawHTML(
    box,
    list
    .map(
      (e, i) => `
    <div class="end-row${e.done ? ' done' : ''}${i === endIdx ? ' focus' : ''}" data-i="${i}">
      <span class="end-dot"></span>
      <span class="end-nm">${esc(e.name)}</span>
      <span class="end-acts">
        <span class="snap-act" data-act="toggle" data-i="${i}">${e.done ? '撤销' : '达成'}</span>
        <span class="snap-act del" data-act="del" data-i="${i}">删除</span>
      </span>
    </div>`,
    )
    .join(''),
  );
  box.querySelectorAll<HTMLElement>('.end-row').forEach((row) => {
    clickable(row);
    row.addEventListener('click', () => {
      endIdx = Number(row.dataset.i);
      renderEndings();
    });
  });
  box.querySelectorAll<HTMLElement>('.end-act, .snap-act').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      endIdx = Number(btn.dataset.i);
      if (btn.dataset.act === 'toggle') toggleEnd(endIdx);
      else deleteEnd(endIdx);
    });
  });
  box.querySelector<HTMLElement>('.end-row.focus')?.scrollIntoView({ block: 'nearest' });
}

/** 整份清单回写：先本地生效（连续勾选不会丢），再串行落盘（后一次带着最新清单）。 */
let endWrite: Promise<void> = Promise.resolve();

function saveEndings(next: EndMark[]): void {
  const g = gameById(endGame);
  if (!g) return;
  g.endings = next;
  // 登记意图：写盘期间后台刷新可能把 state.games 换成写盘前的快照，
  // 链上下一环再读 gameById 就会拿到旧清单、把刚勾的「达成」写没
  markLocalEdit(g.id, { endings: next });
  renderEndings();
  void import('./screens/library').then((m) => m.renderRail());
  void import('./screens/grid').then((m) => m.renderGrid());
  void import('./screens/detail').then((m) => m.renderDetail());
  const id = endGame;
  endWrite = endWrite
    .then(async () => {
      // 写的是意图里的最新清单，不依赖可能已被替换的 state 对象
      await updateEndings(id, next);
    })
    .catch((e) => {
      // 失败就撤掉意图，让下一次刷新回到磁盘真值（而不是一直显示没存上的内容）
      clearLocalEdit(id, ['endings']);
      toast(esc(String((e as { message?: string })?.message ?? e)), true);
    });
}

function toggleEnd(i: number): void {
  saveEndings(endingsOf().map((e, j) => (j === i ? { ...e, done: !e.done } : e)));
}

function deleteEnd(i: number): void {
  const list = endingsOf().filter((_, j) => j !== i);
  endIdx = Math.max(0, Math.min(endIdx, list.length - 1));
  saveEndings(list);
}

/** 新增：自动命名 END N（取现有最大编号 +1，删过再建也不会撞名） */
function addEnd(): void {
  const list = endingsOf();
  const nums = list.map((e) => Number(e.name.replace(/^END\s*/i, '')) || 0);
  const next = Math.max(0, ...nums) + 1;
  endIdx = list.length;
  saveEndings([...list, { name: `END ${next}`, done: false }]);
}

/** 结局面板的按键（调用前已确认面板打开） */
export function endingsKey(e: KeyboardEvent): boolean {
  if (e.code === 'Escape' || e.code === 'KeyB' || e.code === 'Backspace') {
    void hideStates();
    e.preventDefault();
    return true;
  }
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    const n = endingsOf().length;
    if (n) {
      endIdx = (endIdx + (e.code === 'ArrowDown' ? 1 : -1) + n) % n;
      renderEndings();
    }
    e.preventDefault();
    return true;
  }
  if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyA') {
    if (endingsOf().length) toggleEnd(endIdx);
    else addEnd();
    e.preventDefault();
    return true;
  }
  if (e.code === 'KeyY') {
    addEnd();
    e.preventDefault();
    return true;
  }
  if (e.code === 'KeyX') {
    deleteEnd(endIdx);
    e.preventDefault();
    return true;
  }
  if (NATIVE_DEFAULT.has(e.code)) e.preventDefault();
  return true;
}

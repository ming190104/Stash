/** 轻量输入弹层（P4 B10 启动参数 / B6 外挂参数 / 重命名 / 备注）：
 *  掌机上没有键盘友好的原生 prompt，这里做一个输入遮罩，接入 overlay.anyState()，
 *  打开期间底层屏幕的快捷键一律不响应（输入框自身由 handleOverlayKey 的 isField 分支兜住）。 */

import { setRawHTML } from './html';

let done: ((v: string | null) => void) | null = null;
/** 多行模式（备注）：Enter 换行，Ctrl+Enter 确认 */
let multiline = false;
/** 打开后的聚焦定时器：弹层被立刻收起时要撤销，避免隐藏输入框继续吞按键 */
let focusTimer = 0;

const SINGLE = `
    <div class="pbox">
      <div class="pt" id="pTitle"></div>
      <div class="psub" id="pSub"></div>
      <textarea class="pin" id="pInput" rows="1" spellcheck="false"></textarea>
      <div class="pbtns"><button class="cta" id="pOk">确定</button><button class="ghost" id="pCancel">取消</button></div>
    </div>`;

function el(): HTMLElement | null {
  return document.getElementById('promptLayer');
}

/** 单输入框按键：Enter 提交（多行模式 Ctrl+Enter），Esc 取消 */
function wireSingle(m: HTMLElement): void {
  m.querySelector('#pInput')?.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.code === 'Enter' || ke.code === 'NumpadEnter') {
      // 多行模式：Enter 换行，Ctrl/⌘+Enter 才提交
      if (multiline && !ke.ctrlKey && !ke.metaKey) return;
      finish(true);
      ke.preventDefault();
    }
  });
  // Esc 在整层兜住：无输入框的确认弹层焦点不在 textarea 上，也要能取消
  m.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.code === 'Escape') {
      finish(false);
      ke.preventDefault();
    }
  });
}

function ensure(): HTMLElement {
  let m = el();
  if (!m) {
    m = document.createElement('div');
    m.id = 'promptLayer';
    m.className = 'state';
    document.getElementById('app')?.appendChild(m);
  }
  if (!m.firstElementChild) {
    setRawHTML(m, SINGLE);
    // 掌机软键盘确认键 / Esc：在输入框层先处理，避免漏到底下的屏幕快捷键
    wireSingle(m);
    m.querySelector('#pOk')?.addEventListener('click', () => finish(true));
    m.querySelector('#pCancel')?.addEventListener('click', () => finish(false));
    // 鼠标习惯：点遮罩空白 = 取消（内容在 .pbox 里，target 是层本身才算点空白）
    m.addEventListener('click', (e) => {
      if (e.target === m) finish(false);
    });
  }
  return m;
}

function finish(ok: boolean): void {
  const l = el();
  clearTimeout(focusTimer);
  l?.classList.remove('show');
  // 层只是 opacity:0（不是 display:none），关闭时若焦点还留在层内输入框，
  // 它仍会继续接管键盘，把 / Q E 数字 F1 这些全局快捷键全部吞掉——必须主动失焦
  const ae = document.activeElement as HTMLElement | null;
  if (ae && l?.contains(ae)) ae.blur();
  const inp = l?.querySelector('#pInput') as HTMLTextAreaElement | null;
  const fn = done;
  done = null;
  fn?.(ok && inp ? inp.value : null);
}

/** 打开输入弹层；确定返回输入串（可能为空串），取消/覆盖返回 null */
export function promptInput(o: {
  title: string;
  sub?: string;
  value?: string;
  cap?: number;
  multiline?: boolean;
  /** 不显示输入框，只保留确定/取消（移除出库等纯确认场景） */
  noInput?: boolean;
}): Promise<string | null> {
  // 重入（手柄长按 / 连点）：先让上一次的 Promise 以 null 结束，避免永久挂起
  if (done) {
    const prev = done;
    done = null;
    prev(null);
  }
  const m = ensure();
  const title = m.querySelector('#pTitle')!;
  const sub = m.querySelector('#pSub') as HTMLElement;
  const inp = m.querySelector('#pInput') as HTMLTextAreaElement;
  const noInput = !!o.noInput;
  title.textContent = o.title;
  sub.textContent = o.sub ?? '';
  sub.style.display = o.sub ? '' : 'none';
  multiline = !!o.multiline;
  inp.style.display = noInput ? 'none' : '';
  inp.rows = multiline ? 6 : 1;
  inp.classList.toggle('multi', multiline);
  inp.value = o.value ?? '';
  inp.maxLength = o.cap ?? 240;
  m.classList.add('show');
  clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => {
    if (!m.classList.contains('show')) return; // 已按 A/B 收起：别让隐藏的输入框偷走焦点
    if (noInput) return; // 纯确认弹层没有输入框：焦点留在层上，由 overlay 接管 A/B
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }, 60);
  return new Promise((res) => {
    done = res;
  });
}

/** 纯确认弹层：点确定 / 按 A 返回 true，取消 / 按 B / Esc 返回 false */
export async function promptConfirm(o: { title: string; sub?: string }): Promise<boolean> {
  return (await promptInput({ ...o, noInput: true })) !== null;
}

export function promptShown(): boolean {
  return el()?.classList.contains('show') ?? false;
}

/** 掌机 A / Enter：确认当前输入 */
export function submitPrompt(): void {
  if (promptShown()) finish(true);
}

/** 外部关闭（打开别的状态层 / 切屏）：Promise 以 null 结束，不会永久挂起 */
export function dismissPrompt(): void {
  if (done) finish(false);
}

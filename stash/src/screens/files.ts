/** 只读文件浏览器：此电脑（盘符）→ 目录，A 进入文件夹 / 把主程序加入库，B 返回。
 *
 *  刻意不做写操作，也不跳外部程序：
 *  - 不新建 / 重命名 / 删除 / 拖拽移动
 *  - 不在资源管理器中定位、不启动 exe，唯一出口是「加入游戏库」
 *  列表由后端 fs_list 提供，前端只负责呈现与键盘、手柄焦点；全盘可浏览（后端只要求绝对路径）。
 */

import { setRawHTML } from '../html';
import {
  addLibraryRoot,
  fsList,
  getSettings,
  importLibraryRoot,
  previewLibraryRoot,
  type FsEntry,
  type FsListing,
} from '../ipc';
import { anyState } from '../layers';
import { registerHandler } from '../nav';
import { promptConfirm, promptInput } from '../prompt';
import { setScreen, state } from '../state';
import type { NavIntent, Screen } from '../types';
import { esc, toast } from '../ui';

let listing: FsListing | null = null;
let focus = 0;
let showHidden = false;
let loading = false;
/** 从哪一屏进来：B 退到根时回到这里（目前入口只有设置 · 库） */
let from: Screen = 'settings';
/** 上次浏览的目录：再次打开直接回到原位，盘符根不存在时自动回退 */
let lastPath: string | null = null;
/** 请求序号：快速连按时只认最后一次，避免旧目录结果覆盖新目录 */
let seq = 0;
let inited = false;

/** 字节数 → 短文本（目录不统计，调用方负责区分） */
export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/** Unix 秒 → YYYY-MM-DD；0 表示取不到时间 */
export function fmtFileTime(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 当前可见行：盘符视图看 drives，目录视图按「隐藏文件」开关过滤 */
function rows(): FsEntry[] {
  if (!listing) return [];
  if (!listing.path) {
    return listing.drives.map((d) => ({
      name: d.name,
      path: d.path,
      isDir: true,
      size: 0,
      modified: 0,
      hidden: false,
    }));
  }
  return showHidden ? listing.entries : listing.entries.filter((e) => !e.hidden);
}

function icon(isDir: boolean): string {
  return isDir
    ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.8 4.2h4l1.4 1.6h6.9v7.4H1.8z"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M3.4 1.8h6l3.2 3.2v9.2H3.4z"/><path d="M9.2 1.8v3.4h3.4"/></svg>';
}

function pathLabel(): string {
  if (!listing) return '正在读取…';
  return listing.path ?? '此电脑';
}

function render(): void {
  const box = document.getElementById('fsList');
  const bar = document.getElementById('fsPath');
  const cnt = document.getElementById('fsCount');
  if (!box || !bar || !cnt) return;

  const list = rows();
  if (focus >= list.length) focus = Math.max(0, list.length - 1);
  setRawHTML(
    bar,
    `<span class="fpath-main">${esc(pathLabel())}</span>
    <span class="fpath-hint">A 进入文件夹 / 入库 · X 入库所选程序 · G 当前目录整目录入库</span>`,
  );
  cnt.textContent = loading ? '读取中…' : `${list.length} 项`;

  if (loading && !list.length) {
    setRawHTML(box, `<div class="fempty">正在读取目录…</div>`);
    return;
  }
  if (!list.length) {
    const msg =
      listing === null
        ? '读取失败，按 R 重试'
        : !listing.path
          ? '没有检测到可用盘符'
          : listing.entries.length
            ? '没有可显示的项目（按 H 显示隐藏文件）'
            : '这个目录是空的';
    setRawHTML(box, `<div class="fempty">${msg}</div>`);
    return;
  }

  const isDriveView = !listing?.path;
  setRawHTML(
    box,
    list
    .map(
      (e, i) => `<div class="frow${i === focus ? ' on' : ''}" data-i="${i}">
        <span class="fic${e.isDir ? ' dir' : ''}">${icon(e.isDir)}</span>
        <span class="fname">${esc(e.name)}</span>
        <span class="fmeta">${e.isDir ? (isDriveView ? '磁盘' : '文件夹') : esc(humanSize(e.size))}</span>
        <span class="ftime">${esc(fmtFileTime(e.modified))}</span>
      </div>`
    )
    .join(''),
  );

  if (listing?.truncated) {
    // 用后端实际返回的条数：隐藏项也占名额，用过滤后的 list.length 会少报
    const note = document.createElement('div');
    note.className = 'fempty';
    note.textContent = `目录过大，只显示前 ${listing.entries.length} 项（含隐藏项）`;
    box.append(note);
  }

  box.querySelector<HTMLElement>('.frow.on')?.scrollIntoView({ block: 'nearest' });
}

async function load(path: string | null): Promise<void> {
  const mine = ++seq;
  loading = true;
  render();
  try {
    const next = await fsList(path);
    if (mine !== seq) return;
    listing = next;
    // 只记目录视图的位置：盘符视图的 path 是 null，一并写入会把刚浏览过的
    // 目录清掉；而退出只能从盘符视图触发，那样「回到上次目录」会永远失效
    if (next.path) lastPath = next.path;
    focus = 0;
  } catch (e) {
    if (mine !== seq) return;
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
    // 目标目录不可用（盘符被拔 / 权限）时退回盘符列表，不让整屏卡在错误上
    if (path) {
      // 记住的位置已失效：清掉，免得下次打开先失败一次
      if (lastPath === path) lastPath = null;
      try {
        const root = await fsList(null);
        if (mine === seq) {
          listing = root;
          focus = 0;
        }
      } catch {
        /* 连盘符都列不出来时保留上一屏内容 */
      }
    }
  } finally {
    if (mine === seq) {
      loading = false;
      render();
    }
  }
}

/** 打开文件浏览器；start 省略时回到上次浏览的目录 */
export async function openFiles(start?: string | null): Promise<void> {
  if (state.screen !== 'files') from = state.screen;
  setScreen('files');
  await load(start === undefined ? lastPath : start);
}

function exit(): void {
  setScreen(from);
}

function current(): FsEntry | null {
  return rows()[focus] ?? null;
}

async function enter(): Promise<void> {
  const e = current();
  if (!e || loading) return;
  if (e.isDir) {
    await load(e.path);
    return;
  }
  // 文件不能在应用内「打开」：只允许加入游戏库，不拉起资源管理器 / exe
  await addToLibrary();
}

/** 把当前目录（或选中的目录）设为库根，扫描后导入新作品。
 *  这是只读浏览屏唯一的写操作，且只经由现有库根命令完成，不直接改文件。 */
async function addDirToLibrary(): Promise<void> {
  if (loading) return;
  // 默认是「当前所在目录」；只有停在盘符列表时才退而用选中的文件夹
  const e = current();
  const dir = listing?.path ?? (e?.isDir ? e.path : null);
  if (!dir) {
    toast('先进入要加入游戏库的目录', true);
    return;
  }
  const ok = await promptConfirm({
    title: '加入游戏库',
    sub: `把 ${dir} 设为库根，扫描并导入新作品（已在库的跳过）`,
  });
  if (!ok) return;
  try {
    const roots = state.settings?.libraryRoots ?? [];
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const known = roots.some((r) => norm(r) === norm(dir));
    const cands = known ? await previewLibraryRoot(dir) : await addLibraryRoot(dir);
    if (!known) {
      // 后端已把新库根写进设置：必须回读，否则下次再对同一目录操作会误走
      // 「已在库根」分支，拿着旧的 roots 去 preview 一个不存在的根直接失败
      state.settings = await getSettings().catch(() => state.settings);
    }
    const picks = cands
      .filter((c) => !c.inLibrary)
      .map((c) => ({ dir: c.dir, exe: c.exe, title: c.title }));
    if (!picks.length) {
      toast('已加入库根，没有发现新作品');
      return;
    }
    const out = await importLibraryRoot(dir, picks);
    const { refreshLibrary } = await import('./library');
    await refreshLibrary();
    toast(`已加入库根，导入 ${out.report.added} 部`);
  } catch (err) {
    toast(`加入库失败：${esc(String((err as { message?: string })?.message ?? err))}`, true);
  }
}

/** 把焦点所在的主程序加入游戏库：标题按文件名 / 目录名推断，可改；
 *  入库成功后回到库屏。目录与普通文件不参与，避免误把 dll / 文本当游戏。 */
async function addToLibrary(): Promise<void> {
  const e = current();
  if (!e || loading) return;
  if (e.isDir || !/\.exe$/i.test(e.name)) {
    toast('请选中游戏主程序（.exe）后按 A / X', true);
    return;
  }
  try {
    // 动态引入设置页的动作模块：它依赖整条设置链路，静态引入会和本屏的入口互相拖拽
    const { addGameByExe, suggestTitle } = await import('./settings/actions');
    const title = await promptInput({
      title: '加入游戏库',
      sub: '标题会固定下来；封面 / 引擎仍按所在目录读取',
      value: suggestTitle(e.path),
      cap: 120,
    });
    if (title === null) return;
    const ok = await addGameByExe(e.path, title);
    if (ok) setScreen('library');
  } catch (err) {
    // chunk 加载失败 / 意外异常不能变成未处理的 rejection：给一条可重试的提示
    const msg = String((err as { message?: string })?.message ?? err);
    toast(`加入游戏库失败：${esc(msg)}`, true);
  }
}

function goParent(): void {
  if (loading) {
    // 网络盘 / 空光驱的读取可能很久：先取消在途请求，避免 B 看起来失灵，
    // 再用已完成的目录继续上跳
    seq++;
    loading = false;
  }
  if (!listing?.path) {
    exit();
    return;
  }
  void load(listing.parent ?? null);
}

/** 只同步焦点样式，不重建列表：
 *  方向键移动时 3000 行不重复拼 HTML；鼠标单击也不会在两次点击之间换掉节点
 *  （否则第二次点击的目标被替换，部分 WebView 会丢掉 dblclick）。 */
function paintFocus(): void {
  const box = document.getElementById('fsList');
  if (!box) return;
  box.querySelectorAll<HTMLElement>('.frow').forEach((row) => {
    row.classList.toggle('on', Number(row.dataset.i) === focus);
  });
  box.querySelector<HTMLElement>('.frow.on')?.scrollIntoView({ block: 'nearest' });
}

function move(delta: number): void {
  const total = rows().length;
  if (!total) return;
  focus = (focus + delta + total) % total;
  paintFocus();
}

function onNav(n: NavIntent): void {
  if (n.intent === 'accept') {
    void enter();
    return;
  }
  if (n.intent === 'back') {
    goParent();
    return;
  }
  if (n.intent !== 'move') return;
  if (n.dir === 'up') move(-1);
  else if (n.dir === 'down') move(1);
  else if (n.dir === 'left') goParent();
  else void enter();
}

/** 绑定输入：nav 统一分发方向 / A / B / Y；H、G、X、R 是这一屏独有的键 */
export function initFiles(): void {
  if (inited) return;
  inited = true;
  // 鼠标用户的返回路径：底栏 B 只是提示，不可点
  document.getElementById('fsBack')?.addEventListener('click', () => exit());
  registerHandler('files', onNav);

  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'files') return;
    // 输入弹层 / 快捷菜单等打开时，底层的 H / Y / R / X 一律不响应（否则会在
    // 标题输入框里打 h 就切隐藏文件）
    if (anyState()) return;
    // 带修饰键的组合留给系统 / WebView（Ctrl+R 重载、Ctrl+H 等），不当成屏内快捷键
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'KeyH') {
      showHidden = !showHidden;
      focus = 0;
      render();
      toast(showHidden ? '显示隐藏文件' : '只显示普通文件');
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyR') {
      // 在别处改动文件后回来，重读当前目录（盘符视图则刷新盘符）
      if (!loading) void load(listing?.path ?? null);
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyX') {
      void addToLibrary();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyG' || e.code === 'KeyY') {
      // 手柄没有 G 键：Y 是「整目录入库」的手柄入口，与 G 完全等价
      void addDirToLibrary();
      e.preventDefault();
    }
  });

  const box = document.getElementById('fsList');
  box?.addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.frow');
    if (!row?.dataset.i) return;
    focus = Number(row.dataset.i);
    paintFocus();
  });
  box?.addEventListener('dblclick', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.frow');
    if (!row) return;
    focus = Number(row.dataset.i);
    void enter();
  });
}

/** 库页签：游戏库目录（扫描预览 → 确认入库）+ 体检报告 + 手动添加。 */
import { state } from '../../state';
import { esc } from '../../ui';

/** 预览里的一条候选：标题可改、可勾选 */
export interface PreviewItem {
  dir: string;
  exe: string;
  title: string;
  engine: string;
  /** 已在库中：置灰、默认不勾选 */
  inLibrary: boolean;
  picked: boolean;
}

export interface PreviewState {
  root: string;
  items: PreviewItem[];
}

/** Steam 库扫描结果里的一条（标题取 Steam 清单名，不可改） */
export interface SteamItem {
  appId: number;
  name: string;
  dir: string;
  exe: string;
  engine: string;
  inLibrary: boolean;
  picked: boolean;
}

// 扫描结果只在当前设置面板内有效：放模块级，面板重渲染后仍能继续勾选 / 导入
let preview: PreviewState | null = null;
let steamPreview: SteamItem[] | null = null;

export function setPreview(p: PreviewState | null): void {
  preview = p;
}

export function getPreview(): PreviewState | null {
  return preview;
}

export function setSteamPreview(items: SteamItem[] | null): void {
  steamPreview = items;
}

export function getSteamPreview(): SteamItem[] | null {
  return steamPreview;
}

/** 目录归一化（与后端 normalize_dir 同口径：统一分隔符 / 去尾斜杠 / 小写） */
function normDir(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function underRoot(dir: string, root: string): boolean {
  const r = normDir(root);
  const d = normDir(dir);
  if (d === r) return true;
  return d.startsWith(r.endsWith('\\') ? r : `${r}\\`);
}

/** 根目录显示名：取最后一段；盘符根（`D:\`）原样显示 */
function labelOf(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.pop() ?? root;
}

function exeName(exe: string): string {
  return exe.split(/[\\/]+/).filter(Boolean).pop() ?? exe;
}

function rootRow(root: string): string {
  const n = state.games.filter((g) => underRoot(g.dir, root)).length;
  return `
    <div class="srow">
      <div class="lab"><b>${esc(labelOf(root))}</b><span>${esc(root)} · 已入库 ${n} 部</span></div>
      <div class="lacts">
        <button class="mini" data-act="scanroot" data-root="${esc(root)}">扫描</button>
        <button class="mini" data-act="delroot" data-root="${esc(root)}">移除</button>
      </div>
    </div>`;
}

/** 候选清单：内联展开，逐条可勾选 / 改标题 */
function previewHTML(): string {
  if (!preview) return '';
  const items = preview.items;
  const picked = items.filter((x) => x.picked).length;
  const rows = items.length
    ? items
        .map(
          (it, i) => `
      <div class="pitem${it.inLibrary ? ' off' : ''}" data-i="${i}">
        <input type="checkbox" class="lcand-cb"${it.picked ? ' checked' : ''}>
        <input class="inp lcand-ti" value="${esc(it.title)}" maxlength="120">
        <span class="lcand-aux">${esc(it.engine || '未知引擎')}${it.inLibrary ? ' · 已在库中' : ''}</span>
        <span class="lcand-aux lcand-dir">${esc(exeName(it.exe))}</span>
      </div>`,
        )
        .join('')
    : `<div class="snote">没有发现可导入的作品。请确认根目录下每个作品文件夹里都有主程序 exe（工具 / 卸载程序已排除）。</div>`;
  return `
    <div class="spanel lprev" data-root="${esc(preview.root)}">
      <div class="srow">
        <div class="lab"><b>扫描结果 · ${items.length} 部</b><span>${esc(preview.root)}｜勾选要入库的作品，标题可直接改，取消勾选则忽略</span></div>
        <div class="lacts">
          <button class="mini" data-act="picksel">全选</button>
          <button class="mini" data-act="pickcancel">取消</button>
          <button class="mini" data-act="pickimport">加入所选（${picked}）</button>
        </div>
      </div>
      <div class="pending lcands">${rows}</div>
    </div>`;
}

/** Steam 候选清单：与库根预览同一套行样式，标题取清单名 */
function steamPreviewHTML(): string {
  if (!steamPreview) return '';
  const items = steamPreview;
  const picked = items.filter((x) => x.picked).length;
  const rows = items.length
    ? items
        .map(
          (it, i) => `
      <div class="pitem${it.inLibrary ? ' off' : ''}" data-si="${i}">
        <input type="checkbox" class="steam-cb"${it.picked ? ' checked' : ''}>
        <span class="pnm">${esc(it.name)}</span>
        <span class="lcand-aux">${esc(it.engine || '未知引擎')}${it.inLibrary ? ' · 已在库中' : ''}</span>
      </div>`,
        )
        .join('')
    : `<div class="snote">没有发现已安装的 Steam 游戏。请确认 Steam 已安装且至少完成下载一部作品。</div>`;
  return `
    <div class="spanel lprev">
      <div class="srow">
        <div class="lab"><b>Steam 扫描结果 · ${items.length} 部</b><span>勾选要入库的作品；已在库中的条目默认不勾选</span></div>
        <div class="lacts">
          <button class="mini" data-act="steamsel">全选</button>
          <button class="mini" data-act="steamcancel">取消</button>
          <button class="mini" data-act="steamimport">加入所选（${picked}）</button>
        </div>
      </div>
      <div class="pending lcands">${rows}</div>
    </div>`;
}

export function libraryTabHTML(healthBlock: string): string {
  const roots = state.settings?.libraryRoots ?? [];
  const rootRows = roots.length
    ? roots.map(rootRow).join('')
    : `<div class="snote">还没有添加游戏库目录。添加后先预览候选，勾选确认才入库；移除目录不会删除已入库的作品。</div>`;
  return `
    <h2 class="sh">库</h2>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>游戏库目录</b><span>从根目录自动发现作品（下一级子目录，含二级兜底）；支持多个目录</span></div>
        <button class="mini" data-act="browse">浏览文件…</button>
        <button class="mini" data-act="addroot">添加游戏库…</button></div>
      ${rootRows}
    </div>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>Steam 库</b><span>读取本机已安装的 Steam 游戏（含多个库目录），勾选后入库；不启动 Steam</span></div>
        <button class="mini" data-act="steamscan">扫描 Steam 库…</button></div>
      ${steamPreviewHTML()}
    </div>
    ${previewHTML()}
    <div class="spanel">
      ${healthBlock}
    </div>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>手动添加</b><span>直接选主程序 exe + 填标题；封面 / 引擎仍按所在目录读取，小体积 / 合集目录也能入库</span></div>
        <button class="mini" data-act="addgame">选择 exe…</button></div>
    </div>`;
}

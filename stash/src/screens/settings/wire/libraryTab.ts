/** 库页签接线：游戏库目录（扫描 → 预览勾选 → 导入）。 */

import {
  addLibraryRoot,
  getSettings,
  importLibraryRoot,
  importSteam,
  listIgnored,
  pickFolder,
  previewLibraryRoot,
  removeLibraryRoot,
  scanSteam,
  unignoreGame,
} from '../../../ipc';
import { state } from '../../../state';
import { esc, toast } from '../../../ui';
import { refreshLibrary } from '../../library';
import { openFiles } from '../../files';
import {
  getPreview,
  getSteamPreview,
  setPreview,
  setSteamPreview,
  type PreviewItem,
} from '../../settings-tabs/library';
import { rerender } from '../ui';

function fail(err: unknown): void {
  toast(esc(String((err as { message?: string })?.message ?? err)), true);
}

/** 扫描 / 入库进行中：挡住连点，避免后端跑两轮 */
let busy = false;

function toItem(c: {
  dir: string;
  exe: string;
  title: string;
  engine: string;
  inLibrary: boolean;
}): PreviewItem {
  return { ...c, picked: !c.inLibrary };
}

function updatePickCount(body: HTMLElement): void {
  const pv = getPreview();
  const btn = body.querySelector<HTMLElement>('[data-act="pickimport"]');
  if (pv && btn) btn.textContent = `加入所选（${pv.items.filter((x) => x.picked).length}）`;
}

/** 扫描一个根目录：新增目录会先落盘配置，再返回候选（都不入库） */
async function scanRoot(root: string, isNew: boolean): Promise<void> {
  if (busy) return;
  busy = true;
  toast(isNew ? '正在扫描游戏库目录…' : '正在重新扫描…');
  try {
    if (isNew) {
      // 后端已写入 libraryRoots：重新拉一次设置，否则后续 persist 会用旧值把它覆盖掉
      const cands = await addLibraryRoot(root);
      state.settings = await getSettings();
      setPreview({ root, items: cands.map(toItem) });
      setSteamPreview(null);
      rerender();
      toast(`扫描完成 · ${cands.length} 部候选，请勾选后加入`);
    } else {
      const cands = await previewLibraryRoot(root);
      setPreview({ root, items: cands.map(toItem) });
      setSteamPreview(null);
      rerender();
      toast(`扫描完成 · ${cands.length} 部候选，请勾选后加入`);
    }
  } catch (e) {
    fail(e);
  } finally {
    busy = false;
  }
}

function updateSteamCount(body: HTMLElement): void {
  const items = getSteamPreview();
  const btn = body.querySelector<HTMLElement>('[data-act="steamimport"]');
  if (items && btn) btn.textContent = `加入所选（${items.filter((x) => x.picked).length}）`;
}

/** 扫描 Steam 库：只读本机清单，不启动 Steam */
async function scanSteamLib(): Promise<void> {
  if (busy) return;
  busy = true;
  toast('正在读取 Steam 库…');
  try {
    const cands = await scanSteam();
    setPreview(null);
    setSteamPreview(cands.map((c) => ({ ...c, picked: !c.inLibrary })));
    rerender();
    toast(
      cands.length
        ? `Steam 扫描完成 · ${cands.length} 部，请勾选后加入`
        : '未在本机找到已安装的 Steam 游戏（需要完成下载后才会出现在清单里）'
    );
  } catch (e) {
    fail(e);
  } finally {
    busy = false;
  }
}

async function importSteamPicked(): Promise<void> {
  const items = getSteamPreview();
  if (!items || busy) return;
  const ids = items.filter((x) => x.picked).map((x) => x.appId);
  if (!ids.length) {
    toast('还没有勾选任何作品', true);
    return;
  }
  busy = true;
  toast(`正在导入 ${ids.length} 部 Steam 游戏…`);
  try {
    const out = await importSteam(ids);
    await refreshLibrary();
    setSteamPreview(null);
    rerender();
    const r = out.report;
    toast(`已入库：新增 ${r.added} 部${r.updated ? ` · 更新 ${r.updated} 部` : ''}`);
  } catch (e) {
    fail(e);
  } finally {
    busy = false;
  }
}

async function importPicked(): Promise<void> {
  const pv = getPreview();
  if (!pv || busy) return;
  const picks = pv.items
    .filter((x) => x.picked)
    .map((x) => ({ dir: x.dir, exe: x.exe, title: x.title.trim() }));
  if (!picks.length) {
    toast('还没有勾选任何作品', true);
    return;
  }
  busy = true;
  toast(`正在导入 ${picks.length} 部作品…`);
  try {
    const out = await importLibraryRoot(pv.root, picks);
    await refreshLibrary();
    setPreview(null);
    rerender();
    const r = out.report;
    toast(`已入库：新增 ${r.added} 部${r.updated ? ` · 更新 ${r.updated} 部` : ''}`);
  } catch (e) {
    fail(e);
  } finally {
    busy = false;
  }
}

async function removeRoot(root: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await removeLibraryRoot(root);
    if (state.settings) {
      state.settings.libraryRoots = (state.settings.libraryRoots ?? []).filter((r) => r !== root);
    }
    setPreview(null);
    rerender();
    toast('已移除目录配置，已入库作品仍保留');
  } catch (e) {
    fail(e);
  } finally {
    busy = false;
  }
}

export function wireLibraryTab(body: HTMLElement): void {
  // 只读文件浏览：找游戏目录时不必离开应用（B 返回设置页）
  body.querySelectorAll<HTMLElement>('[data-act="browse"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // 不传路径 = 回到上次浏览的目录；首次打开自然落到盘符列表
      void openFiles();
    });
  });

  // 游戏库目录
  body.querySelectorAll<HTMLElement>('[data-act="addroot"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void (async () => {
        const p = await pickFolder();
        if (p) await scanRoot(p, true);
      })();
    });
  });

  body.querySelectorAll<HTMLElement>('[data-act="scanroot"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const root = btn.dataset.root;
      if (root) void scanRoot(root, false);
    });
  });

  body.querySelectorAll<HTMLElement>('[data-act="delroot"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const root = btn.dataset.root;
      if (root) void removeRoot(root);
    });
  });

  // 忽略列表：恢复后重扫会重新列出（仍需勾选确认，不会自动回库）
  body.querySelectorAll<HTMLElement>('[data-unignore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exe = btn.dataset.unignore;
      if (!exe || busy) return;
      busy = true;
      void (async () => {
        try {
          await unignoreGame(exe);
          // 以后端为准：同一条目可能因盘符大小写 / 分隔符写过多次，本地只按字符串比对会漏
          try {
            state.ignored = await listIgnored();
          } catch {
            state.ignored = (state.ignored ?? []).filter((x) => x.exe !== exe);
          }
          rerender();
          toast('已恢复，下次扫描会重新列出');
        } catch (e) {
          fail(e);
        } finally {
          busy = false;
        }
      })();
    });
  });

  body.querySelector<HTMLElement>('[data-act="steamscan"]')?.addEventListener('click', () => {
    void scanSteamLib();
  });

  if (getSteamPreview()) {
    body.querySelectorAll<HTMLInputElement>('.steam-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const items = getSteamPreview();
        const row = cb.closest<HTMLElement>('.pitem');
        if (!items || row?.dataset.si === undefined) return;
        const it = items[Number(row.dataset.si)];
        if (it) it.picked = cb.checked;
        updateSteamCount(body);
      });
    });

    body.querySelector<HTMLElement>('[data-act="steamsel"]')?.addEventListener('click', () => {
      const items = getSteamPreview();
      if (!items) return;
      const all = items.length > 0 && items.every((x) => x.picked);
      items.forEach((x) => {
        x.picked = !all;
      });
      body.querySelectorAll<HTMLInputElement>('.steam-cb').forEach((cb) => {
        cb.checked = !all;
      });
      updateSteamCount(body);
    });

    body.querySelector<HTMLElement>('[data-act="steamcancel"]')?.addEventListener('click', () => {
      setSteamPreview(null);
      rerender();
    });

    body.querySelector<HTMLElement>('[data-act="steamimport"]')?.addEventListener('click', () => {
      void importSteamPicked();
    });
  }

  if (!getPreview()) return;

  // 候选勾选：只改预览数据与计数，不整块重渲染（否则正在编辑的标题会丢焦点）
  body.querySelectorAll<HTMLInputElement>('.lcand-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const pv = getPreview();
      const row = cb.closest<HTMLElement>('.pitem');
      if (!pv || !row?.dataset.i) return;
      const it = pv.items[Number(row.dataset.i)];
      if (it) it.picked = cb.checked;
      updatePickCount(body);
    });
  });

  body.querySelectorAll<HTMLInputElement>('.lcand-ti').forEach((inp) => {
    inp.addEventListener('change', () => {
      const pv = getPreview();
      const row = inp.closest<HTMLElement>('.pitem');
      if (!pv || !row?.dataset.i) return;
      const it = pv.items[Number(row.dataset.i)];
      if (it) it.title = inp.value;
    });
  });

  body.querySelector<HTMLElement>('[data-act="picksel"]')?.addEventListener('click', () => {
    const pv = getPreview();
    if (!pv) return;
    const all = pv.items.length > 0 && pv.items.every((x) => x.picked);
    pv.items.forEach((x) => {
      x.picked = !all;
    });
    body.querySelectorAll<HTMLInputElement>('.lcand-cb').forEach((cb) => {
      cb.checked = !all;
    });
    updatePickCount(body);
  });

  body.querySelector<HTMLElement>('[data-act="pickcancel"]')?.addEventListener('click', () => {
    setPreview(null);
    rerender();
  });

  body.querySelector<HTMLElement>('[data-act="pickimport"]')?.addEventListener('click', () => {
    void importPicked();
  });
}

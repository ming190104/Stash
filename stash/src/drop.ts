/** 拖拽入库：把主程序 exe 直接拖进窗口即可添加。
 *  标题按文件 / 目录名推断（与手动添加同一套规则），重复目录自动打开库里那部。 */

import { TAURI } from './ipc';
import { toast } from './ui';
import { addGameByExe, suggestTitle } from './screens/settings/actions';

/** 只认 .exe（大小写不敏感）：拖文件夹 / 快捷方式 / 压缩包一律跳过并给出提示 */
export function isGameExe(path: string): boolean {
  return /\.exe$/i.test(path.trim());
}

/** 一次拖入多个文件时去重（Windows 路径大小写不敏感），并过滤掉非 exe */
export function uniqueExePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const p = raw.trim();
    if (!isGameExe(p)) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** 在途标记：连续 drop 时后一次直接放弃，避免两轮串写库互相覆盖 */
let importing = false;

/** 处理一次 drop：逐个入库（串行，避免并发写库），返回成功添加的部数。
 *  失败项由 addGameByExe 自己提示，这里只补一句「跳过了几个非 exe」。 */
export async function importDropped(paths: string[]): Promise<number> {
  if (importing) {
    toast('已有拖拽入库在进行中');
    return 0;
  }
  importing = true;
  try {
    const exes = uniqueExePaths(paths);
    if (!exes.length) {
      toast(paths.length ? '拖入的内容里没有 .exe 主程序，已忽略' : '没有可入库的文件');
      return 0;
    }
    let added = 0;
    for (const exe of exes) {
      if (await addGameByExe(exe, suggestTitle(exe))) added += 1;
    }
    const skipped = paths.filter((p) => !isGameExe(p)).length;
    if (skipped > 0) toast(`已跳过 ${skipped} 个非 exe 文件`);
    return added;
  } finally {
    importing = false;
  }
}

let inited = false;
let hinted = false;

/** 订阅 WebView 拖拽事件（只在 Tauri 运行时生效；浏览器预览静默跳过）。
 *  enter 时给一次提示，drop 后复位，避免拖拽悬停期间反复刷 toast。 */
export async function initDropImport(): Promise<void> {
  if (inited || !TAURI) return;
  inited = true;
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload as { type: string; paths?: string[] };
      if (p.type === 'enter' || p.type === 'over') {
        if (!hinted) {
          hinted = true;
          toast('松开即可入库 · 仅支持 .exe 主程序');
        }
        return;
      }
      if (p.type !== 'drop') {
        hinted = false;
        return;
      }
      hinted = false;
      void importDropped(p.paths ?? []).catch((e) =>
        toast(`拖拽入库失败：${String((e as { message?: string })?.message ?? e)}`, true)
      );
    });
  } catch (e) {
    inited = false;
    throw e;
  }
}

/** 仅供测试：复位订阅 / 提示状态（生产代码不在运行中调用） */
export function resetDropState(): void {
  inited = false;
  hinted = false;
}

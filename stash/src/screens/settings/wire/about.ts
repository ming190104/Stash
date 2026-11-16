/** 关于页签接线：最近问题日志 + 检查更新 + 快捷键总览入口。 */

import { TAURI, checkUpdate, openExternal, recentLogIssues, runningGame } from '../../../ipc';
import { esc } from '../../../ui';
import { setRawHTML } from '../../../html';
import { openHelp } from '../../../overlay';
import type { Update } from '@tauri-apps/plugin-updater';

/** 关于页 · 最近的问题：只读日志尾部的 WARN/ERROR；没有记录也要明说，而不是留一句「加载中」 */
export async function loadLogIssues(): Promise<void> {
  const box = document.getElementById('logBox');
  if (!box) return;
  // 读日志期间面板可能被重建（换页签 / 方向键 / 落盘失败）：写入前重新取当前节点，
  // 拿不到就丢弃——否则结果写进游离 DOM，界面永远停在「加载中」
  const live = (): HTMLElement | null => {
    const el = document.getElementById('logBox');
    return el && el.isConnected ? el : null;
  };
  const empty = (msg: string): void => {
    const el = live();
    if (el)
      setRawHTML(
        el,
        `<div class="srow"><div class="lab"><b>最近的问题</b><span>${esc(msg)}</span></div></div>`,
      );
  };
  if (!TAURI) {
    empty('浏览器预览模式不读日志');
    return;
  }
  try {
    const list = await recentLogIssues(6);
    if (!list.length) {
      empty('最近 7 天没有记录到 WARN / ERROR');
      return;
    }
    const el = live();
    if (!el) return;
    setRawHTML(
      el,
      `<div class="srow"><div class="lab"><b>最近的问题</b><span>最新 ${list.length} 条 · 完整内容见日志目录</span></div></div>` +
      list
        .map((i) => {
          const time = i.time.replace('T', ' ').replace(/\..*$/, '');
          return `<div class="srow logrow"><div class="lab"><b class="lvl${
            i.level === 'ERROR' ? ' bad' : ''
          }">${esc(i.level)}</b><span>${esc(time)}</span></div><span class="logtxt" title="${esc(
            i.text,
          )}">${esc(i.text)}</span></div>`;
        })
        .join(''),
    );
  } catch (e) {
    empty(String((e as { message?: string })?.message ?? e));
  }
}

/** 已查到的新版本：按钮第二次点击才开始下载安装 */
let pending: Update | null = null;
/** 检查失败的兜底：按钮变成打开 Releases 页 */
let fallbackUrl: string | null = null;
/** 下载 / 安装期间禁止重复触发 */
let busy = false;

/** 更新失败时的手动下载页 */
const RELEASES = 'https://github.com/zhao1171921108-cyber/Stash/releases';

function setTip(t: string): void {
  // 请求期间面板可能被重建（换页签 / 重渲染）：每次写入都重新取节点，拿不到就丢弃
  const el = document.getElementById('updTip');
  if (el) el.textContent = t;
}

function setBtn(t: string): void {
  const el = document.getElementById('updBtn');
  if (el) el.textContent = t;
}

function mb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 有游戏在跑就别装：安装会直接结束 Stash，游玩记录（唯一不可再生数据）来不及落盘 */
async function runningTitle(): Promise<string | null> {
  try {
    const g = await runningGame();
    return g ? g.title : null;
  } catch {
    // 查询失败不拦更新：别把正常升级也堵死
    return null;
  }
}

/** 下载（带进度）→ 再确认一次没游戏在跑 → 安装并重启 */
async function doInstall(u: Update): Promise<void> {
  const running = await runningTitle();
  if (running) {
    setTip(`《${running}》正在运行：先退出游戏再更新`);
    setBtn('重试');
    return;
  }
  busy = true;
  setBtn('更新中…');
  try {
    let total = 0;
    let got = 0;
    await u.download((ev) => {
      if (ev.event === 'Started') {
        total = ev.data.contentLength ?? 0;
      } else if (ev.event === 'Progress') {
        got += ev.data.chunkLength;
        const p = total > 0 ? Math.min(99, Math.floor((got / total) * 100)) : 0;
        setTip(total > 0 ? `正在下载更新 ${p}%（${mb(got)} / ${mb(total)}）` : `已下载 ${mb(got)}`);
      }
    });
    // 下载期间用户可能又开了游戏：install 会直接结束进程，必须再确认一次
    const again = await runningTitle();
    if (again) {
      await u.close();
      pending = null;
      setTip(`《${again}》正在运行：更新包已下载，退出游戏后再点更新`);
      setBtn('重试');
      return;
    }
    setTip('正在安装，完成后自动重启…');
    setBtn('安装中…');
    await u.install();
    // Windows 下 install 会退出进程、由安装器重新拉起；这一行只给其他平台兜底
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    pending = null;
    // 失败也要释放 Rust 侧句柄，否则下次检查会再占一份下载缓冲
    void u.close();
    setTip(`更新失败：${String((e as { message?: string })?.message ?? e)}`);
    setBtn('重试');
  } finally {
    busy = false;
  }
}

async function runUpdateCheck(): Promise<void> {
  if (busy) return;
  if (pending) {
    await doInstall(pending);
    return;
  }
  if (fallbackUrl) {
    await openExternal(fallbackUrl).catch((e) => console.warn('[update] 打开下载页失败', e));
    return;
  }
  if (!TAURI) {
    setTip('浏览器预览不检查更新');
    return;
  }
  setTip('正在检查…');
  setBtn('…');
  try {
    const u = await checkUpdate();
    if (u) {
      pending = u;
      setTip(`发现新版本 ${u.version}（当前 ${u.currentVersion}），点击更新会自动安装并重启`);
      setBtn('更新');
    } else {
      setTip('已是最新版本');
      setBtn('检查');
    }
  } catch (e) {
    // 国内网络常被拦、仓库也可能还没发 Release：留一个手动下载出口
    fallbackUrl = RELEASES;
    setTip(`${String((e as { message?: string })?.message ?? e)}（可到 Releases 手动下载）`);
    setBtn('下载页');
  }
}

export function wireAbout(body: HTMLElement): void {
  // 关于 · 快捷键总览：手柄不再直接呼出，统一从设置里打开
  body.querySelector('#openHelpBtn')?.addEventListener('click', () => openHelp());
  // 面板每次打开都是新节点：上一轮查到的版本句柄 / 兜底地址都不再对应当前界面
  if (pending) void pending.close();
  pending = null;
  fallbackUrl = null;
  busy = false;
  body.querySelector('#updBtn')?.addEventListener('click', () => void runUpdateCheck());
}

/** 关于页签接线：最近问题日志 + 检查更新 + 快捷键总览入口。 */

import { TAURI, checkUpdate, openExternal, recentLogIssues } from '../../../ipc';
import { esc } from '../../../ui';
import { setRawHTML } from '../../../html';
import { openHelp } from '../../../overlay';

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

/** 已查到的下载页：查到新版后按钮变成「下载」，再点才跳浏览器（不替用户直接开） */
let updateUrl: string | null = null;

async function runUpdateCheck(): Promise<void> {
  if (updateUrl) {
    await openExternal(updateUrl).catch((e) => console.warn('[update] 打开下载页失败', e));
    return;
  }
  // 请求期间面板可能被重建（换页签 / 重渲染）：每次写入都重新取节点，拿不到就丢弃
  const setTip = (t: string): void => {
    const el = document.getElementById('updTip');
    if (el) el.textContent = t;
  };
  const setBtn = (t: string): void => {
    const el = document.getElementById('updBtn');
    if (el) el.textContent = t;
  };
  if (!TAURI) {
    setTip('浏览器预览不检查更新');
    return;
  }
  setTip('正在检查…');
  setBtn('…');
  try {
    const r = await checkUpdate();
    if (r.newer) {
      updateUrl = r.url;
      setTip(`发现新版本 ${r.latest}（当前 ${r.current}）`);
      setBtn('下载');
    } else {
      setTip(`已是最新版本 ${r.current}`);
      setBtn('检查');
    }
  } catch (e) {
    setTip(String((e as { message?: string })?.message ?? e));
    setBtn('重试');
  }
}

export function wireAbout(body: HTMLElement): void {
  // 关于 · 快捷键总览：手柄不再直接呼出，统一从设置里打开
  body.querySelector('#openHelpBtn')?.addEventListener('click', () => openHelp());
  // 面板每次打开都是新节点：上一轮查到的下载页不再对应当前界面
  updateUrl = null;
  body.querySelector('#updBtn')?.addEventListener('click', () => void runUpdateCheck());
}

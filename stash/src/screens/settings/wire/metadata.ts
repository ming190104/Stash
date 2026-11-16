/** 元数据页签接线：隐藏作品 / 候选改绑（模态层在 candpanel.ts）。 */

import { state, gameById } from '../../../state';
import { toast, esc } from '../../../ui';
import { setRawHTML } from '../../../html';
import { getLibrary, setHidden } from '../../../ipc';
import { renderRail } from '../../library';
import { renderGrid } from '../../grid';
import { rerender, sui } from '../ui';
import { matchedRowsHTML } from '../../settings-tabs/metadata';
import { hydrateArts } from '../../art';
import { openCandPanel } from '../../../candpanel';

/** 改绑 / 校正 / 选择条目：模态候选墙里完成绑定，回来后统一刷新库与设置面板。
 *  面板自己处理检索中 / 失败 / 空候选，调用方只认「最后选了哪一项」。 */
export async function showCandidates(id: string, queue?: { id: string; title: string }[]): Promise<void> {
  const g = gameById(id);
  const r = await openCandPanel(id, g?.title ?? '', queue);
  if (!r) return;
  try {
    state.games = await getLibrary();
    renderRail();
    renderGrid();
    rerender();
    toast(r === 'unmatch' ? '已取消匹配' : queue ? '队列确认完成' : '已应用所选元数据');
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

export function wireMetadataTab(body: HTMLElement): void {
  // 数据源不可达时的一键跳转：直接切到「网络」页签配代理
  body.querySelectorAll<HTMLElement>('[data-gonet]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sui.tab = 4;
      rerender();
    });
  });
  // 待确认队列：点「校正…」拉候选列表
  body.querySelectorAll('[data-bind]').forEach((btn) => {
    btn.addEventListener('click', () => showCandidates((btn as HTMLElement).dataset.bind!));
  });
  // 连续确认：把整条队列交给候选面板，应用成功后自动检索下一部
  body.querySelectorAll<HTMLElement>('[data-bindqueue]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.bindqueue;
      const list =
        kind === 'pending'
          ? state.games.filter((g) => g.pending)
          : state.games.filter((g) => !g.matched && !g.hidden);
      if (!list.length) return;
      void showCandidates(
        list[0].id,
        list.map((g) => ({ id: g.id, title: g.title })),
      );
    });
  });
  // 已匹配作品：筛选框只重绘列表；「改绑…」用事件委托，重绘后不需要重新绑定
  const mf = body.querySelector<HTMLInputElement>('#matchedFilter');
  const mlist = body.querySelector<HTMLElement>('#matchedList');
  // 列表里带封面缩略图：初次渲染与筛选重绘后都要补一次异步资源
  if (mlist) hydrateArts(mlist);
  mf?.addEventListener('input', () => {
    // 筛选词存进 sui：后台 rerender() 重建面板后（匹配完成 / 换封面）
    // 只读 DOM 的写法会把用户的筛选词丢掉
    sui.matchedFilter = mf.value;
    if (mlist) {
      setRawHTML(mlist, matchedRowsHTML(mf.value));
      hydrateArts(mlist);
    }
  });
  mlist?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-rebind]');
    if (btn) void showCandidates(btn.dataset.rebind!);
  });
  // H1 · 恢复隐藏作品
  body.querySelectorAll<HTMLElement>('[data-unhide]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.unhide!;
      try {
        await setHidden(id, false);
        state.games = await getLibrary();
        renderRail();
        renderGrid();
        rerender();
        toast('已恢复');
      } catch (e) {
        toast(esc(String((e as { message?: string })?.message ?? e)), true);
      }
    });
  });
}

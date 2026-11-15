/** 空态两种变体（P0）：库为空 / 筛选无结果。
 *  空态主按钮要能被掌机的 A 键触发；发布构建不显示演示库入口。 */

import { state, clearFacets } from './state';
import { esc, toast } from './ui';
import { setRawHTML } from './html';
import { hideStates, showState } from './layers';
import { openSearch } from './search';

const FILTER_LAB: Record<string, string> = { all: '全部', playing: '进行中', done: '已通关', new: '未开始', fav: '★ 收藏' };

/** 当前筛选条件的中文描述（状态 + 分面），用于无结果空态说明到底卡在哪一层 */
export function filterDesc(): string {
  const parts = [FILTER_LAB[state.gridFilter] ?? '全部'];
  if (state.tagFilter) parts.push(`标签「${state.tagFilter}」`);
  if (state.devFilter) parts.push(`会社「${state.devFilter}」`);
  if (state.yearFilter !== null) parts.push(`${state.yearFilter} 年`);
  return parts.join(' · ');
}

export function showEmpty(kind: 'empty' | 'noresult'): void {
  const b = document.getElementById('emptyBody');
  if (!b) return;
  if (kind === 'noresult') {
    setRawHTML(
      b,
      `
      <div class="state-mark"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg></div>
      <div class="state-title">没有符合条件的作品</div>
      <div class="state-sub">当前筛选「${esc(filterDesc())}」没有匹配到任何作品。换个条件，或清除筛选看看全部。</div>
      <div class="state-btns"><button class="cta" id="emClear">清除筛选</button><button class="ghost" id="emSearch">搜索作品…</button></div>`,
    );
    b.querySelector('#emClear')?.addEventListener('click', () => {
      hideStates();
      clearFacets();
      void import('./screens/grid').then((m) => {
        m.setFilter('all');
        toast('已清除筛选');
      });
    });
    b.querySelector('#emSearch')?.addEventListener('click', openSearch);
  } else {
    setRawHTML(
      b,
      `
      <div class="state-mark">遊</div>
      <div class="state-title">还没有任何作品</div>
      <div class="state-sub">选一个游戏主程序 exe，填上标题就能入库；封面 / 引擎按所在目录读取。</div>
      <div class="state-btns"><button class="cta" id="emAdd"><span class="k">A</span>添加游戏 exe…</button></div>`,
    );
    // 入口会先弹系统对话框 / 走 IPC：失败必须有提示，不能变成未捕获拒绝
    const failed = (e: unknown): void =>
      toast(esc(String((e as { message?: string })?.message ?? e)), true);
    b.querySelector('#emAdd')?.addEventListener('click', () => {
      import('./screens/settings').then((m) => m.addManualGame()).catch(failed);
    });
  }
  showState('emptyState');
}

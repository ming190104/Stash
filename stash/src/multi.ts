/**
 * 多选：网格 / 列表 / 海报墙共用一套选中集与批量操作。
 *
 * 三套布局的可见下标口径不同，选中一律按 `game.id` 记，DOM 用 `data-id` 对位，
 * 因此切换布局或筛选后勾选不丢。批量完成后的库刷新走 library 注册的回调，
 * 避免 multi ↔ library 互相 import 形成循环依赖。
 */

import { state } from './state';
import { toast } from './ui';
import { openMenu, type MenuItem } from './quick';
import { promptConfirm, promptInput } from './prompt';
import { removeGame, setFavorite, setHidden, setUserTags } from './ipc';

/** 库刷新钩子：由 library 初始化时注册（批量改完要让三套布局都重建） */
let refreshHook: () => Promise<void> = async () => {};

export function setMultiRefresh(fn: () => Promise<void>): void {
  refreshHook = fn;
}

/** 勾选标记与计数只局部刷新，不整块重建（重建会丢掉封面 hydrate 状态） */
export function markSel(): void {
  document.querySelectorAll<HTMLElement>('.gcell, .lrow, .wall-cell').forEach((el) => {
    const id = el.dataset.id;
    el.classList.toggle('sel', !!id && state.gridSel.has(id));
  });
  // 网格与库屏各有一条操作条，计数同步；不在当前屏的那条不可见，但值保持最新
  for (const id of ['gselN', 'lselN']) {
    const n = document.getElementById(id);
    if (n) n.textContent = `已选 ${state.gridSel.size} 部`;
  }
}

export function toggleSel(id: string): void {
  if (!state.gridSel.delete(id)) state.gridSel.add(id);
  markSel();
}

/** 进入 / 退出多选：广播给当前屏自行重建（grid 与 library 各自监听） */
export function setMulti(on: boolean): void {
  if (state.gridMulti === on) return;
  state.gridMulti = on;
  state.gridSel.clear();
  window.dispatchEvent(new Event('multi-change'));
  toast(on ? '多选 · A 勾选 · X 批量操作' : '已退出多选');
}

/** 逐部执行并统计失败数：一部失败不能让整批停在半路。
 *  旧实现直接 `for … await`，第 2 部失败时剩下的 3 部不会执行，`finishBatch` 也不跑——
 *  结果是「选中的 5 部只处理了 1 部、选中集还留着、只有一条后端原始报错」，用户无从判断到底改了哪些。 */
async function eachGame(ids: string[], op: (id: string) => Promise<void>): Promise<number> {
  let failed = 0;
  for (const id of ids) {
    try {
      await op(id);
    } catch (e) {
      failed += 1;
      console.warn('[multi] 批量操作单项失败', id, e);
    }
  }
  return failed;
}

async function finishBatch(msg: string, failed = 0): Promise<void> {
  const n = state.gridSel.size;
  state.gridSel.clear();
  state.gridMulti = false;
  window.dispatchEvent(new Event('multi-change'));
  await refreshHook();
  toast(failed ? `${msg} · ${n - failed} 部成功 · ${failed} 部失败` : `${msg} · ${n} 部`, failed > 0);
}

/** 批量操作菜单：多选态下点击「批量操作…」或按 X 打开 */
export async function openBatch(): Promise<void> {
  const ids = [...state.gridSel];
  if (!ids.length) {
    toast('先勾选要处理的条目', true);
    return;
  }
  const games = ids
    .map((id) => state.games.find((g) => g.id === id))
    .filter((g): g is NonNullable<typeof g> => !!g);
  const addFav = games.some((g) => !g.favorite);
  const show = games.some((g) => !g.hidden);
  const list: MenuItem[] = [
    {
      key: 'fav',
      label: addFav ? `收藏 ${ids.length} 部` : `取消收藏 ${ids.length} 部`,
      run: async () => {
        const failed = await eachGame(ids, (id) => setFavorite(id, addFav));
        await finishBatch(addFav ? '已收藏' : '已取消收藏', failed);
      },
    },
    {
      key: 'hide',
      label: show ? `隐藏 ${ids.length} 部` : `取消隐藏 ${ids.length} 部`,
      run: async () => {
        const failed = await eachGame(ids, (id) => setHidden(id, show));
        await finishBatch(show ? '已隐藏' : '已取消隐藏', failed);
      },
    },
    {
      key: 'tag',
      label: '添加标签…',
      hint: `追加到 ${ids.length} 部`,
      run: async () => {
        const v = await promptInput({
          title: '批量添加标签',
          sub: `会追加到已选的 ${ids.length} 部作品，已存在的标签跳过`,
          cap: 20,
        });
        const tag = v?.trim();
        if (!tag) return;
        const failed = await eachGame(ids, async (id) => {
          // 用当前内存里的条目：菜单打开后库可能被后台刷新替换过，闭包里那份已过期
          const tags = state.games.find((g) => g.id === id)?.userTags ?? [];
          if (tags.includes(tag)) return;
          await setUserTags(id, [...tags, tag]);
        });
        await finishBatch('已添加标签', failed);
      },
    },
    {
      key: 'remove',
      label: `从库中移除 ${ids.length} 部…`,
      run: async () => {
        const ok = await promptConfirm({
          title: '批量移除出库',
          sub: '只移除索引，不删除游戏文件',
        });
        if (!ok) return;
        const failed = await eachGame(ids, (id) => removeGame(id));
        await finishBatch('已移除', failed);
      },
    },
    { key: 'close', label: '关闭', hint: 'B', run: () => {} },
  ];
  await openMenu('批量操作', `${ids.length} 部作品`, list);
}

/** 元数据页签：匹配进度 / 已匹配作品 / 待确认队列 / 未匹配队列 / 封面缓存 / 手动添加 / 隐藏作品 / 导入导出。 */
import { state } from '../../state';
import { esc } from '../../ui';
import type { SourceProbe, SourceState, SourceStatus } from '../../ipc';

/** 已匹配作品列表一次最多渲染这么多行，其余靠筛选缩小范围（避免几百部时整页被撑爆） */
const MATCHED_SHOW = 20;

/** 最近一次「测试数据源」的结果：只活在本次会话里，重进设置页仍保留 */
let probe: SourceProbe | null = null;

/** 探测完成后写入结果；传 null 清空 */
export function setSourceProbe(p: SourceProbe | null): void {
  probe = p;
}

const STATE_LAB: Record<SourceState, string> = {
  ok: '可达',
  offline: '不可达',
  limited: '限流',
  error: '异常',
  disabled: '未开启',
  skipped: '未检测',
};

function sourceRow(name: string, st: SourceStatus): string {
  // 长句放 title：面板行高有限，直接铺开会把「测试」按钮挤出可视区
  return `<div class="pitem"><span class="pnm" title="${esc(st.message)}">${name}</span><span class="psc">${STATE_LAB[st.status] ?? esc(st.status)}</span></div>`;
}

/** 数据源状态块：未探测时只给一句提示，探测后逐源列状态 + 当前代理 */
function probeRowsHTML(): string {
  if (!probe) return `<div class="pitem dimtxt">尚未检测 · 点「测试」或开始匹配时自动预检</div>`;
  const rows = [
    sourceRow('Bangumi', probe.bangumi),
    sourceRow('萌娘百科', probe.moegirl),
    sourceRow('EGS', probe.egs),
    sourceRow('鲲 Galgame', probe.kungal),
  ].join('');
  const proxy = probe.proxy ? `系统代理 · ${esc(probe.proxy)}` : '直连（未启用系统代理）';
  const goto = probe.usable ? '' : `<span class="mini" data-gonet>去网络设置…</span>`;
  const msg = probe.message
    ? `<div class="pitem dimtxt"><span class="pnm" title="${esc(probe.message)}">${esc(probe.message)}</span></div>`
    : '';
  return `<div class="pending">${rows}
    <div class="pitem"><span class="pnm">${proxy}</span>${goto}</div>
    ${msg}</div>`;
}

/** 已匹配作品的行 HTML：按标题/原名做大小写不敏感筛选 */
export function matchedRowsHTML(q: string): string {
  const kw = q.trim().toLowerCase();
  const all = state.games.filter(
    (g) => g.matched && !g.hidden && (!kw || `${g.title} ${g.titleOriginal ?? ''}`.toLowerCase().includes(kw)),
  );
  if (!all.length) return `<div class="pitem dimtxt">没有符合条件的作品</div>`;
  const rows = all
    .slice(0, MATCHED_SHOW)
    .map(
      (g) =>
        `<div class="pitem"><span class="pnm">${esc(g.title)}</span><span class="psc">${g.bangumiId ?? g.kungalId ?? '—'}</span><button class="mini" data-rebind="${esc(g.id)}">改绑…</button></div>`,
    )
    .join('');
  const more = all.length > MATCHED_SHOW ? `<div class="pitem dimtxt">还有 ${all.length - MATCHED_SHOW} 部 · 输入关键字缩小范围</div>` : '';
  return rows + more;
}

export function metadataHTML(): string {
  const matched = state.games.filter((g) => g.matched).length;
  // 隐藏作品不在列表里出现，计数也用同一口径，避免「显示 3 部却一行都没有」
  const matchedVisible = state.games.filter((g) => g.matched && !g.hidden).length;
  const pending = state.games.filter((g) => g.pending);
  // 没到阈值的作品也要列出来：自动匹配够不着时，用户还能从搜索结果里手动挑
  const unmatched = state.games.filter((g) => !g.matched && !g.hidden);
  const hidden = state.games.filter((g) => g.hidden);
  return `
    <h2 class="sh">元数据</h2>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>本地元数据</b><span>meta.json · 原名 / 厂商 / 年份 / 标签 / 简介</span></div>
        <div class="stat"><b>${matched}</b><span>/ ${state.games.length} 已匹配</span></div></div>
      <div class="srow"><div class="lab"><b>Bangumi 匹配</b><span>≥80 自动入库 · 50–80 待确认 · &lt;50 手动绑定；可随时取消</span></div>
        <span class="mini" data-act="match">开始匹配</span><span class="mini" data-act="cancelmatch">取消</span></div>
      <div class="srow"><div class="lab"><b>数据源可达性</b><span>Bangumi 需代理 · 不可达的主源匹配时自动跳过 · 匹配前会自动预检</span></div>
        <span class="mini" data-act="probe">测试</span></div>
      ${probeRowsHTML()}
      <div class="srow"><div class="lab"><b>已匹配作品</b><span>自动匹配认错条目时，在这里改绑或取消匹配</span></div>
        <div class="stat"><b>${matchedVisible}</b><span>部可改绑</span></div></div>
      ${
        matchedVisible
          ? `<div class="srow"><div class="lab"><b>筛选</b><span>按中文名 / 日文原名缩小范围</span></div>
              <input class="inp" id="matchedFilter" placeholder="筛选已匹配作品…" autocomplete="off"></div>
            <div class="pending" id="matchedList">${matchedRowsHTML('')}</div>`
          : ''
      }
      <div class="srow"><div class="lab"><b>待确认队列</b><span>${pending.length ? '分数介于 50–80，建议人工过一眼' : '暂无待确认作品'}</span></div>
        ${pending.length ? `<span class="mini" data-bindqueue="pending">连续确认…</span>` : ''}
        <div class="stat"><b>${pending.length}</b><span>部待确认</span></div></div>
      ${
        pending.length
          ? `<div class="pending">${pending
              .map(
                (g) =>
                  `<div class="pitem"><span class="pnm">${esc(g.title)}</span><span class="psc">${g.matchScore ?? '—'}</span><button class="mini" data-bind="${esc(g.id)}">校正…</button></div>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="srow"><div class="lab"><b>未匹配队列</b><span>${unmatched.length ? '自动匹配没到阈值；点「选择条目…」从搜索结果里手动绑定' : '全部作品都有条目'}</span></div>
        ${unmatched.length ? `<span class="mini" data-bindqueue="unmatched">连续选择…</span>` : ''}
        <div class="stat"><b>${unmatched.length}</b><span>部未匹配</span></div></div>
      ${
        unmatched.length
          ? `<div class="pending">${unmatched
              .map(
                (g) =>
                  `<div class="pitem"><span class="pnm">${esc(g.title)}</span><span class="psc">—</span><button class="mini" data-bind="${esc(g.id)}">选择条目…</button></div>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="srow"><div class="lab"><b>封面缓存</b><span>WebP · 255×340 轨道档 / 300×400 详情档</span></div>
        <div class="stat"><b>${state.games.filter((g) => g.thumb).length}</b><span>已生成</span></div></div>
    </div>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>手动添加</b><span>直接选主程序 exe + 填标题；封面 / 引擎仍按所在目录读取，小体积 / 合集目录也能入库</span></div>
        <button class="mini" data-act="addgame">选择 exe…</button></div>
    </div>
    ${
      hidden.length
        ? `<div class="spanel"><div class="srow"><div class="lab"><b>隐藏作品</b><span>默认视图不显示；恢复后回到轨道</span></div><div class="stat"><b>${hidden.length}</b><span>部</span></div></div>
        <div class="pending">${hidden.map((g) => `<div class="pitem"><span class="pnm">${esc(g.title)}</span><button class="mini" data-unhide="${esc(g.id)}">恢复</button></div>`).join('')}</div></div>`
        : ''
    }
    <div class="spanel">
      <div class="srow"><div class="lab"><b>备份</b><span>导出库 + 设置到 JSON；导入会先另存当前库</span></div>
        <span class="mini" data-act="export">导出…</span><span class="mini" data-act="import">导入…</span></div>
    </div>`;
}

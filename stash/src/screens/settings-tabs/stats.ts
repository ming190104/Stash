/** 统计页签：全部由本地记录推导（playSeconds / sessions / endings），不联网、不改数据。 */
import { state, isFinished } from '../../state';
import { esc, fmtDuration } from '../../ui';

export function statsHTML(): string {
  const games = state.games.filter((g) => !g.hidden);
  const totalSec = games.reduce((a, g) => a + (g.playSeconds ?? 0), 0);
  const started = games.filter((g) => (g.playSeconds ?? 0) > 0).length;
  const finished = games.filter(isFinished).length;
  const totalEnds = games.reduce((a, g) => a + g.endings.length, 0);
  const doneEnds = games.reduce((a, g) => a + g.endings.filter((e) => e.done).length, 0);
  // 近 7 天：按「场次开始时间」归日（旧记录没有 sessions 时该天计 0，不影响总时长）
  const dayMs = 86_400_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const from = today.getTime() - (6 - i) * dayMs;
    const sec = games.reduce(
      (a, g) => a + (g.sessions ?? []).filter((s) => s.at * 1000 >= from && s.at * 1000 < from + dayMs).reduce((b, s) => b + s.seconds, 0),
      0,
    );
    return { from, sec, label: new Date(from).toLocaleDateString('zh-CN', { weekday: 'short' }) };
  });
  const weekSec = days.reduce((a, d) => a + d.sec, 0);
  const maxDay = Math.max(1, ...days.map((d) => d.sec));
  const bars = days
    .map(
      (d) =>
        `<div class="bar-col" title="${esc(new Date(d.from).toLocaleDateString('zh-CN'))} · ${esc(fmtDuration(d.sec))}"><i style="height:${Math.round((d.sec / maxDay) * 100)}%"></i><span>${esc(d.label)}</span></div>`,
    )
    .join('');
  const top = [...games]
    .filter((g) => (g.playSeconds ?? 0) > 0)
    .sort((a, b) => b.playSeconds - a.playSeconds)
    .slice(0, 5);
  return `
    <h2 class="sh">统计</h2>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>累计游玩</b><span>${started} / ${games.length} 部已开始 · 按启动到退出的真实时长累加</span></div>
        <div class="stat"><b>${esc(fmtDuration(totalSec))}</b><span>总时长</span></div></div>
      <div class="srow"><div class="lab"><b>近 7 天</b><span>按场次开始时间归日；旧记录没有场次明细时显示 0</span></div>
        <div class="stat"><b>${esc(fmtDuration(weekSec))}</b><span>本周</span></div></div>
      <div class="srow"><div class="lab"><b>已通关</b><span>结局清单里全部勾选达成即计入</span></div>
        <div class="stat"><b>${finished}</b><span>/ ${games.length} 部</span></div></div>
      <div class="srow"><div class="lab"><b>END 收集</b><span>详情页「结局 · 路线」里勾选的达成数</span></div>
        <div class="stat"><b>${totalEnds ? `${Math.round((doneEnds / totalEnds) * 100)}%` : '—'}</b><span>${totalEnds ? `${doneEnds} / ${totalEnds}` : '尚未记录'}</span></div></div>
    </div>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>最近 7 天</b><span>每日游玩时长</span></div></div>
      <div class="bars7">${bars}</div>
    </div>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>玩得最多</b><span>按累计时长前 5 部</span></div></div>
      ${
        top.length
          ? `<div class="pending">${top
              .map(
                (g) =>
                  `<div class="pitem"><span class="pnm">${esc(g.title)}</span><span class="psc">${esc(fmtDuration(g.playSeconds))}</span></div>`,
              )
              .join('')}</div>`
          : `<div class="snap-empty">还没有游玩记录。启动任意一部作品后，退出即会计入。</div>`
      }
    </div>`;
}

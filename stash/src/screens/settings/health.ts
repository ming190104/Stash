/** 库体检：汇总卡片、修复动作与清理入口。 */

import type { HealthReport } from '../../types';
import { esc, toast } from '../../ui';
import { libraryHealth, pruneMissingGames, cleanStorage } from '../../ipc';
import { promptInput } from '../../prompt';
import { renderRail, refreshLibrary } from '../library';
import { renderGrid } from '../grid';
import { rerender } from './ui';

/** 最近一次库体检结果（切页签回来仍显示） */
let healthReport: HealthReport | null = null;

const HEALTH_LABEL: Record<string, string> = {
  missingDir: '失效目录',
  missingExe: '缺失主程序',
  missingCover: '封面丢失',
  unknownEngine: '引擎未识别',
  duplicate: '疑似重复',
};

/** 字节转人读格式：缓存目录动辄几百 MB，必须给用户看得懂的量级 */
export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** 库页签内容：体检入口 + 汇总 + 问题清单（复用既有 .pending/.pitem 样式） */
export function healthHTML(r: HealthReport | null = healthReport): string {
  if (!r) {
    return `<div class="srow"><div class="lab"><b>库体检</b><span>检查失效目录/主程序、重复条目、未识别引擎、孤儿缓存</span></div>
        <span class="mini" data-act="health">开始体检</span></div>
      <div class="snap-empty">还没有体检结果。点击「开始体检」检查当前库。</div>`;
  }
  const problems = r.missingDirs + r.missingExes + r.duplicates + r.missingCovers;
  const cache = r.orphanThumbs + r.orphanCovers + r.tmpLeftovers;
  const rows = r.issues
    .slice(0, 80)
    .map((it) => {
      const detail = it.detail.length > 56 ? `${it.detail.slice(0, 56)}…` : it.detail;
      return `<div class="pitem"><span class="pnm">${esc(it.title)} · ${esc(HEALTH_LABEL[it.kind] ?? it.kind)}</span><span class="psc" title="${esc(it.detail)}">${esc(detail)}</span></div>`;
    })
    .join('');
  return `
    <div class="srow"><div class="lab"><b>重新体检</b><span>共 ${r.total} 部 · 问题 ${problems} 项 · 孤儿缓存 ${cache} 个</span></div>
      <span class="mini" data-act="health">重新体检</span></div>
    <div class="srow"><div class="lab"><b>失效条目</b><span>目录或主程序已丢失：${r.missingDirs + r.missingExes} 部 · 移除后游玩记录一并删除</span></div>
      <span class="mini" data-fix="missing">移除…</span></div>
    <div class="srow"><div class="lab"><b>重复 / 同名</b><span>${r.duplicates} 组 · 汉化/生肉等版本请手动确认</span></div></div>
    <div class="srow"><div class="lab"><b>引擎未识别</b><span>${r.unknownEngines} 部 · 不影响启动，存档/转区提示可能不准</span></div></div>
    <div class="srow"><div class="lab"><b>封面丢失</b><span>${r.missingCovers} 部 · 在详情「更多操作 → 封面」里重选可修复</span></div></div>
    <div class="srow"><div class="lab"><b>无用缓存</b><span>孤儿缩略图 / 封面 / 临时文件共 ${cache} 个 · 清理后不影响已入库作品</span></div>
      <span class="mini" data-fix="storage">清理…</span></div>
    ${rows ? `<div class="pending">${rows}</div>` : `<div class="snap-empty">没有发现失效条目或重复项。</div>`}`;
}

export async function runHealth(notify = true): Promise<void> {
  healthReport = await libraryHealth();
  rerender();
  // 修复动作自己会 toast 结果；这里再弹会把它覆盖掉
  if (notify) toast(`体检完成 · ${healthReport.issues.length} 条记录`);
}

/** 库体检的修复动作：失效条目需输入「确认」二次确认；缓存可再生，直接清理 */
export function wireHealthFix(body: HTMLElement): void {
  body.querySelectorAll<HTMLElement>('[data-fix]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.fix;
      try {
        if (kind === 'missing') {
          const n = (healthReport?.missingDirs ?? 0) + (healthReport?.missingExes ?? 0);
          if (!n) {
            toast('没有需要移除的失效条目');
            return;
          }
          const v = await promptInput({
            title: '移除失效条目',
            sub: `共 ${n} 部目录或主程序已丢失，游玩记录会一并删除。输入「确认」继续`,
          });
          if (v !== '确认') return;
          const removed = await pruneMissingGames();
          await refreshLibrary();
          renderRail();
          renderGrid();
          toast(`已移除 ${removed} 部失效作品`);
        } else if (kind === 'storage') {
          // 缓存可再生，直接清理
          const out = await cleanStorage();
          toast(
            `已清理 ${out.cacheRemoved} 个孤儿缓存 · 释放 ${fmtBytes(out.freedBytes)}`,
          );
        }
        await runHealth(false);
      } catch (e) {
        toast(esc(String((e as { message?: string })?.message ?? e)), true);
      }
    });
  });
}

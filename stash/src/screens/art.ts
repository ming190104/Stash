/** 封面美术：轨道 / 网格 / 列表 / 海报墙 / Hero 共用的卡片封面结构 + 异步填充。
 *  没有封面时用确定性占位美术（降级即正式设计），有封面时 img + data-src 延迟解析。 */

import type { Game } from '../types';
import { state } from '../state';
import { asset } from '../ipc';
import { esc } from '../ui';
import { placeholderArt } from '../art';

/** 与 mockup artHTML 同构：.art(bg/--s1/--s2) + .vt/.ro；有封面时 img + has-img */
export function artHTML(g: Game): string {
  // 竖排最多 6 字：超长时补省略号，别把「hamida…」截成没有结尾的半截字。
  // 按码点切（Array.from）而不是 UTF-16 单元，否则 emoji / 增补平面字符会被切成半个代理对。
  const raw = (g.titleOriginal || g.title || '').trim();
  const chars = Array.from(raw);
  const vertical = chars.length > 6 ? `${chars.slice(0, 5).join('')}…` : raw;
  const vt = state.verticalTitle ? `<span class="vt">${esc(vertical)}</span>` : '';
  const ro = g.romaji ? `<span class="ro">${esc(g.romaji)}</span>` : '';
  if (g.thumb || g.cover) {
    // data-fb = 原封面：缩略图是可再生的缓存文件（清缓存 / 杀软清理 / 迁移目录后可能已不在），
    // 加载失败时退回原封面，别让卡片停在深色底
    const fb = g.thumb && g.cover ? ` data-fb="${esc(g.cover)}"` : '';
    return `<div class="art has-img" data-src="${esc((g.thumb || g.cover)!)}"${fb}><i class="glow"></i><img alt="" loading="lazy"></div>`;
  }
  const { bg, s1, s2 } = placeholderArt(g.id);
  // 空封面兜底：大字号首字 + 引擎徽章，让「没有封面」也像一张设计过的脸
  const initial = raw.slice(0, 1) || '?';
  const badge = g.engineLabel ? `<span class="ph-y">${esc(g.engineLabel)}</span>` : '';
  return `<div class="art" style="background:${bg};--s1:${s1};--s2:${s2}"><i class="glow"></i><span class="ph-t">${esc(initial)}</span>${badge}${vt}${ro}</div>`;
}

/** 异步把 data-src 解析为 asset:// URL 并填入 img（含 kv/dcover/ll 等复用处）；
 *  加载完成加 .ld 淡入，失败保留深色底（.art 背景兜底） */
export function hydrateArts(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.art[data-src]').forEach((el) => {
    const p = el.dataset.src!;
    delete el.dataset.src;
    asset(p)
      .then((u) => {
        const img = el.querySelector('img');
        if (!img) return;
        const show = (): void => img.classList.add('ld');
        img.addEventListener('load', show, { once: true });
        img.addEventListener(
          'error',
          () => {
            const fb = el.dataset.fb;
            if (!fb) {
              show();
              return;
            }
            // 缩略图文件已不在（清过缓存 / 迁过目录）或解码不了：退回原封面再试一次
            delete el.dataset.fb;
            asset(fb)
              .then((fu) => {
                img.src = fu;
              })
              .catch(show);
          },
          { once: true },
        );
        img.src = u;
      })
      .catch(() => {
        /* 封面解析失败：保留空 .art，深色底 + 描边仍可见 */
      });
  });
}

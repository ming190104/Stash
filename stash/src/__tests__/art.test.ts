// @vitest-environment happy-dom
/** 封面美术（拆自 library.ts）：结构、占位降级、异步填充。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { game, mountSkeleton, resetState } from './dom-skeleton';
import { artHTML, hydrateArts } from '../screens/art';
import { asset } from '../ipc';

vi.mock('../ipc', () => ({
  asset: vi.fn(async (p: string) => `asset://${p}`),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mountSkeleton();
  resetState();
});

describe('artHTML', () => {
  it('有缩略图：data-src 用缩略图，data-fb 留原封面兜底，img 懒加载', () => {
    const html = artHTML(game('a', { thumb: 'C:/thumbs/a.webp', cover: 'C:/covers/a.jpg' }));
    expect(html).toContain('class="art has-img"');
    expect(html).toContain('data-src="C:/thumbs/a.webp"');
    expect(html).toContain('data-fb="C:/covers/a.jpg"');
    expect(html).toContain('loading="lazy"');
  });

  it('只有原封面：直接用它，不写 data-fb（没有第二张可退）', () => {
    const html = artHTML(game('b', { cover: 'C:/covers/b.jpg' }));
    expect(html).toContain('data-src="C:/covers/b.jpg"');
    expect(html).not.toContain('data-fb');
  });

  it('无封面：确定性占位渐变 + 竖排原文（降级即正式设计）', () => {
    const html = artHTML(game('c', { title: '千恋万花', titleOriginal: '千恋＊万花' }));
    expect(html).toContain('radial-gradient');
    expect(html).toContain('class="vt"');
    expect(html).toContain('千恋＊万花');
  });

  it('无封面：有首字兜底与引擎徽章，长标题竖排补省略号', () => {
    const html = artHTML(
      game('e', { titleOriginal: 'この大空に、翼をひろげて', engineLabel: "Ren'Py" }),
    );
    expect(html).toContain('class="ph-t"');
    expect(html).toContain('>こ<');
    expect(html).toContain('class="ph-y"');
    expect(html).toContain("Ren&#39;Py");
    // 竖排超过 6 字：5 字 + …
    expect(html).toContain('この大空に…');
  });

  it('有封面不叠首字（避免压在插画上）', () => {
    const html = artHTML(game('f', { cover: 'C:/covers/f.jpg', title: 'F' }));
    expect(html).not.toContain('class="ph-t"');
  });
});

describe('hydrateArts', () => {
  it('把 data-src 解析成 asset URL 填进 img，并只处理一次', async () => {
    const box = document.createElement('div');
    box.innerHTML = artHTML(game('d', { thumb: 'C:/thumbs/d.webp' }));
    document.getElementById('app')!.appendChild(box);

    hydrateArts(box);
    // 用属性而不是 img.src：happy-dom 会把自定义协议当作 URL 规范化（冒号被吃掉）
    await vi.waitFor(() => expect(box.querySelector('img')?.getAttribute('src')).toBe('asset://C:/thumbs/d.webp'));
    expect(asset).toHaveBeenCalledWith('C:/thumbs/d.webp');
    // 解析后 data-src 已摘掉：重复调用不会再次请求同一张图
    expect(box.querySelector<HTMLElement>('.art')?.dataset.src).toBeUndefined();
  });
});

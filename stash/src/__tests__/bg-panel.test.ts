// @vitest-environment happy-dom
/** 背景图候选墙：上图下文卡片、当前项默认焦点、键鼠选择与特殊入口（指定图片 / 恢复自动）。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { key, mountSkeleton, resetState } from './dom-skeleton';
import { asset, backgroundCandidates } from '../ipc';
import { BG_AUTO, BG_PICK, bgKey, openBgPanel } from '../bgpanel';

vi.mock('../ipc', () => ({
  asset: vi.fn(async (p: string) => `asset://${p}`),
  backgroundCandidates: vi.fn(async () => []),
}));

const CARDS = [
  { key: 'local-0', label: '目录截图 1', source: 'local', width: 1920, height: 1080, thumb: 'C:/t/a.webp', current: false },
  { key: 'sgdb-2', label: '商店横幅 2', source: 'sgdb', width: 0, height: 0, thumb: null, current: false },
  { key: 'sgdb', label: '商店横幅', source: 'sgdb', width: 3840, height: 1240, thumb: 'C:/t/b.webp', current: false },
  { key: 'current', label: '当前背景', source: 'current', width: 1920, height: 1080, thumb: 'C:/t/c.webp', current: true },
  { key: 'local-1', label: '目录截图 2', source: 'local', width: 0, height: 0, thumb: null, current: false },
];

const el = (id: string): HTMLElement => document.getElementById(id)!;
const shown = (): boolean => el('bgPanel').classList.contains('show');

beforeEach(() => {
  vi.clearAllMocks();
  mountSkeleton();
  resetState();
  vi.mocked(backgroundCandidates).mockResolvedValue(CARDS.map((c) => ({ ...c })));
  vi.mocked(asset).mockImplementation(async (p: string) => `asset://${p}`);
});

describe('背景候选墙', () => {
  it('候选渲染成上图下文卡片，当前背景默认获得焦点并带徽标', async () => {
    const pick = openBgPanel('g', '千恋万花');
    expect(shown()).toBe(true);
    expect(el('bgTitle').textContent).toBe('千恋万花');

    await vi.waitFor(() => expect(document.querySelectorAll('#bgGrid .bg-card').length).toBe(5));
    const first = document.querySelector<HTMLElement>('#bgGrid .bg-card[data-i="0"]')!;
    const parts = [...first.children].map((c) => c.className);
    expect(parts).toEqual(['bg-th', 'bg-nm', 'bg-meta']);
    expect(first.querySelector('.bg-nm')!.textContent).toBe('目录截图 1');
    expect(first.querySelector('.bg-meta')!.textContent).toContain('游戏目录');
    expect(first.querySelector('.bg-meta')!.textContent).toContain('1920×1080');

    const cur = document.querySelector<HTMLElement>('#bgGrid .bg-card[data-i="3"]')!;
    expect(cur.classList.contains('focus')).toBe(true);
    expect(cur.classList.contains('on')).toBe(true);
    expect(cur.querySelector('.bg-badge')!.textContent).toBe('当前');

    // 缩略图走 asset 协议挂到画面里（happy-dom 会把 src 规范化，这里读原始属性）
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLImageElement>('#bgGrid .bg-card[data-i="0"] img')?.getAttribute('src'),
      ).toBe('asset://C:/t/a.webp'),
    );
    expect(document.querySelector('#bgGrid .bg-card[data-i="1"] img')).toBeNull();
    // 没有缩略图的候选：占位文案最终是「无预览」，不会一直停在「载入中…」
    await vi.waitFor(() =>
      expect(document.querySelector('#bgGrid .bg-card[data-i="1"] .bg-ph')?.textContent).toBe('无预览'),
    );

    expect(bgKey(key('Escape'))).toBe(true);
    expect(await pick).toBeNull();
    expect(shown()).toBe(false);
  });

  it('重复打开时旧的等待按「关闭」收尾，不会永远挂起', async () => {
    const first = openBgPanel('g', 'x');
    const second = openBgPanel('g', 'y');
    expect(await first).toBeNull();
    expect(bgKey(key('Escape'))).toBe(true);
    expect(await second).toBeNull();
  });

  it('方向键在 4 列网格里移动焦点，A / Enter 选中并关闭', async () => {
    const pick = openBgPanel('g', 'x');
    await vi.waitFor(() => expect(document.querySelectorAll('#bgGrid .bg-card').length).toBe(5));

    expect(bgKey(key('ArrowLeft'))).toBe(true);
    expect(document.querySelector<HTMLElement>('#bgGrid .bg-card[data-i="2"]')!.classList.contains('focus')).toBe(true);
    expect(bgKey(key('ArrowDown'))).toBe(true);
    expect(document.querySelector<HTMLElement>('#bgGrid .bg-card[data-i="4"]')!.classList.contains('focus')).toBe(true);
    expect(bgKey(key('ArrowRight'))).toBe(true); // 已是最后一张：夹紧不越界
    expect(document.querySelector<HTMLElement>('#bgGrid .bg-card[data-i="4"]')!.classList.contains('focus')).toBe(true);

    expect(bgKey(key('Enter'))).toBe(true);
    expect(await pick).toBe('local-1');
    expect(shown()).toBe(false);
  });

  it('点击卡片直接应用；点暗底关闭；P / R 分别对应指定图片与恢复自动', async () => {
    const pick = openBgPanel('g', 'x');
    await vi.waitFor(() => expect(document.querySelectorAll('#bgGrid .bg-card').length).toBe(5));
    document.querySelector<HTMLElement>('#bgGrid .bg-card[data-i="1"]')!.click();
    expect(await pick).toBe('sgdb-2');

    const closed = openBgPanel('g', 'x');
    el('bgPanel').click();
    expect(await closed).toBeNull();

    const pickFile = openBgPanel('g', 'x');
    expect(bgKey(key('KeyP'))).toBe(true);
    expect(await pickFile).toBe(BG_PICK);

    const auto = openBgPanel('g', 'x');
    expect(bgKey(key('KeyR'))).toBe(true);
    expect(await auto).toBe(BG_AUTO);

    const chip = openBgPanel('g', 'x');
    el('bgPick').click();
    expect(await chip).toBe(BG_PICK);
  });

  it('手柄 X / Y 与键盘 P / R 等价：分别对应指定图片与恢复自动', async () => {
    const padPick = openBgPanel('g', 'x');
    expect(bgKey(key('KeyX'))).toBe(true);
    expect(await padPick).toBe(BG_PICK);

    const padAuto = openBgPanel('g', 'x');
    expect(bgKey(key('KeyY'))).toBe(true);
    expect(await padAuto).toBe(BG_AUTO);
  });

  it('先出本地候选，再补齐在线候选（焦点留在原来那张）', async () => {
    const local = CARDS.filter((c) => c.source === 'local').map((c) => ({ ...c }));
    const remote = CARDS.filter((c) => c.key === 'sgdb-2').map((c) => ({ ...c }));
    vi.mocked(backgroundCandidates)
      .mockResolvedValueOnce(local)
      .mockResolvedValueOnce([...local, ...remote]);
    const pick = openBgPanel('g', 'x');

    await vi.waitFor(() => expect(document.querySelectorAll('#bgGrid .bg-card').length).toBe(3));
    expect(document.querySelector<HTMLElement>('#bgGrid .bg-card[data-i="0"]')!.classList.contains('focus')).toBe(true);
    // 第一次只取本地，第二次才允许联网
    expect(vi.mocked(backgroundCandidates).mock.calls.map((c) => c[1])).toEqual([false, true]);

    expect(bgKey(key('Enter'))).toBe(true);
    expect(await pick).toBe('local-0');
  });

  it('在线候选重绘后，迟到的本地缩略图不会按旧索引贴到新卡片', async () => {
    const local = { ...CARDS[0] };
    const remote = { ...CARDS[1], thumb: 'C:/t/new.webp' };
    vi.mocked(backgroundCandidates)
      .mockResolvedValueOnce([local])
      .mockResolvedValueOnce([remote, local]);
    let finishOld!: (url: string) => void;
    let oldCalls = 0;
    vi.mocked(asset).mockImplementation(async (path: string) => {
      if (path === local.thumb && ++oldCalls === 1) {
        return new Promise<string>((resolve) => { finishOld = resolve; });
      }
      return `asset://${path}`;
    });
    const pick = openBgPanel('g', 'x');
    const remoteImg = (): HTMLImageElement | null =>
      document.querySelector<HTMLImageElement>('#bgGrid .bg-card[data-i="0"] img');

    await vi.waitFor(() => expect(remoteImg()?.getAttribute('src')).toBe('asset://C:/t/new.webp'));
    finishOld('asset://C:/t/a.webp');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(remoteImg()?.getAttribute('src')).toBe('asset://C:/t/new.webp');
    expect(bgKey(key('Escape'))).toBe(true);
    expect(await pick).toBeNull();
  });

  it('没有候选时给出去向提示，而不是空白面板', async () => {
    vi.mocked(backgroundCandidates).mockResolvedValue([]);
    const pick = openBgPanel('g', 'x');
    await vi.waitFor(() => expect(el('bgGrid').textContent).toContain('没有匹配到背景候选'));
    expect(el('bgGrid').querySelector('.bg-tip')).not.toBeNull();
    expect(bgKey(key('Enter'))).toBe(true); // 空列表下 A 不产生选择
    expect(shown()).toBe(true);
    expect(bgKey(key('Escape'))).toBe(true);
    expect(await pick).toBeNull();
  });
});

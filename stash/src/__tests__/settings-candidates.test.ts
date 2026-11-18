// @vitest-environment happy-dom
/** 改绑条目：四源候选墙的检索中 / 封面与占位 / 点选或 A 应用 / X 取消匹配 / 并发覆盖。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { key, mountSkeleton, resetState } from './dom-skeleton';
import { showCandidates } from '../screens/settings/wire/metadata';
import { applyCandidate, getLibrary, metaCandidates, unmatchGame } from '../ipc';
import { candKey } from '../candpanel';
import { anyState, handleOverlayKey } from '../overlay';

vi.mock('../ipc', async (orig) => {
  const real = await orig<typeof import('../ipc')>();
  return {
    ...real,
    getLibrary: vi.fn(async () => []),
    metaCandidates: vi.fn(),
    applyCandidate: vi.fn(),
    unmatchGame: vi.fn(),
  };
});

// 绑定 / 取消后会重建库屏与网格；这里只关心候选层，整块替身掉
vi.mock('../screens/library', () => ({ renderRail: vi.fn() }));
vi.mock('../screens/grid', () => ({ renderGrid: vi.fn() }));

const ID = '0123456789abcdef';

const candidate = (key: string, title: string, year: number | null, score: number, thumb?: string) => ({
  source: 'bangumi' as const,
  key,
  title,
  original: null,
  year,
  score,
  summary: null,
  thumb: thumb ?? null,
  egs: null,
});

const shown = (): boolean => document.getElementById('candPanel')!.classList.contains('show');
const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#candGrid .cand-card')];

beforeEach(() => {
  vi.clearAllMocks();
  mountSkeleton();
  resetState();
  vi.mocked(metaCandidates).mockResolvedValue([]);
  vi.mocked(applyCandidate).mockResolvedValue(undefined);
  vi.mocked(unmatchGame).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('改绑条目（模态候选墙）', () => {
  it('打开即进模态层并给检索反馈；候选有封面用封面、没封面用占位美术', async () => {
    let finishLoad: (v: unknown) => void = () => {};
    vi.mocked(metaCandidates).mockImplementation(
      (() => new Promise((res) => (finishLoad = res))) as never,
    );
    const p = showCandidates(ID);

    expect(shown()).toBe(true);
    expect(document.getElementById('candGrid')!.textContent).toContain('四源并行检索中');
    expect(anyState()).toBe(true);

    finishLoad([
      candidate('1111', '装甲恶鬼村正（正确条目）', 2009, 92, 'C:/thumbs/cand-1111.webp'),
      candidate('2222', '装甲恶鬼村正 贖罪編', 2011, 61),
    ]);
    await vi.waitFor(() => expect(cards().length).toBe(2));

    expect(cards().every((c) => c.tagName === 'BUTTON')).toBe(true);
    expect(cards()[0]!.classList.contains('focus')).toBe(true);
    const arts = [...document.querySelectorAll<HTMLElement>('#candGrid .cand-art')];
    expect(arts[0]!.style.backgroundImage).toContain('cand-1111.webp');
    // 无封面：确定性占位渐变，不留空白格
    expect(arts[1]!.style.background).toContain('radial-gradient');
    expect(document.querySelector('#candGrid .cand-src')?.textContent).toBe('Bangumi');
    expect(document.querySelector('#candGrid .cand-nm')?.textContent).toBe('装甲恶鬼村正（正确条目）');
    expect(document.querySelector('#candGrid .cand-mt')?.textContent).toBe('2009 · 92 分');

    expect(candKey(key('ArrowRight'))).toBe(true);
    expect(cards()[1]!.classList.contains('focus')).toBe(true);
    expect(candKey(key('Enter'))).toBe(true);
    await vi.waitFor(() =>
      expect(applyCandidate).toHaveBeenCalledWith(ID, 'bangumi', '2222', [
        'title',
        'original',
        'year',
        'summary',
        'cover',
        'score',
      ]),
    );
    await p;
    expect(shown()).toBe(false);
  });

  it('鲲 Galgame 候选：来源角标正确，应用时七字段全传', async () => {
    vi.mocked(metaCandidates).mockResolvedValue([
      {
        ...candidate('4145', '甜蜜女友 3', 2025, 100),
        source: 'kungal' as const,
        original: 'アマカノ３',
        summary: '简介',
      },
    ]);
    const p = showCandidates(ID);
    await vi.waitFor(() => expect(cards().length).toBe(1));
    expect(document.querySelector('#candGrid .cand-src')?.textContent).toBe('鲲 Galgame');
    expect(document.querySelector('#candGrid .cand-mt')?.textContent).toBe('2025 · 匹配 100');

    expect(candKey(key('Enter'))).toBe(true);
    await vi.waitFor(() =>
      expect(applyCandidate).toHaveBeenCalledWith(ID, 'kungal', '4145', [
        'title',
        'original',
        'year',
        'summary',
        'cover',
        'score',
        'length',
      ]),
    );
    await p;
    expect(shown()).toBe(false);
  });

  it('候选为空给说明；X / 取消匹配条立即回到本地 meta.json', async () => {
    const p = showCandidates(ID);
    await vi.waitFor(() => expect(document.getElementById('candGrid')!.textContent).toContain('没有候选'));
    expect(cards().length).toBe(0);

    expect(candKey(key('KeyX'))).toBe(true);
    await vi.waitFor(() => expect(unmatchGame).toHaveBeenCalledWith(ID));
    await p;
    expect(shown()).toBe(false);
  });

  it('检索失败写明原因，不留下「检索中…」', async () => {
    vi.mocked(metaCandidates).mockRejectedValue(new Error('Bangumi 不可达'));
    const p = showCandidates(ID);
    await vi.waitFor(() => expect(document.getElementById('candGrid')!.textContent).toContain('检索失败'));
    expect(document.getElementById('candGrid')!.textContent).toContain('Bangumi 不可达');
    expect(handleOverlayKey(key('Escape'))).toBe(true);
    await p;
    expect(shown()).toBe(false);
  });

  it('应用途中按 B：界面先收起，结果回来后仍刷新（不挂起、不丢刷新）', async () => {
    let finishApply: () => void = () => {};
    vi.mocked(metaCandidates).mockResolvedValue([candidate('1111', '条目', 2009, 92)]);
    vi.mocked(applyCandidate).mockImplementation(() => new Promise<void>((res) => (finishApply = () => res())));

    const p = showCandidates(ID);
    await vi.waitFor(() => expect(cards().length).toBe(1));
    expect(candKey(key('Enter'))).toBe(true); // 应用请求已发出

    let settled = false;
    void p.then(() => (settled = true));

    expect(candKey(key('Escape'))).toBe(true); // 先收起界面
    expect(shown()).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false); // 结果没回来前不提前收尾

    finishApply();
    await p;
    expect(applyCandidate).toHaveBeenCalledWith(ID, 'bangumi', '1111', [
      'title',
      'original',
      'year',
      'summary',
      'cover',
      'score',
    ]);
    expect(getLibrary).toHaveBeenCalled(); // 应用成功仍会刷新设置里的匹配列表
  });

  it('EGS 候选：角标与中央值/时长正确，点选按 egs 源 + 标题回传', async () => {
    vi.mocked(metaCandidates).mockResolvedValue([
      {
        source: 'egs',
        key: '装甲悪鬼村正',
        title: '装甲悪鬼村正',
        original: null,
        year: null,
        score: 60,
        summary: null,
        thumb: null,
        egs: { score: 78, votes: 120, minutes: 1500 },
      },
    ]);

    const p = showCandidates(ID);
    await vi.waitFor(() => expect(cards().length).toBe(1));
    expect(document.querySelector('#candGrid .cand-src')?.textContent).toBe('批评空间');
    // EGS 不显示相似度，显示自己的中央值与四舍五入后的时长
    expect(document.querySelector('#candGrid .cand-mt')?.textContent).toBe('中央值 78 · 25 小时');

    cards()[0]!.click();
    await vi.waitFor(() =>
      expect(applyCandidate).toHaveBeenCalledWith(ID, 'egs', '装甲悪鬼村正', ['score', 'length']),
    );
    await p;
    expect(shown()).toBe(false);
  });

  it('连续改绑两部作品：后开的覆盖前一个，旧请求晚到也不覆盖', async () => {
    const A = 'aaaaaaaaaaaaaaaa';
    const B = 'bbbbbbbbbbbbbbbb';
    const pending = new Map<string, (v: unknown) => void>();
    vi.mocked(metaCandidates).mockImplementation(
      ((id: string) => new Promise((res) => pending.set(id, res))) as never,
    );

    const pA = showCandidates(A);
    const pB = showCandidates(B);
    // 开 B 时把 A 的等待按「关闭」收尾，调用方不会挂住
    await pA;

    pending.get(B)!([candidate('2222', 'B 的条目', 2021, 91)]);
    await vi.waitFor(() => expect(document.querySelector('#candGrid .cand-nm')?.textContent).toBe('B 的条目'));

    // A 的旧结果晚到：必须被丢弃，面板仍是 B
    pending.get(A)!([candidate('1111', 'A 的条目', 2019, 88)]);
    expect(document.querySelector('#candGrid .cand-nm')?.textContent).toBe('B 的条目');

    cards()[0]!.click();
    await vi.waitFor(() =>
      expect(applyCandidate).toHaveBeenCalledWith(B, 'bangumi', '2222', [
        'title',
        'original',
        'year',
        'summary',
        'cover',
        'score',
      ]),
    );
    await pB;
    expect(shown()).toBe(false);
  });

  it('预览展示简介；F 进入字段模式，取消标题后只写其余字段', async () => {
    vi.mocked(metaCandidates).mockResolvedValue([
      { ...candidate('1111', '装甲恶鬼村正', 2009, 92), summary: '简介正文' },
    ]);
    const p = showCandidates(ID);
    await vi.waitFor(() => expect(cards().length).toBe(1));

    expect(document.querySelector('#candPrev .cprev-sum')?.textContent).toBe('简介正文');
    // 默认全部勾选
    const chips = () => [...document.querySelectorAll<HTMLElement>('#candPrev .cprev-chip')];
    expect(chips().every((c) => c.classList.contains('on'))).toBe(true);

    expect(candKey(key('KeyF'))).toBe(true);
    expect(document.querySelector('#candPrev .cprev-chip.cur')?.textContent).toBe('标题');
    expect(candKey(key('Enter'))).toBe(true); // 取消「标题」
    expect(chips()[0]!.classList.contains('on')).toBe(false);
    expect(candKey(key('KeyB'))).toBe(true); // 退回卡片，但不关面板
    expect(shown()).toBe(true);

    cards()[0]!.click();
    await vi.waitFor(() =>
      expect(applyCandidate).toHaveBeenCalledWith(ID, 'bangumi', '1111', [
        'original',
        'year',
        'summary',
        'cover',
        'score',
      ]),
    );
    await p;
    expect(shown()).toBe(false);
  });

  it('批量队列：应用后自动检索下一部，最后一步才收尾', async () => {
    const A = 'aaaaaaaaaaaaaaaa';
    const B = 'bbbbbbbbbbbbbbbb';
    vi.mocked(metaCandidates)
      .mockResolvedValueOnce([candidate('1111', '第一部', 2009, 92)])
      .mockResolvedValueOnce([candidate('2222', '第二部', 2011, 88)]);

    const p = showCandidates(A, [
      { id: A, title: '甲' },
      { id: B, title: '乙' },
    ]);
    await vi.waitFor(() => expect(cards().length).toBe(1));
    expect(document.getElementById('candQueue')?.textContent).toBe('队列 1/2');

    cards()[0]!.click();
    await vi.waitFor(() => expect(metaCandidates).toHaveBeenCalledTimes(2));
    expect(cards().length).toBe(1); // 第二次结果已换上
    expect(document.getElementById('candQueue')?.textContent).toBe('队列 2/2');
    expect(shown()).toBe(true); // 队列没走完不关面板

    cards()[0]!.click();
    await p;
    expect(applyCandidate).toHaveBeenNthCalledWith(1, A, 'bangumi', '1111', [
      'title',
      'original',
      'year',
      'summary',
      'cover',
      'score',
    ]);
    expect(applyCandidate).toHaveBeenNthCalledWith(2, B, 'bangumi', '2222', [
      'title',
      'original',
      'year',
      'summary',
      'cover',
      'score',
    ]);
    expect(shown()).toBe(false);
  });
});

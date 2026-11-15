/** IPC 返回的运行时兜底：结构漂移时丢坏记录 / 补默认值，不让界面直接崩。 */

import { describe, expect, it } from 'vitest';
import { sanitizeLibrary, sanitizeMetaCandidates, sanitizeSettings } from '../ipc';

const good = { id: 'a', title: 'A', dir: 'D:/a', tags: ['t'] };

describe('sanitizeLibrary', () => {
  it('丢弃缺 id/title/dir 的条目，数组字段缺失补空数组', () => {
    const out = sanitizeLibrary([
      good,
      { id: '', title: 'x', dir: '' },
      null,
      { id: 'b', title: 'B', dir: 'D:/b', tags: 'bad', shots: null },
    ]);
    expect(out.map((g) => g.id)).toEqual(['a', 'b']);
    expect(out[1].tags).toEqual([]);
    expect(out[1].shots).toEqual([]);
    expect(out[1].userTags).toEqual([]);
  });

  it('非数组按空库处理', () => {
    expect(sanitizeLibrary(null)).toEqual([]);
    expect(sanitizeLibrary({})).toEqual([]);
  });
});

describe('sanitizeSettings', () => {
  it('缺失的嵌套对象 / 数组 / 非法枚举全部补默认', () => {
    const s = sanitizeSettings({ layout: 'x', theme: 42 });
    expect(s.layout).toBe('classic');
    expect(s.theme).toBe('cinema');
    expect(s.network.metadataEnabled).toBe(false);
    expect(s.sound.enabled).toBe(true);
    expect(s.padMap).toBeTruthy();
  });

  it('已有合法值不被覆盖', () => {
    const s = sanitizeSettings({
      theme: 'sakura',
      layout: 'wall',
    });
    expect(s.theme).toBe('sakura');
    expect(s.layout).toBe('wall');
  });

  it('完全不是对象时也能返回可用设置', () => {
    const s = sanitizeSettings('oops');
    expect(s.libraryRoots).toEqual([]);
  });

  it('游戏库目录：缺失补空数组，非字符串 / 空白项剔除，合法路径保留', () => {
    expect(sanitizeSettings({}).libraryRoots).toEqual([]);
    const s = sanitizeSettings({
      libraryRoots: ['D:\\Games', '', '  ', 42, null, 'E:/VN'],
    });
    expect(s.libraryRoots).toEqual(['D:\\Games', 'E:/VN']);
  });

  it('手柄手感缺失补默认；越界 / NaN 逐字段收敛', () => {
    const s = sanitizeSettings({});
    expect(s.padTuning).toEqual({
      deadzone: 0.28,
      repeatMs: 60,
      mouseSpeed: 11,
    });

    const bad = sanitizeSettings({
      padTuning: { deadzone: 9, repeatMs: -1, mouseSpeed: 'fast' },
    });
    expect(bad.padTuning!.deadzone).toBe(0.45);
    expect(bad.padTuning!.repeatMs).toBe(40);
    expect(bad.padTuning!.mouseSpeed).toBe(11);
  });

  it('手柄手感合法值原样保留', () => {
    const s = sanitizeSettings({
      padTuning: {
        deadzone: 0.38,
        repeatMs: 120,
        mouseSpeed: 6,
      },
    });
    expect(s.padTuning).toEqual({
      deadzone: 0.38,
      repeatMs: 120,
      mouseSpeed: 6,
    });
  });
});

describe('sanitizeMetaCandidates', () => {
  it('丢弃来源未知 / 缺 key / 缺标题的候选', () => {
    const ok = {
      source: 'bangumi',
      key: '1',
      title: 'X',
      original: null,
      year: 2009,
      score: 92,
      summary: null,
      thumb: null,
      egs: null,
    };
    const bad = [
      {},
      // 未知来源（后端只认三源）
      { ...ok, source: 'vndb' },
      { ...ok, key: '' },
      { ...ok, title: 42 },
      ok,
      null,
    ];
    expect(sanitizeMetaCandidates(bad)).toEqual([ok]);
    expect(sanitizeMetaCandidates('x')).toEqual([]);
  });
});

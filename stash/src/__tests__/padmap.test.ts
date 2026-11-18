/** 手柄键位归一化：非法键名收敛 + 撞键去重（与 Rust Settings::normalized 同规则）。 */

import { describe, expect, it } from 'vitest';
import { PAD_DEFAULT, dedupePadMap, normalizePadMap } from '../padmap';
import type { PadMap } from '../types';

const unique = (m: PadMap): boolean => new Set(Object.values(m)).size === Object.keys(m).length;

describe('手柄键位去重', () => {
  it('旧配置占用 L3 时，新默认的 random 让位到第一颗空闲备用键', () => {
    const m = normalizePadMap({ padMap: { ...PAD_DEFAULT, y: 'l3' } });
    expect(m.y).toBe('l3');
    expect(m.random).toBe('r3');
    expect(unique(m)).toBe(true);
  });

  it('A/B 互换后不会与 random 撞键', () => {
    // 捕获把 random 绑到 A、accept 让位到 L3，再打开 A/B 互换
    const map: PadMap = { ...PAD_DEFAULT, accept: 'l3', random: 'south' };
    const m = dedupePadMap({ ...map, accept: 'east', back: 'south' });
    expect(m.back).toBe('south');
    expect(m.random).toBe('l3');
    expect(unique(m)).toBe(true);
  });

  it('非法键名回落默认值', () => {
    const m = dedupePadMap({ ...PAD_DEFAULT, menu: 'guide' });
    expect(m.menu).toBe('start');
    expect(unique(m)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { fmtFileTime, humanSize } from '../screens/files';

describe('文件浏览器格式化', () => {
  it('humanSize 覆盖 B / KB / MB / GB 与异常值', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(2048)).toBe('2.0 KB');
    expect(humanSize(1024 * 1024 * 3)).toBe('3.0 MB');
    expect(humanSize(1024 * 1024 * 1024 * 12)).toBe('12 GB');
    expect(humanSize(Number.NaN)).toBe('0 B');
  });

  it('fmtFileTime 对 0 / 非法值返回空串', () => {
    expect(fmtFileTime(0)).toBe('');
    expect(fmtFileTime(Number.NaN)).toBe('');
    expect(fmtFileTime(1700000000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fsList: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../ipc', () => ({
  fsList: mocks.fsList,
}));

vi.mock('../prompt', () => ({ promptInput: vi.fn() }));

vi.mock('../nav', () => ({ registerHandler: () => {} }));

vi.mock('../state', () => {
  const state = { screen: 'files' as string };
  return { state, setScreen: () => {} };
});

vi.mock('../ui', () => ({
  esc: (s: string) => s,
  toast: mocks.toast,
}));

// 模拟 chunk 加载失败：files.ts 的动态 import 会以 rejection 结束
vi.mock('../screens/settings/actions', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

import { initFiles, openFiles } from '../screens/files';

const EXE = {
  name: 'Game.exe',
  path: 'C:\\Games\\Game.exe',
  isDir: false,
  size: 1024,
  modified: 0,
  hidden: false,
};

describe('文件浏览器：入库模块加载失败', () => {
  it('动态 import 抛错时给出可重试提示，不产生未处理 rejection', async () => {
    mocks.fsList.mockResolvedValue({
      path: 'C:\\Games',
      parent: 'C:\\',
      entries: [EXE],
      drives: [],
      truncated: false,
    });
    initFiles();
    await openFiles('C:\\Games');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' }));

    // 若异常漏出，vitest 会直接报 unhandled rejection，这个 waitFor 也等不到提示
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenLastCalledWith(
        expect.stringContaining('加入游戏库失败'),
        true
      )
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
});

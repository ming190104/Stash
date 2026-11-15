// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fsList: vi.fn(),
}));

vi.mock('../ipc', () => ({
  fsList: mocks.fsList,
}));

vi.mock('../nav', () => ({ registerHandler: () => {} }));

vi.mock('../state', () => {
  const state = { screen: 'settings' as string };
  return {
    state,
    setScreen: (s: string) => {
      state.screen = s;
    },
  };
});

vi.mock('../ui', () => ({
  esc: (s: string) => s,
  toast: () => {},
}));

const DRIVES = {
  path: null,
  parent: null,
  entries: [],
  drives: [{ name: 'C:', path: 'C:\\' }],
  truncated: false,
};

function dir(path: string, parent: string | null) {
  return { path, parent, entries: [], drives: [], truncated: false };
}

/** 重新加载模块：lastPath / loading 等都是模块级状态，用例之间必须隔离 */
async function fresh() {
  vi.resetModules();
  return import('../screens/files');
}

describe('文件浏览器：上次目录', () => {
  beforeEach(() => {
    mocks.fsList.mockReset();
  });

  it('首次进入列盘符；退出前浏览的目录会被记住', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? dir(p, 'C:\\') : DRIVES
    );
    const { openFiles } = await fresh();

    await openFiles();
    expect(mocks.fsList).toHaveBeenLastCalledWith(null);

    await openFiles('C:\\Games');
    expect(mocks.fsList).toHaveBeenLastCalledWith('C:\\Games');

    // 退出只能从盘符视图发生：这一跳不能覆盖记忆
    await openFiles(null);
    expect(mocks.fsList).toHaveBeenLastCalledWith(null);

    await openFiles();
    expect(mocks.fsList).toHaveBeenLastCalledWith('C:\\Games');
  });

  it('目标目录失效时清掉记忆，下次直接列盘符', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? dir(p, 'C:\\') : DRIVES
    );
    const { openFiles } = await fresh();
    await openFiles('C:\\Gone');

    // 目录被删 / 盘符拔出
    mocks.fsList.mockImplementation(async (p?: string | null) => {
      if (p) throw new Error('目录不存在');
      return DRIVES;
    });
    mocks.fsList.mockClear();

    await openFiles();
    expect(mocks.fsList).toHaveBeenNthCalledWith(1, 'C:\\Gone');
    expect(mocks.fsList).toHaveBeenLastCalledWith(null);

    mocks.fsList.mockClear();
    await openFiles();
    // 记忆已清：只列一次盘符，不会先对失效目录失败一次
    expect(mocks.fsList).toHaveBeenCalledTimes(1);
    expect(mocks.fsList).toHaveBeenLastCalledWith(null);
  });

  it('只是在盘符视图停留，不会覆盖已记住的目录', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? dir(p, 'C:\\') : DRIVES
    );
    const { openFiles } = await fresh();

    await openFiles('D:\\VN');
    await openFiles(null);
    await openFiles();

    expect(mocks.fsList).toHaveBeenLastCalledWith('D:\\VN');
  });
});

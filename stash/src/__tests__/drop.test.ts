// @vitest-environment happy-dom
/** 拖拽入库（drop.ts）：exe 过滤 / 去重、单部与混合拖入、重复目录定位、非 exe 跳过提示，
 *  以及浏览器预览下订阅为空操作。 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { game, mountSkeleton, resetState } from './dom-skeleton';
import { state } from '../state';

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  addGame: vi.fn(async (_exe: string, _title: string) => ({ id: 'n', title: '新作', dir: 'D:\\VN\\New' })),
  getLibrary: vi.fn(async (): Promise<unknown[]> => []),
  detailBackground: vi.fn(async (_id: string, _f?: boolean): Promise<string | null> => null),
  asset: vi.fn(async (p: string) => `asset://${p}`),
}));

vi.mock('../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc')>();
  return {
    ...actual,
    TAURI: false,
    addGame: H.addGame,
    getLibrary: H.getLibrary,
    detailBackground: H.detailBackground,
    asset: H.asset,
  };
});

vi.mock('../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui')>();
  return { ...actual, toast: H.toast };
});

import { importDropped, initDropImport, isGameExe, resetDropState, uniqueExePaths } from '../drop';

const lastToast = (): string => String(H.toast.mock.calls[H.toast.mock.calls.length - 1]?.[0] ?? '');
const toastLog = (): string => H.toast.mock.calls.map((c) => String(c[0])).join('｜');

beforeAll(() => {
  mountSkeleton();
  document.getElementById('app')!.insertAdjacentHTML(
    'beforeend',
    `<div id="railTrack"></div><div id="gridCards"></div><div id="listRows"></div>
     <div id="detailArt"></div><div id="kvArt"></div><div id="dCover"></div>
     <div id="dInfo"></div><div id="dSide"></div><div id="gameCount"></div><div id="gameCount2"></div>`,
  );
});

beforeEach(() => {
  resetState();
  H.toast.mockClear();
  H.addGame.mockResolvedValue({ id: 'n', title: '新作', dir: 'D:\\VN\\New' });
  H.getLibrary.mockImplementation(async () => state.games.map((g) => ({ ...g })));
  state.games = [];
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('on'));
  document.querySelector('.screen[data-s="library"]')!.classList.add('on');
});

describe('路径过滤', () => {
  it('只认 .exe，大小写不敏感；文件夹 / 备份名不算', () => {
    expect(isGameExe('D:\\VN\\Kanon\\game.exe')).toBe(true);
    expect(isGameExe('D:\\VN\\Kanon\\GAME.EXE')).toBe(true);
    expect(isGameExe('D:\\VN\\Kanon')).toBe(false);
    expect(isGameExe('D:\\VN\\Kanon\\game.exe.bak')).toBe(false);
  });

  it('批量去重按 Windows 语义（大小写不敏感），并剔除路径外内容', () => {
    expect(uniqueExePaths(['D:\\A\\g.exe', 'd:\\a\\G.EXE', 'D:\\A', 'D:\\B\\h.exe'])).toEqual([
      'D:\\A\\g.exe',
      'D:\\B\\h.exe',
    ]);
    expect(uniqueExePaths([])).toEqual([]);
  });
});

describe('拖入后入库', () => {
  it('单个 exe：标题按目录推断，入库后刷新并提示', async () => {
    H.addGame.mockResolvedValueOnce({ id: 'n', title: 'Kanon', dir: 'D:\\VN\\Kanon' });
    await importDropped(['D:\\VN\\Kanon\\game.exe']);
    expect(H.addGame).toHaveBeenCalledWith('D:\\VN\\Kanon\\game.exe', 'Kanon');
    expect(H.getLibrary).toHaveBeenCalled();
    expect(toastLog()).toContain('已添加《Kanon》');
  });

  it('混入文件夹与重复路径：只统计非 exe，重复路径不误报', async () => {
    await importDropped(['D:\\A\\g.exe', 'D:\\A\\G.EXE', 'D:\\A', 'D:\\B\\h.exe']);
    expect(H.addGame).toHaveBeenCalledTimes(2);
    expect(lastToast()).toContain('已跳过 1 个非 exe 文件');
  });

  it('没有 exe：一次提示，不触发入库', async () => {
    await importDropped(['D:\\A', 'D:\\B\\cover.png']);
    expect(H.addGame).not.toHaveBeenCalled();
    expect(lastToast()).toContain('没有 .exe 主程序');
  });

  it('空列表：提示没有可入库文件', async () => {
    await importDropped([]);
    expect(lastToast()).toContain('没有可入库的文件');
  });

  it('重复目录：不弹红条，直接打开库里那部', async () => {
    state.games = [game('old', { title: '旧作', dir: 'D:\\VN\\Old' })];
    H.addGame.mockRejectedValueOnce({ code: 'alreadyInLibrary', message: '该目录已在库中' });
    await importDropped(['D:\\VN\\Old\\game.exe']);
    await vi.waitFor(() => expect(state.detailId).toBe('old'));
    expect(toastLog()).toContain('已在库中，已打开详情');
    expect(toastLog()).not.toContain('该目录已在库中');
  });

  it('其他入库失败：按原消息提示并继续处理后续文件', async () => {
    H.addGame.mockRejectedValueOnce({ message: '权限不足' }).mockResolvedValueOnce({
      id: 'ok',
      title: '第二部',
      dir: 'D:\\VN\\B',
    });
    await importDropped(['D:\\VN\\A\\a.exe', 'D:\\VN\\B\\b.exe']);
    expect(H.addGame).toHaveBeenCalledTimes(2);
    expect(toastLog()).toContain('权限不足');
    expect(toastLog()).toContain('已添加《第二部》');
  });

  it('并发 drop：第一轮未完成时第二轮直接放弃，不重复入库', async () => {
    let release!: (v: { id: string; title: string; dir: string }) => void;
    H.addGame.mockImplementationOnce(
      () =>
        new Promise<{ id: string; title: string; dir: string }>((res) => {
          release = res;
        }),
    );
    const first = importDropped(['D:\\VN\\A\\a.exe']);
    const second = importDropped(['D:\\VN\\B\\b.exe']);
    await expect(second).resolves.toBe(0);
    expect(toastLog()).toContain('已有拖拽入库在进行中');
    expect(H.addGame).toHaveBeenCalledTimes(1);
    release({ id: 'a', title: 'A', dir: 'D:\\VN\\A' });
    await expect(first).resolves.toBe(1);
    expect(H.addGame).toHaveBeenCalledTimes(1);
  });
});

describe('订阅兜底', () => {
  it('浏览器预览（TAURI=false）下订阅是空操作，可重复调用', async () => {
    resetDropState();
    await expect(initDropImport()).resolves.toBeUndefined();
    await expect(initDropImport()).resolves.toBeUndefined();
    expect(H.addGame).not.toHaveBeenCalled();
  });
});

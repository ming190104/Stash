// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fsList: vi.fn(),
  promptInput: vi.fn(),
  promptConfirm: vi.fn(),
  addLibraryRoot: vi.fn(),
  previewLibraryRoot: vi.fn(),
  importLibraryRoot: vi.fn(),
  addGameByExe: vi.fn(),
  suggestTitle: vi.fn(),
  refreshLibrary: vi.fn(),
  toast: vi.fn(),
  setScreen: vi.fn(),
  state: { screen: 'files' as string, settings: { libraryRoots: [] as string[] } },
  navHandler: null as null | ((n: { intent: string; dir?: string }) => void),
}));

vi.mock('../ipc', () => ({
  fsList: mocks.fsList,
  addLibraryRoot: mocks.addLibraryRoot,
  previewLibraryRoot: mocks.previewLibraryRoot,
  importLibraryRoot: mocks.importLibraryRoot,
}));

vi.mock('../prompt', () => ({
  promptInput: mocks.promptInput,
  promptConfirm: mocks.promptConfirm,
}));

vi.mock('../screens/library', () => ({ refreshLibrary: mocks.refreshLibrary }));

vi.mock('../screens/settings/actions', () => ({
  addGameByExe: mocks.addGameByExe,
  suggestTitle: mocks.suggestTitle,
}));

vi.mock('../nav', () => ({
  registerHandler: (_s: string, h: (n: { intent: string; dir?: string }) => void) => {
    mocks.navHandler = h;
  },
}));

vi.mock('../state', () => ({
  state: mocks.state,
  setScreen: mocks.setScreen,
}));

vi.mock('../ui', () => ({
  esc: (s: string) => s,
  toast: mocks.toast,
}));

import { initFiles, openFiles } from '../screens/files';

const DRIVES = {
  path: null,
  parent: null,
  entries: [],
  drives: [{ name: 'C:', path: 'C:\\' }],
  truncated: false,
};

function listing(path: string, entries: unknown[]) {
  return { path, parent: 'C:\\', entries, drives: [], truncated: false };
}

function file(name: string, dir: string) {
  return {
    name,
    path: `${dir}\\${name}`,
    isDir: false,
    size: 1024,
    modified: null,
    hidden: false,
  };
}

function folder(name: string, dir: string) {
  return {
    name,
    path: `${dir}\\${name}`,
    isDir: true,
    size: 0,
    modified: null,
    hidden: false,
  };
}

/** 焦点在第一项：加载目录后按 X，触发「加入游戏库」 */
function pressX() {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' }));
}

describe('文件浏览器：加入游戏库', () => {
  beforeAll(() => {
    initFiles();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.state.screen = 'files';
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, []) : DRIVES
    );
  });

  it('选中 exe 按 X：按推断标题确认后入库，并回到库屏', async () => {
    const exe = file('妹妹母娘.exe', 'C:\\Games');
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, [exe]) : DRIVES
    );
    mocks.suggestTitle.mockReturnValue('妹妹母娘');
    mocks.promptInput.mockResolvedValue('妹妹母娘');
    mocks.addGameByExe.mockResolvedValue(true);

    await openFiles('C:\\Games');
    pressX();

    await vi.waitFor(() =>
      expect(mocks.addGameByExe).toHaveBeenCalledWith(
        'C:\\Games\\妹妹母娘.exe',
        '妹妹母娘'
      )
    );
    expect(mocks.suggestTitle).toHaveBeenCalledWith('C:\\Games\\妹妹母娘.exe');
    expect(mocks.addGameByExe).toHaveBeenCalledTimes(1);
    expect(mocks.setScreen).toHaveBeenCalledWith('library');
  });

  it('选中 exe 按 A：与 X 一致加入游戏库，不打开外部程序', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, [file('Game.exe', 'C:\\Games')]) : DRIVES
    );
    mocks.suggestTitle.mockReturnValue('Game');
    mocks.promptInput.mockResolvedValue('Game');
    mocks.addGameByExe.mockResolvedValue(true);

    await openFiles('C:\\Games');
    mocks.navHandler?.({ intent: 'accept' });

    await vi.waitFor(() =>
      expect(mocks.addGameByExe).toHaveBeenCalledWith('C:\\Games\\Game.exe', 'Game')
    );
    expect(mocks.setScreen).toHaveBeenCalledWith('library');
  });

  it('在标题弹层里取消：不写库、不切屏', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, [file('Game.exe', 'C:\\Games')]) : DRIVES
    );
    mocks.promptInput.mockResolvedValue(null);

    await openFiles('C:\\Games');
    pressX();

    await vi.waitFor(() => expect(mocks.promptInput).toHaveBeenCalled());
    expect(mocks.addGameByExe).not.toHaveBeenCalled();
    // openFiles 自己会切到 files 屏，这里只关心没有被带去库屏
    expect(mocks.setScreen).not.toHaveBeenCalledWith('library');
  });

  it('焦点在目录 / 非 exe 上：提示先选主程序，不弹标题', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, [folder('savedata', 'C:\\Games'), file('readme.txt', 'C:\\Games')]) : DRIVES
    );

    await openFiles('C:\\Games');
    pressX(); // 焦点：目录
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenLastCalledWith(
        expect.stringContaining('请选中游戏主程序'),
        true
      )
    );

    // 焦点下移到 readme.txt：同样不该入库
    mocks.toast.mockClear();
    mocks.navHandler?.({ intent: 'move', dir: 'down' });
    pressX();
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenLastCalledWith(
        expect.stringContaining('请选中游戏主程序'),
        true
      )
    );
    expect(mocks.promptInput).not.toHaveBeenCalled();
  });

  it('重复添加（返回 false）：留在文件屏，不切到库屏', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, [file('Game.exe', 'C:\\Games')]) : DRIVES
    );
    mocks.promptInput.mockResolvedValue('Game');
    mocks.addGameByExe.mockResolvedValue(false);

    await openFiles('C:\\Games');
    pressX();

    await vi.waitFor(() => expect(mocks.addGameByExe).toHaveBeenCalled());
    expect(mocks.setScreen).not.toHaveBeenCalledWith('library');
  });

  it('G：当前目录设为库根，跳过已在库候选后批量导入', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, [folder('A', 'C:\\Games'), folder('B', 'C:\\Games')]) : DRIVES
    );
    mocks.promptConfirm.mockResolvedValue(true);
    mocks.addLibraryRoot.mockResolvedValue([
      { dir: 'C:\\Games\\A', exe: 'C:\\Games\\A\\a.exe', title: 'A', engine: 'Ren\'Py', inLibrary: false },
      { dir: 'C:\\Games\\B', exe: 'C:\\Games\\B\\b.exe', title: 'B', engine: 'KiriKiri', inLibrary: true },
    ]);
    mocks.importLibraryRoot.mockResolvedValue({
      root: 'C:\\Games',
      report: { total: 1, added: 1, removed: 0, updated: 0, durationMs: 12 },
    });

    await openFiles('C:\\Games');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG' }));

    await vi.waitFor(() =>
      expect(mocks.importLibraryRoot).toHaveBeenCalledWith('C:\\Games', [
        { dir: 'C:\\Games\\A', exe: 'C:\\Games\\A\\a.exe', title: 'A' },
      ])
    );
    expect(mocks.addLibraryRoot).toHaveBeenCalledWith('C:\\Games');
    expect(mocks.refreshLibrary).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('已加入库根，导入 1 部');
  });

  it('Y：手柄「整目录入库」与 G 等价', async () => {
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, [folder('A', 'C:\\Games')]) : DRIVES
    );
    mocks.promptConfirm.mockResolvedValue(true);
    mocks.addLibraryRoot.mockResolvedValue([
      { dir: 'C:\\Games\\A', exe: 'C:\\Games\\A\\a.exe', title: 'A', engine: 'Ren\'Py', inLibrary: false },
    ]);
    mocks.importLibraryRoot.mockResolvedValue({
      root: 'C:\\Games',
      report: { total: 1, added: 1, removed: 0, updated: 0, durationMs: 5 },
    });

    await openFiles('C:\\Games');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyY' }));

    await vi.waitFor(() => expect(mocks.addLibraryRoot).toHaveBeenCalledWith('C:\\Games'));
    expect(mocks.importLibraryRoot).toHaveBeenCalled();
  });

  it('G：目录已是库根时只重新扫描，不重复添加', async () => {
    mocks.state.settings.libraryRoots = ['C:\\Games'];
    mocks.fsList.mockImplementation(async (p?: string | null) =>
      p ? listing(p, []) : DRIVES
    );
    mocks.promptConfirm.mockResolvedValue(true);
    mocks.previewLibraryRoot.mockResolvedValue([]);

    await openFiles('C:\\Games');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG' }));

    await vi.waitFor(() => expect(mocks.previewLibraryRoot).toHaveBeenCalledWith('C:\\Games'));
    expect(mocks.addLibraryRoot).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('已加入库根，没有发现新作品');
    mocks.state.settings.libraryRoots = [];
  });
});

// @vitest-environment happy-dom
/** 设置屏动作（settings/actions.ts）：手动入库与重复定位、导入导出回滚、
 *  诊断 / 目录 / 网络 / 匹配入口的成败分支。此前 module 覆盖率不足 8%。 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { game, mountSkeleton, resetState } from './dom-skeleton';
import { state } from '../state';
import { hideStates } from '../overlay';

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  prompt: vi.fn(async (_o: unknown): Promise<string | null> => null),
  pickExeFile: vi.fn(async (): Promise<string | null> => null),
  addGame: vi.fn(async (_exe: string, _title: string) => ({ id: 'n', title: '新作', dir: 'D:\\VN\\New' })),
  pickSavePath: vi.fn(async (_n: string): Promise<string | null> => null),
  exportData: vi.fn(async (_p: string) => 4),
  pickJsonFile: vi.fn(async (): Promise<string | null> => null),
  importData: vi.fn(async (_p: string) => 3),
  getSettings: vi.fn(async () => ({
    theme: 'dark',
    layout: 'classic',
    sort: 'title',
    motion: 0,
    verticalTitle: true,
    fontScale: 1,
    fullscreen: false,
    network: { metadataEnabled: false },
  })),
  updateSettings: vi.fn(async (_s: unknown) => undefined),
  setFullscreen: vi.fn(async (_on: boolean) => undefined),
  getLibrary: vi.fn(async (): Promise<unknown[]> => []),
  openAppDir: vi.fn(async (_k: string) => undefined),
  exportDiagnostics: vi.fn(async () => 'D:\\data\\diagnostics\\report.json'),
  testNetwork: vi.fn(async () => '连接正常'),
  cancelMatch: vi.fn(async () => undefined),
  matchAll: vi.fn(async () => undefined),
  runBaseline: vi.fn(async () => ['CPU 18%', '内存 120MB']),
  runHealth: vi.fn(async () => undefined),
  detailBackground: vi.fn(async (_id: string, _f?: boolean): Promise<string | null> => null),
  asset: vi.fn(async (p: string) => `asset://${p}`),
}));

vi.mock('../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc')>();
  return {
    ...actual,
    TAURI: false,
    pickExeFile: H.pickExeFile,
    addGame: H.addGame,
    pickSavePath: H.pickSavePath,
    exportData: H.exportData,
    pickJsonFile: H.pickJsonFile,
    importData: H.importData,
    getSettings: H.getSettings,
    updateSettings: H.updateSettings,
    setFullscreen: H.setFullscreen,
    getLibrary: H.getLibrary,
    openAppDir: H.openAppDir,
    exportDiagnostics: H.exportDiagnostics,
    testNetwork: H.testNetwork,
    cancelMatch: H.cancelMatch,
    matchAll: H.matchAll,
    onEvent: async () => () => undefined,
    detailBackground: H.detailBackground,
    asset: H.asset,
  };
});

vi.mock('../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui')>();
  return {
    ...actual,
    toast: H.toast,
    applyTheme: vi.fn(),
    applyLayout: vi.fn(),
    applyMotion: vi.fn(),
    applyFontScale: vi.fn(),
  };
});

vi.mock('../sfx', () => ({ applySoundSettings: vi.fn() }));
vi.mock('../fps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fps')>();
  return { ...actual, runBaseline: H.runBaseline };
});
vi.mock('../prompt', () => ({
  promptInput: H.prompt,
  promptShown: () => false,
  submitPrompt: vi.fn(),
  dismissPrompt: vi.fn(),
}));
vi.mock('../screens/settings/health', () => ({ runHealth: H.runHealth }));
vi.mock('../screens/settings/ui', () => ({ rerender: vi.fn() }));

import { addManualGame, sameDir, suggestTitle, wireActions } from '../screens/settings/actions';
import { wirePerf } from '../screens/settings/wire/perf';
import { sanitizeSettings } from '../ipc';

const lastToast = (): string => String(H.toast.mock.calls[H.toast.mock.calls.length - 1]?.[0] ?? '');
const toastLog = (): string => H.toast.mock.calls.map((c) => String(c[0])).join('｜');

beforeAll(() => {
  mountSkeleton();
  const app = document.getElementById('app')!;
  app.insertAdjacentHTML(
    'beforeend',
    `<div id="railTrack"></div><div id="gridCards"></div><div id="listRows"></div>
     <div id="detailArt"></div><div id="kvArt"></div><div id="dCover"></div>
     <div id="dInfo"></div><div id="dSide"></div><div id="gameCount"></div><div id="gameCount2"></div>
     <div id="actBar"></div>`,
  );
  const bar = document.getElementById('actBar')!;
  bar.innerHTML = ['addgame', 'export', 'import', 'baseline', 'opendata', 'openlogs', 'diagnostics', 'testnet', 'cancelmatch', 'match']
    .map((a) => `<button data-act="${a}">${a}</button>`)
    .join('');
  wireActions(bar);
  // 性能页签的全屏开关：单独挂一小块面板，避免引入整套设置渲染
  const perfBody = document.createElement('div');
  perfBody.innerHTML = '<button class="tg" id="tgFullMode"></button>';
  document.getElementById('app')!.appendChild(perfBody);
  wirePerf(perfBody);
});

beforeEach(() => {
  resetState();
  hideStates();
  H.toast.mockClear();
  H.prompt.mockResolvedValue(null);
  H.pickExeFile.mockResolvedValue(null);
  H.pickSavePath.mockResolvedValue(null);
  H.pickJsonFile.mockResolvedValue(null);
  H.getLibrary.mockImplementation(async () => state.games.map((g) => ({ ...g })));
  state.games = [game('a')];
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('on'));
  document.querySelector('.screen[data-s="library"]')!.classList.add('on');
});

const press = (act: string): void =>
  document.querySelector<HTMLElement>(`#actBar [data-act="${act}"]`)!.click();

describe('标题推断与目录比对', () => {
  it('泛化文件名 / 纯数字 / 过短名改用目录名', () => {
    expect(suggestTitle('D:\\VN\\Kanon\\game.exe')).toBe('Kanon');
    expect(suggestTitle('D:\\VN\\Kanon\\Kanon.exe')).toBe('Kanon');
    expect(suggestTitle('D:\\VN\\Kanon\\12.exe')).toBe('Kanon');
    expect(suggestTitle('D:\\x\\abc.exe')).toBe('x'); // 目录也泛化时保留文件名
    expect(suggestTitle('D:\\Games\\Clannad\\Clannad.exe')).toBe('Clannad');
    expect(suggestTitle('C:\\game.exe')).toBe('game');
  });

  it('目录比对忽略分隔符 / 尾斜杠 / 大小写', () => {
    expect(sameDir('D:/VN/Game/', 'D:\\vn\\game')).toBe(true);
    expect(sameDir('D:\\VN\\A', 'D:\\VN\\B')).toBe(false);
  });
});

describe('手动添加', () => {
  it('取消选文件或取消标题都不入库', async () => {
    await addManualGame();
    expect(H.prompt).not.toHaveBeenCalled();
    expect(H.addGame).not.toHaveBeenCalled();

    H.pickExeFile.mockResolvedValueOnce('D:\\VN\\New\\game.exe');
    H.prompt.mockResolvedValueOnce(null);
    await addManualGame();
    expect(H.addGame).not.toHaveBeenCalled();
  });

  it('空标题只提示，不调用入库', async () => {
    H.pickExeFile.mockResolvedValueOnce('D:\\VN\\New\\game.exe');
    H.prompt.mockResolvedValueOnce('   ');
    await addManualGame();
    expect(H.addGame).not.toHaveBeenCalled();
    expect(lastToast()).toContain('标题不能为空');
  });

  it('成功：默认标题按目录推断，入库后刷新并关层', async () => {
    H.pickExeFile.mockResolvedValueOnce('D:\\VN\\New\\game.exe');
    H.prompt.mockResolvedValueOnce('新作');
    await addManualGame();
    expect(H.addGame).toHaveBeenCalledWith('D:\\VN\\New\\game.exe', '新作');
    expect(H.getLibrary).toHaveBeenCalled();
    expect(toastLog()).toContain('已添加《新作》');
  });

  it('重复入库：命中同目录时直接打开详情，不报红条', async () => {
    H.pickExeFile.mockResolvedValueOnce('D:\\VN\\Old\\game.exe');
    H.prompt.mockResolvedValueOnce('旧作');
    H.addGame.mockRejectedValueOnce({ code: 'alreadyInLibrary', message: '该目录已在库中' });
    state.games = [game('old', { title: '旧作', dir: 'D:\\VN\\Old' })];
    await addManualGame();
    await vi.waitFor(() => expect(state.detailId).toBe('old'));
    expect(toastLog()).toContain('已在库中，已打开详情');
    expect(toastLog()).not.toContain('该目录已在库中');
  });

  it('重复入库：后端库比前端新时先同步状态再打开详情', async () => {
    const latest = game('latest', { title: '外部新增', dir: 'D:\\VN\\Latest' });
    state.games = [];
    H.pickExeFile.mockResolvedValueOnce('D:\\VN\\Latest\\game.exe');
    H.prompt.mockResolvedValueOnce('外部新增');
    H.addGame.mockRejectedValueOnce({ code: 'alreadyInLibrary', message: '该目录已在库中' });
    H.getLibrary.mockResolvedValueOnce([latest]);
    await addManualGame();
    expect(state.games).toEqual([latest]);
    await vi.waitFor(() => expect(state.detailId).toBe('latest'));
  });

  it('重复入库但定位不到条目时按错误提示', async () => {
    H.pickExeFile.mockResolvedValueOnce('D:\\VN\\Old\\game.exe');
    H.prompt.mockResolvedValueOnce('旧作');
    H.addGame.mockRejectedValueOnce({ code: 'alreadyInLibrary', message: '该目录已在库中' });
    state.games = [];
    await addManualGame();
    expect(lastToast()).toContain('该目录已在库中');
  });

  it('其他 IPC 失败原样提示', async () => {
    H.pickExeFile.mockResolvedValueOnce('D:\\VN\\New\\game.exe');
    H.prompt.mockResolvedValueOnce('新作');
    H.addGame.mockRejectedValueOnce({ message: '权限不足' });
    await addManualGame();
    expect(lastToast()).toContain('权限不足');
  });
});

describe('导入导出', () => {
  it('导出：取消路径不写文件；成功报数量与路径；失败红条', async () => {
    await document.querySelector<HTMLElement>('[data-act="export"]')!.click();
    expect(H.exportData).not.toHaveBeenCalled();

    H.pickSavePath.mockResolvedValueOnce('D:\\backup.json');
    H.exportData.mockResolvedValueOnce(4);
    press('export');
    await vi.waitFor(() => expect(lastToast()).toContain('已导出 4 部作品'));
    // 路径必须回显：用户下一步要去文件管理器里找这个备份
    expect(lastToast()).toContain('D:\\backup.json');

    H.pickSavePath.mockResolvedValueOnce('D:\\b2.json');
    H.exportData.mockRejectedValueOnce({ message: '磁盘只读' });
    press('export');
    await vi.waitFor(() => expect(lastToast()).toContain('磁盘只读'));
  });

  it('导入：未确认不动库；成功灌设置并刷新；键位下发失败只降级提示', async () => {
    H.pickJsonFile.mockResolvedValueOnce('D:\\backup.json');
    H.prompt.mockResolvedValueOnce('取消');
    press('import');
    await vi.waitFor(() => expect(H.prompt).toHaveBeenCalled());
    expect(H.importData).not.toHaveBeenCalled();

    H.pickJsonFile.mockResolvedValueOnce('D:\\backup.json');
    H.prompt.mockResolvedValueOnce('确认');
    H.importData.mockResolvedValueOnce(3);
    H.updateSettings.mockRejectedValueOnce(new Error('键位保存失败'));
    H.getLibrary.mockResolvedValueOnce([game('a'), game('b')]);
    press('import');
    await vi.waitFor(() => expect(H.importData).toHaveBeenCalledWith('D:\\backup.json'));
    await vi.waitFor(() => expect(state.games.length).toBe(2));
    expect(toastLog()).toContain('设置已导入，但手柄键位未能即时生效');
    expect(toastLog()).toContain('已导入 3 部作品');
  });

  it('导入失败：保留原库并提示', async () => {
    H.pickJsonFile.mockResolvedValueOnce('D:\\bad.json');
    H.prompt.mockResolvedValueOnce('确认');
    H.importData.mockRejectedValueOnce({ message: '不是有效的备份文件' });
    state.games = [game('a')];
    press('import');
    await vi.waitFor(() => expect(lastToast()).toContain('不是有效的备份文件'));
    expect(state.games.length).toBe(1);
  });
});

describe('诊断与网络动作', () => {
  it('目录 / 诊断：成功与失败都有提示', async () => {
    press('opendata');
    await vi.waitFor(() => expect(lastToast()).toContain('已打开数据目录'));
    H.openAppDir.mockRejectedValueOnce({ message: '被占用' });
    press('openlogs');
    await vi.waitFor(() => expect(lastToast()).toContain('被占用'));

    press('diagnostics');
    await vi.waitFor(() => expect(lastToast()).toContain('诊断报告已导出：report.json'));
    H.exportDiagnostics.mockRejectedValueOnce({ message: '无写权限' });
    press('diagnostics');
    await vi.waitFor(() => expect(lastToast()).toContain('无写权限'));
  });

  it('基线测试把结果拼成一行；健康检查直接转交', async () => {
    press('baseline');
    await vi.waitFor(() => expect(lastToast()).toContain('CPU 18%'));
    expect(lastToast()).toContain('内存 120MB');
    press('diagnostics');
    await vi.waitFor(() => expect(H.exportDiagnostics).toHaveBeenCalled());
    press('baseline');
    await vi.waitFor(() => expect(H.runBaseline).toHaveBeenCalledTimes(2));
  });

  it('测网成功 / 失败', async () => {
    press('testnet');
    await vi.waitFor(() => expect(lastToast()).toContain('连接正常'));

    H.testNetwork.mockRejectedValueOnce({ message: '超时' });
    press('testnet');
    await vi.waitFor(() => expect(lastToast()).toContain('超时'));
  });

  it('测网结果按纯文本转义后再交给 HTML toast', async () => {
    H.testNetwork.mockResolvedValueOnce('连接正常 <img src=x onerror="boom"> & 完成');
    press('testnet');
    await vi.waitFor(() => expect(lastToast()).toContain('&lt;img'));
    expect(lastToast()).toBe('连接正常 &lt;img src=x onerror=&quot;boom&quot;&gt; &amp; 完成');
  });

  it('没有匹配在跑时点取消只提示；浏览器预览下启动匹配被拒绝', async () => {
    press('cancelmatch');
    await vi.waitFor(() => expect(lastToast()).toContain('当前没有进行中的匹配'));
    press('match');
    await vi.waitFor(() => expect(lastToast()).toContain('浏览器预览'));
    expect(H.matchAll).not.toHaveBeenCalled();
  });

  it('动作抛错（非 IPC 约定）也被兜成红条', async () => {
    H.pickExeFile.mockRejectedValueOnce(new Error('对话框插件缺失'));
    press('addgame');
    await vi.waitFor(() => expect(lastToast()).toContain('对话框插件缺失'));
  });
});

describe('性能页签 · 全屏开关', () => {
  it('落盘失败时按钮 / 设置 / 窗口一起回退', async () => {
    // 逻辑测试不等转场：直接按「减少动态效果」走，warpToggle 同步完成
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const base = sanitizeSettings({ fullscreen: false });
    state.settings = { ...base };
    // 落盘失败后 persist 按磁盘值回滚，这里让磁盘值也是「关闭」
    H.getSettings.mockResolvedValueOnce({ ...base, fontScale: base.fontScale ?? 1 });
    H.updateSettings.mockRejectedValueOnce(new Error('磁盘只读'));
    H.setFullscreen.mockClear();

    const btn = document.getElementById('tgFullMode') as HTMLButtonElement;
    expect(btn.classList.contains('on')).toBe(false);
    btn.click();

    await vi.waitFor(() => expect(lastToast()).toContain('磁盘只读'));
    expect(state.settings!.fullscreen).toBe(false);
    expect(btn.classList.contains('on')).toBe(false);
    // 先切到全屏，失败后再用反向值把窗口恢复回来
    expect(H.setFullscreen.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });
});

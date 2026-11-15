// @vitest-environment happy-dom
/** 游戏库目录：库页签渲染（根目录 / 候选清单）+ 添加 / 扫描 / 移除 / 勾选导入链路。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { game, mountSkeleton, resetState } from './dom-skeleton';
import { state } from '../state';
import type { Settings } from '../types';
import { libraryTabHTML, setPreview, setSteamPreview, getSteamPreview } from '../screens/settings-tabs/library';

const H = vi.hoisted(() => ({
  pickFolder: vi.fn(async (): Promise<string | null> => 'D:\\Games'),
  addLibraryRoot: vi.fn(async (_p: string): Promise<unknown[]> => []),
  previewLibraryRoot: vi.fn(async (_p: string): Promise<unknown[]> => []),
  importLibraryRoot: vi.fn(async (_p: string, _picks: unknown[]) => ({
    root: 'D:\\Games',
    report: { total: 1, added: 1, removed: 0, updated: 0, durationMs: 1 },
  })),
  removeLibraryRoot: vi.fn(async (_p: string) => undefined),
  scanSteam: vi.fn(async () => [
    {
      appId: 100,
      name: 'Steam VN',
      dir: 'D:\\SteamLibrary\\steamapps\\common\\SteamVN',
      exe: 'D:\\SteamLibrary\\steamapps\\common\\SteamVN\\vn.exe',
      engine: '吉里吉里',
      inLibrary: false,
    },
    {
      appId: 200,
      name: 'Already In Library',
      dir: 'D:\\SteamLibrary\\steamapps\\common\\Old',
      exe: 'D:\\SteamLibrary\\steamapps\\common\\Old\\old.exe',
      engine: 'Unity',
      inLibrary: true,
    },
  ]),
  importSteam: vi.fn(async (_ids: number[]) => ({
    report: { total: 1, added: 1, removed: 0, updated: 0, durationMs: 2 },
  })),
  getSettings: vi.fn(async () => ({ libraryRoots: ['D:\\Games'] })),
  refreshLibrary: vi.fn(async () => undefined),
  rerender: vi.fn(),
}));

vi.mock('../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc')>();
  return { ...actual, ...H };
});
vi.mock('../screens/library', () => ({ refreshLibrary: H.refreshLibrary }));
vi.mock('../screens/settings/ui', () => ({ rerender: H.rerender }));

type Wire = typeof import('../screens/settings/wire/libraryTab');

function fixture(over: Partial<Settings> = {}): Settings {
  return {
    theme: 'sakura',
    layout: 'list',
    fontScale: 1,
    sound: { enabled: true, gain: 0.8 },
    abSwap: true,
    gamepadMouse: true,
    autostart: false,
    locale: { launch: false, toolPath: null },
    fullscreen: true,
    fpsMode: '60',
    power60: false,
    padMap: {},
    network: { metadataEnabled: true },
    libraryRoots: [],
    ...over,
  } as unknown as Settings;
}

function body(): HTMLElement {
  return document.getElementById('sbody')!;
}

beforeEach(() => {
  mountSkeleton();
  resetState();
  setPreview(null);
  setSteamPreview(null);
  document.body.insertAdjacentHTML('beforeend', '<div id="sbody"></div>');
  state.settings = fixture();
  vi.clearAllMocks();
});

describe('库页签 · 游戏库目录', () => {
  it('没有目录时给出空态与添加入口', () => {
    const out = libraryTabHTML('');
    expect(out).toContain('还没有添加游戏库目录');
    expect(out).toContain('data-act="addroot"');
  });

  it('已配置的目录显示名称、路径、入库部数与扫描 / 移除按钮', () => {
    state.settings = fixture({ libraryRoots: ['D:\\Games', 'E:/VN'] });
    state.games = [
      game('a', { dir: 'D:\\Games\\A' }),
      game('b', { dir: 'D:\\Games\\B' }),
      game('c', { dir: 'E:\\VN\\C' }),
    ];
    const host = document.createElement('div');
    host.innerHTML = libraryTabHTML('');
    const rows = host.querySelectorAll('[data-act="scanroot"]');
    expect(rows.length).toBe(2);
    expect(host.innerHTML).toContain('D:\\Games · 已入库 2 部');
    expect(host.innerHTML).toContain('E:/VN · 已入库 1 部');
    expect(host.querySelector('[data-act="delroot"][data-root="E:/VN"]')).toBeTruthy();
  });

  it('候选清单默认勾选新作品、已在库中的置灰且不勾选', () => {
    setPreview({
      root: 'D:\\Games',
      items: [
        { dir: 'D:\\Games\\A', exe: 'D:\\Games\\A\\a.exe', title: 'A', engine: '吉里吉里', inLibrary: false, picked: true },
        { dir: 'D:\\Games\\B', exe: 'D:\\Games\\B\\b.exe', title: 'B', engine: 'Ren\'Py', inLibrary: true, picked: false },
      ],
    });
    const host = document.createElement('div');
    host.innerHTML = libraryTabHTML('');
    const cbs = host.querySelectorAll<HTMLInputElement>('.lcand-cb');
    expect(cbs.length).toBe(2);
    expect(cbs[0].checked).toBe(true);
    expect(cbs[1].checked).toBe(false);
    expect(host.innerHTML).toContain('已在库中');
    expect(host.innerHTML).toContain('加入所选（1）');
  });
});

describe('库页签 · 目录与候选的交互', () => {
  async function mount(): Promise<Wire> {
    const w = await import('../screens/settings/wire/libraryTab');
    body().innerHTML = libraryTabHTML('');
    w.wireLibraryTab(body());
    return w;
  }

  it('点击移除只删配置并更新本地设置，作品保留', async () => {
    state.settings = fixture({ libraryRoots: ['D:\\Games'] });
    await mount();
    body().querySelector<HTMLElement>('[data-act="delroot"]')!.click();
    await vi.waitFor(() => expect(H.removeLibraryRoot).toHaveBeenCalledWith('D:\\Games'));
    expect(state.settings!.libraryRoots).toEqual([]);
    expect(state.games.length).toBe(0);
  });

  it('点击扫描调用 previewLibraryRoot 并展开候选', async () => {
    state.settings = fixture({ libraryRoots: ['D:\\Games'] });
    H.previewLibraryRoot.mockResolvedValueOnce([
      { dir: 'D:\\Games\\A', exe: 'D:\\Games\\A\\a.exe', title: 'A', engine: '吉里吉里', inLibrary: false },
    ]);
    await mount();
    body().querySelector<HTMLElement>('[data-act="scanroot"]')!.click();
    await vi.waitFor(() => expect(H.previewLibraryRoot).toHaveBeenCalledWith('D:\\Games'));
    await vi.waitFor(() => expect(H.rerender).toHaveBeenCalled());
    expect(libraryTabHTML('')).toContain('扫描结果 · 1 部');
  });

  it('添加目录：选文件夹 → addLibraryRoot → 重新拉设置 → 展开候选', async () => {
    H.addLibraryRoot.mockResolvedValueOnce([
      { dir: 'D:\\Games\\A', exe: 'D:\\Games\\A\\a.exe', title: 'A', engine: 'Unity', inLibrary: false },
    ]);
    await mount();
    body().querySelector<HTMLElement>('[data-act="addroot"]')!.click();
    await vi.waitFor(() => expect(H.addLibraryRoot).toHaveBeenCalledWith('D:\\Games'));
    expect(H.getSettings).toHaveBeenCalled();
    expect(H.pickFolder).toHaveBeenCalled();
  });

  it('导入只提交勾选项，并使用改过的标题', async () => {
    state.settings = fixture({ libraryRoots: ['D:\\Games'] });
    setPreview({
      root: 'D:\\Games',
      items: [
        { dir: 'D:\\Games\\A', exe: 'D:\\Games\\A\\a.exe', title: 'A', engine: '', inLibrary: false, picked: true },
        { dir: 'D:\\Games\\B', exe: 'D:\\Games\\B\\b.exe', title: 'B', engine: '', inLibrary: false, picked: true },
      ],
    });
    await mount();
    const rows = body().querySelectorAll<HTMLElement>('.pitem');
    // 取消勾选 B，把 A 的标题改成中文名
    rows[1].querySelector<HTMLInputElement>('.lcand-cb')!.checked = false;
    rows[1].querySelector<HTMLInputElement>('.lcand-cb')!.dispatchEvent(new Event('change'));
    const ti = rows[0].querySelector<HTMLInputElement>('.lcand-ti')!;
    ti.value = '中文标题';
    ti.dispatchEvent(new Event('change'));

    body().querySelector<HTMLElement>('[data-act="pickimport"]')!.click();
    await vi.waitFor(() => expect(H.importLibraryRoot).toHaveBeenCalled());
    expect(H.importLibraryRoot).toHaveBeenCalledWith('D:\\Games', [
      { dir: 'D:\\Games\\A', exe: 'D:\\Games\\A\\a.exe', title: '中文标题' },
    ]);
    expect(H.refreshLibrary).toHaveBeenCalled();
  });

  it('全选 / 取消勾选会同步按钮计数', async () => {
    state.settings = fixture({ libraryRoots: ['D:\\Games'] });
    setPreview({
      root: 'D:\\Games',
      items: [
        { dir: 'D:\\Games\\A', exe: 'D:\\Games\\A\\a.exe', title: 'A', engine: '', inLibrary: false, picked: false },
        { dir: 'D:\\Games\\B', exe: 'D:\\Games\\B\\b.exe', title: 'B', engine: '', inLibrary: false, picked: false },
      ],
    });
    await mount();
    body().querySelector<HTMLElement>('[data-act="picksel"]')!.click();
    expect(body().querySelector('[data-act="pickimport"]')!.textContent).toBe('加入所选（2）');
    body().querySelector<HTMLElement>('[data-act="picksel"]')!.click();
    expect(body().querySelector('[data-act="pickimport"]')!.textContent).toBe('加入所选（0）');
  });
});

describe('库页签 · Steam 扫描与导入', () => {
  async function mount(): Promise<Wire> {
    const w = await import('../screens/settings/wire/libraryTab');
    body().innerHTML = libraryTabHTML('');
    w.wireLibraryTab(body());
    return w;
  }

  it('渲染 Steam 扫描入口与候选（已在库中置灰且默认不勾选）', () => {
    setSteamPreview([
      {
        appId: 100,
        name: 'Steam VN',
        dir: 'D:\\SteamLibrary\\steamapps\\common\\SteamVN',
        exe: 'D:\\SteamLibrary\\steamapps\\common\\SteamVN\\vn.exe',
        engine: '吉里吉里',
        inLibrary: false,
        picked: true,
      },
      {
        appId: 200,
        name: 'Already In Library',
        dir: 'D:\\SteamLibrary\\steamapps\\common\\Old',
        exe: 'D:\\SteamLibrary\\steamapps\\common\\Old\\old.exe',
        engine: 'Unity',
        inLibrary: true,
        picked: false,
      },
    ]);
    const host = document.createElement('div');
    host.innerHTML = libraryTabHTML('');
    expect(host.querySelector('[data-act="steamscan"]')).toBeTruthy();
    expect(host.innerHTML).toContain('Steam 扫描结果 · 2 部');
    expect(host.innerHTML).toContain('已在库中');
    expect(host.innerHTML).toContain('加入所选（1）');
  });

  it('扫描后默认只勾选未入库作品，导入只提交这些 AppID', async () => {
    await mount();
    // 等上一用例的导入微任务跑完，模块级 busy 归位后再点扫描
    await new Promise((r) => setTimeout(r, 0));
    body().querySelector<HTMLElement>('[data-act="steamscan"]')!.click();
    await vi.waitFor(() => expect(H.scanSteam).toHaveBeenCalled());
    const items = getSteamPreview();
    expect(items?.map((x) => [x.appId, x.picked])).toEqual([
      [100, true],
      [200, false],
    ]);

    // 按扫描结果重渲染，再点导入
    body().innerHTML = libraryTabHTML('');
    (await import('../screens/settings/wire/libraryTab')).wireLibraryTab(body());
    body().querySelector<HTMLElement>('[data-act="steamimport"]')!.click();
    await vi.waitFor(() => expect(H.importSteam).toHaveBeenCalledWith([100]));
    await vi.waitFor(() => expect(getSteamPreview()).toBeNull());
    expect(H.refreshLibrary).toHaveBeenCalled();
  });
});

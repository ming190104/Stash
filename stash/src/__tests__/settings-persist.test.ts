// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../types';

const H = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
  renderRail: vi.fn(),
  renderGrid: vi.fn(),
  rerender: vi.fn(),
  applyTheme: vi.fn(),
  applyLayout: vi.fn(),
  applyMotion: vi.fn(),
  applyFontScale: vi.fn(),
  applyAnimSpeed: vi.fn(),
  applyBootAnim: vi.fn(),
  applySoundSettings: vi.fn(),
  state: {
    settings: null as Settings | null,
    sortBy: 'lastPlayed' as Settings['sort'],
    motion: 0,
    verticalTitle: true,
  },
}));

vi.mock('../ipc', () => ({ updateSettings: H.updateSettings, getSettings: H.getSettings }));
vi.mock('../ui', () => ({
  applyTheme: H.applyTheme,
  applyLayout: H.applyLayout,
  applyMotion: H.applyMotion,
  applyFontScale: H.applyFontScale,
  applyAnimSpeed: H.applyAnimSpeed,
  applyBootAnim: H.applyBootAnim,
}));
vi.mock('../sfx', () => ({ applySoundSettings: H.applySoundSettings }));
vi.mock('../screens/library', () => ({ renderRail: H.renderRail }));
vi.mock('../screens/grid', () => ({ renderGrid: H.renderGrid }));
vi.mock('../screens/settings/ui', () => ({ rerender: H.rerender }));
vi.mock('../state', () => ({ state: H.state }));

import { persist } from '../screens/settings/persist';

function fixture(over: Partial<Settings> = {}): Settings {
  return {
    version: 2,
    theme: 'cinema',
    layout: 'classic',
    fpsMode: 'auto',
    sort: 'lastPlayed',
    motion: 0,
    verticalTitle: true,
    autostart: false,
    fullscreen: true,
    gamepadMouse: false,
    power60: false,
    sound: { enabled: true, gain: 0.6 },
    network: { metadataEnabled: false },
    locale: { warnOnly: true, toolPath: null, launch: false },
    libraryRoots: [],
    ...over,
  };
}

describe('设置落盘', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    H.state.sortBy = 'lastPlayed';
    H.state.motion = 0;
    H.state.verticalTitle = true;
  });

  it('连续修改串行提交：旧快照不会覆盖新值', async () => {
    const local = fixture();
    H.state.settings = local;
    const resolvers: (() => void)[] = [];
    H.updateSettings.mockImplementation(
      () => new Promise<void>((resolve) => resolvers.push(resolve))
    );
    H.getSettings.mockResolvedValue(fixture());

    local.theme = 'eva01';
    const first = persist();
    await vi.waitFor(() => expect(H.updateSettings).toHaveBeenCalledTimes(1));
    expect(H.updateSettings.mock.calls[0][0]).toMatchObject({ theme: 'eva01', layout: 'classic' });

    local.layout = 'wall';
    const second = persist();
    // 第一次尚未返回：第二次必须排队，不能并发提交
    expect(H.updateSettings).toHaveBeenCalledTimes(1);

    resolvers[0]();
    await vi.waitFor(() => expect(H.updateSettings).toHaveBeenCalledTimes(2));
    // 排队的那次读到最新整份设置：主题与布局都在，不会用旧快照把布局改回去
    expect(H.updateSettings.mock.calls[1][0]).toMatchObject({ theme: 'eva01', layout: 'wall' });

    resolvers[1]();
    await Promise.all([first, second]);
  });

  it('落盘失败：按磁盘值回滚全部运行时镜像', async () => {
    const disk = fixture();
    const local = fixture();
    H.state.settings = local;
    H.state.sortBy = 'title';
    H.state.motion = 1;
    H.state.verticalTitle = false;
    local.theme = 'eva01';
    local.layout = 'wall';
    local.motion = 1;
    local.verticalTitle = false;
    local.animSpeed = 1.5;
    local.fontScale = 1.12;
    local.bootAnim = 'off';
    local.sound = { enabled: false, gain: 0.2 };
    H.updateSettings.mockRejectedValueOnce({ code: 'configInvalid', message: '保存失败' });
    H.getSettings.mockResolvedValue(disk);

    await expect(persist()).rejects.toMatchObject({ message: '保存失败' });

    expect(H.state.settings).toBe(disk);
    expect(H.state.sortBy).toBe('lastPlayed');
    expect(H.state.motion).toBe(0);
    expect(H.state.verticalTitle).toBe(true);
    expect(H.applyTheme).toHaveBeenCalledWith('cinema');
    expect(H.applyLayout).toHaveBeenCalledWith('classic');
    expect(H.applyMotion).toHaveBeenCalledWith(false);
    expect(H.applyFontScale).toHaveBeenCalledWith(undefined);
    expect(H.applyAnimSpeed).toHaveBeenCalledWith(undefined);
    expect(H.applyBootAnim).toHaveBeenCalledWith(undefined);
    expect(H.applySoundSettings).toHaveBeenCalledWith(disk);
    expect(H.renderRail).toHaveBeenCalled();
    expect(H.renderGrid).toHaveBeenCalled();
    expect(H.rerender).toHaveBeenCalled();
  });

  it('一次失败不阻断后续写入', async () => {
    const local = fixture();
    H.state.settings = local;
    H.updateSettings.mockRejectedValueOnce(new Error('磁盘只读')).mockResolvedValueOnce(undefined);
    H.getSettings.mockResolvedValue(fixture());

    await expect(persist()).rejects.toThrow('磁盘只读');

    // 回滚后 state.settings 已换成磁盘副本，后续修改要落在当前对象上
    H.state.settings!.theme = 'nerv';
    await persist();
    expect(H.updateSettings).toHaveBeenCalledTimes(2);
    expect(H.updateSettings.mock.calls[1][0]).toMatchObject({ theme: 'nerv' });
  });
});

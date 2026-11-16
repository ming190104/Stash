// @vitest-environment happy-dom
/** 关于页 · 自动更新：检查 → 下载（进度）→ 安装重启，以及运行中游戏的拦截。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  checkUpdate: vi.fn(),
  openExternal: vi.fn(async (_url: string) => undefined),
  recentLogIssues: vi.fn(async (_n: number) => [] as unknown[]),
  runningGame: vi.fn(async (): Promise<{ title: string } | null> => null),
  relaunch: vi.fn(async () => undefined),
}));

vi.mock('../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc')>();
  return {
    ...actual,
    TAURI: true,
    checkUpdate: H.checkUpdate,
    openExternal: H.openExternal,
    recentLogIssues: H.recentLogIssues,
    runningGame: H.runningGame,
  };
});
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: H.relaunch, exit: vi.fn() }));

const RELEASES = 'https://github.com/zhao1171921108-cyber/Stash/releases';

/** 插件 Update 的最小替身：版本信息 + 下载 / 安装 / 释放句柄 */
function fakeUpdate(over: Record<string, unknown> = {}) {
  return {
    version: '1.3.0',
    currentVersion: '1.2.0',
    download: vi.fn(async (cb: (e: unknown) => void) => {
      cb({ event: 'Started', data: { contentLength: 2_000_000 } });
      cb({ event: 'Progress', data: { chunkLength: 1_000_000 } });
      cb({ event: 'Finished' });
    }),
    install: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...over,
  };
}

function tip(): HTMLElement {
  return document.getElementById('updTip')!;
}

function btn(): HTMLElement {
  return document.getElementById('updBtn')!;
}

async function wire(): Promise<void> {
  const w = await import('../screens/settings/wire/about');
  w.wireAbout(document.body);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="updTip">初始</div><span id="updBtn">检查</span>';
  H.runningGame.mockResolvedValue(null);
});

describe('关于页 · 自动更新', () => {
  it('检查到新版后按钮变「更新」，再点下载安装并重启', async () => {
    const u = fakeUpdate();
    H.checkUpdate.mockResolvedValue(u);
    await wire();

    btn().click();
    await vi.waitFor(() => expect(tip().textContent).toContain('1.3.0'));
    expect(btn().textContent).toBe('更新');

    btn().click();
    await vi.waitFor(() => expect(H.relaunch).toHaveBeenCalled());
    expect(u.download).toHaveBeenCalled();
    expect(u.install).toHaveBeenCalled();
  });

  it('没有新版时明确提示已是最新', async () => {
    H.checkUpdate.mockResolvedValue(null);
    await wire();

    btn().click();
    await vi.waitFor(() => expect(tip().textContent).toContain('已是最新'));
    expect(btn().textContent).toBe('检查');
  });

  it('有游戏在运行时拒绝安装', async () => {
    const u = fakeUpdate();
    H.checkUpdate.mockResolvedValue(u);
    H.runningGame.mockResolvedValue({ title: '千恋万花' });
    await wire();

    btn().click();
    await vi.waitFor(() => expect(tip().textContent).toContain('1.3.0'));
    btn().click();
    await vi.waitFor(() => expect(tip().textContent).toContain('千恋万花'));
    expect(u.download).not.toHaveBeenCalled();
    expect(u.install).not.toHaveBeenCalled();
  });

  it('下载期间又开了游戏：放弃安装并释放更新句柄', async () => {
    const u = fakeUpdate();
    H.checkUpdate.mockResolvedValue(u);
    H.runningGame.mockResolvedValueOnce(null).mockResolvedValueOnce({ title: 'AIR' });
    await wire();

    btn().click();
    await vi.waitFor(() => expect(tip().textContent).toContain('1.3.0'));
    btn().click();
    await vi.waitFor(() => expect(tip().textContent).toContain('退出游戏后再点更新'));
    expect(u.close).toHaveBeenCalled();
    expect(u.install).not.toHaveBeenCalled();
  });

  it('检查失败留一个手动下载页出口', async () => {
    H.checkUpdate.mockRejectedValue(new Error('网络不可达'));
    await wire();

    btn().click();
    await vi.waitFor(() => expect(btn().textContent).toBe('下载页'));
    expect(tip().textContent).toContain('手动下载');

    btn().click();
    await vi.waitFor(() => expect(H.openExternal).toHaveBeenCalledWith(RELEASES));
  });
});

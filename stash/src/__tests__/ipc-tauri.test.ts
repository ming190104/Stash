// @vitest-environment happy-dom
/** Tauri 分支的核心兜底：asset 同名覆盖换 URL、onEvent 订阅失败降级、
 *  launchGame 在途去重与 20s 看门狗。
 *  TAURI 是模块加载时求值的常量，所以先注入 __TAURI_INTERNALS__ 再动态 import。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  convertFileSrc: vi.fn((p: string) => `asset://localhost/${encodeURIComponent(p)}`),
  invoke: vi.fn(),
  listen: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: h.convertFileSrc, invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: h.listen }));
// ipc.ts 在订阅失败时动态 import('./ui')：换成桩，避免拉起整棵 UI 模块
vi.mock('../ui', () => ({ toast: h.toast }));

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
const { asset, touchAsset, onEvent, launchGame } = await import('../ipc');

describe('asset', () => {
  it('同名覆盖后追加版本号，绕开 WebView 的 URL 缓存', async () => {
    const p = 'D:/data/covers/a.png';
    const first = await asset(p);
    expect(first).toContain(encodeURIComponent(p));
    expect(first).not.toContain('?v=');
    // 换封面 / 换背景都写同一个文件名：不换 URL 就会一直显示旧图
    touchAsset(p);
    expect(await asset(p)).toBe(`${first}?v=1`);
    touchAsset(p);
    expect(await asset(p)).toBe(`${first}?v=2`);
    // 版本号按路径隔离，别的图不受影响
    expect(await asset('D:/data/covers/b.png')).not.toContain('?v=');
  });
});

describe('onEvent', () => {
  it('订阅失败不外抛、返回空退订，并且只提示一次', async () => {
    h.listen.mockRejectedValue(new Error('ipc down'));
    const off1 = await onEvent('match://done', () => {});
    const off2 = await onEvent('match://error', () => {});
    expect(typeof off1).toBe('function');
    expect(() => {
      off1();
      off2();
    }).not.toThrow();
    // 提示走动态 import 的异步链，等一拍再断言；多个订阅同时挂不能刷屏
    await vi.waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(h.toast.mock.calls[0]![1]).toBe(true);
  });

  it('订阅成功时把 payload 交给回调并原样返回退订函数', async () => {
    const off = vi.fn();
    h.listen.mockImplementationOnce(async (_name: string, cb: (e: { payload: unknown }) => void) => {
      cb({ payload: { done: 1, total: 2 } });
      return off;
    });
    const got: unknown[] = [];
    const ret = await onEvent<{ done: number }>('match://progress', (p) => got.push(p));
    expect(got).toEqual([{ done: 1, total: 2 }]);
    ret();
    expect(off).toHaveBeenCalled();
  });
});

describe('launchGame', () => {
  beforeEach(() => {
    h.invoke.mockReset();
  });

  it('启动在途时静默丢弃重复按键，返回后才放行下一次', async () => {
    let release!: () => void;
    h.invoke.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const first = launchGame('a');
    const dup = launchGame('a');
    // inv() 内部是动态 import，invoke 要等模块解析完成才会真正发出
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    expect(h.invoke).toHaveBeenCalledWith('launch_game', { id: 'a' });

    release();
    await Promise.all([first, dup]);

    h.invoke.mockResolvedValueOnce(undefined);
    await launchGame('a');
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it('后端 20s 未返回时看门狗放行，旧请求晚到不会清掉新一轮的锁', async () => {
    vi.useFakeTimers();
    try {
      let releaseOld!: () => void;
      h.invoke.mockImplementationOnce(() => new Promise<void>((r) => { releaseOld = r; }));
      const old = launchGame('a');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.invoke).toHaveBeenCalledTimes(1);

      // 转区接管等异常让后端长时间不返回：20s 后必须放行下一次启动
      await vi.advanceTimersByTimeAsync(20_000);
      h.invoke.mockImplementationOnce(() => new Promise<void>(() => {}));
      void launchGame('a');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.invoke).toHaveBeenCalledTimes(2);

      // 旧请求这时才返回：token 已换，不能把新一轮的锁清掉
      releaseOld();
      await old;
      void launchGame('a');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.invoke).toHaveBeenCalledTimes(2);

      // 收尾：让第二轮也过看门狗，避免 busy 泄漏到后续用例
      await vi.advanceTimersByTimeAsync(20_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// @vitest-environment happy-dom
/** Tauri 拖拽事件订阅：失败后允许重试，成功后不重复订阅。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  onDragDropEvent: vi.fn(),
}));

vi.mock('../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc')>();
  return { ...actual, TAURI: true };
});
vi.mock('../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui')>();
  return { ...actual, toast: H.toast };
});
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: H.onDragDropEvent }),
}));

import { initDropImport, resetDropState } from '../drop';

beforeEach(() => {
  resetDropState();
  H.toast.mockClear();
  H.onDragDropEvent.mockReset();
});

describe('Tauri 拖拽订阅', () => {
  it('首次订阅失败后再次调用会重试', async () => {
    H.onDragDropEvent
      .mockRejectedValueOnce(new Error('订阅失败'))
      .mockResolvedValueOnce(() => undefined);

    await expect(initDropImport()).rejects.toThrow('订阅失败');
    await expect(initDropImport()).resolves.toBeUndefined();
    expect(H.onDragDropEvent).toHaveBeenCalledTimes(2);
  });
});

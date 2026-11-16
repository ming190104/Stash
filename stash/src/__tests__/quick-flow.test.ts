// @vitest-environment happy-dom
/** 快捷菜单（quick.ts）：条目构建（运行中 / 全屏 / 随机）、键盘导航、
 *  子菜单回退、暗底关闭与执行异常兜底。 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { game, key, mountSkeleton, resetState } from './dom-skeleton';
import { state, setScreen } from '../state';
import { hideStates, showState } from '../layers';

const H = vi.hoisted(() => ({
  toast: vi.fn(),
  promptShown: vi.fn(() => false),
  stopGame: vi.fn(async (_id: string) => undefined),
  getSettings: vi.fn(async () => ({ fullscreen: false })),
  setFullscreen: vi.fn(async (_on: boolean) => undefined),
  updateSettings: vi.fn(async (_s: unknown) => undefined),
}));

beforeAll(() => {
  // 逻辑测试不等转场：直接按「减少动态效果」走，全屏切换同步完成
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: true,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

vi.mock('../ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ipc')>();
  return {
    ...actual,
    stopGame: H.stopGame,
    getSettings: H.getSettings,
    setFullscreen: H.setFullscreen,
    updateSettings: H.updateSettings,
  };
});

vi.mock('../ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui')>();
  return { ...actual, toast: H.toast };
});

vi.mock('../prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prompt')>();
  return { ...actual, promptShown: H.promptShown };
});

import { close, handleQuickKey, openMenu, quickShown, toggleQuickMenu } from '../quick';

const item = (k: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#qmenu .qitem[data-k="${k}"]`);
const lastToast = (): string => String(H.toast.mock.calls[H.toast.mock.calls.length - 1]?.[0] ?? '');

beforeAll(() => {
  mountSkeleton();
  document.getElementById('app')!.insertAdjacentHTML('beforeend', '<div id="railTrack"></div>');
});

beforeEach(async () => {
  // 上一个用例可能还有 keepOpen 动作在 await（busy 标志是模块级的）：先让它收尾
  close();
  await new Promise((r) => window.setTimeout(r, 30));
  resetState();
  hideStates();
  H.toast.mockClear();
  H.promptShown.mockReturnValue(false);
  setScreen('library');
  state.games = [game('a'), game('b')];
});

afterEach(() => {
  close();
});

describe('条目构建与执行', () => {
  it('库屏：搜索 / 全屏 / 随机 / 设置入口齐全，再按菜单键收起', async () => {
    await toggleQuickMenu();
    expect(quickShown()).toBe(true);
    for (const k of ['search', 'full', 'random', 'settings']) {
      expect(item(k), k).not.toBeNull();
    }
    // 「关闭」项与「切换到网格视图」项已移除：退出走 B / Esc / 点暗底
    expect(item('close')).toBeNull();
    expect(item('view')).toBeNull();
    await toggleQuickMenu();
    expect(quickShown()).toBe(false);
  });

  it('运行中：出现结束入口，结束后走 stopGame', async () => {
    state.running = 'a';
    await toggleQuickMenu();
    expect(item('stop')).not.toBeNull();

    item('stop')!.click();
    await vi.waitFor(() => expect(H.stopGame).toHaveBeenCalledWith('a'));
    expect(quickShown()).toBe(false);
  });

  it('全屏 / 随机 / 设置各自生效', async () => {
    await toggleQuickMenu();
    item('full')!.click();
    await vi.waitFor(() => expect(H.setFullscreen).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(lastToast()).toContain('全屏 · 开'));

    await toggleQuickMenu();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0);
    item('random')!.click();
    await vi.waitFor(() => expect(state.focus).toBe(1));
    await vi.waitFor(() => expect(lastToast()).toContain('随机'));
    expect(quickShown()).toBe(true); // keepOpen：连续抽

    item('settings')!.click();
    expect(state.screen).toBe('settings');
  });

  it('执行异常不会留下未处理拒绝，转成红条提示', async () => {
    await toggleQuickMenu();
    H.setFullscreen.mockRejectedValueOnce({ message: '切换失败' });
    item('full')!.click();
    await vi.waitFor(() => expect(lastToast()).toContain('切换失败'));
    expect(quickShown()).toBe(false);
  });

  it('模态层打开时不叠加菜单', async () => {
    showState('filterPanel');
    await toggleQuickMenu();
    expect(quickShown()).toBe(false);
  });
});

describe('键盘与指针', () => {
  it('上下循环移动高亮，Enter 执行当前项', async () => {
    await toggleQuickMenu();
    expect(item('search')!.classList.contains('on')).toBe(true);
    expect(handleQuickKey(key('ArrowDown'))).toBe(true);
    expect(item('full')!.classList.contains('on')).toBe(true);
    expect(handleQuickKey(key('ArrowUp'))).toBe(true);
    expect(item('search')!.classList.contains('on')).toBe(true);

    expect(handleQuickKey(key('ArrowDown'))).toBe(true);
    expect(handleQuickKey(key('Enter'))).toBe(true);
    await vi.waitFor(() => expect(H.setFullscreen).toHaveBeenCalled());
  });

  it('左右键被吃掉但不移动底层焦点；输入弹层盖住时全部放行', async () => {
    await toggleQuickMenu();
    state.focus = 0;
    expect(handleQuickKey(key('ArrowRight'))).toBe(true);
    expect(state.focus).toBe(0);

    H.promptShown.mockReturnValueOnce(true);
    expect(handleQuickKey(key('ArrowDown'))).toBe(false);
  });

  it('Esc / B 关闭；子菜单先回到上一层', async () => {
    await toggleQuickMenu();
    expect(handleQuickKey(key('Escape'))).toBe(true);
    expect(quickShown()).toBe(false);

    const back = vi.fn(async () => {
      await openMenu('上一层', '测试', [{ key: 'x', label: 'x', run: () => undefined }], {});
    });
    await openMenu('子菜单', '测试', [{ key: 'y', label: 'y', run: () => undefined }], { back });
    expect(handleQuickKey(key('KeyB'))).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    expect(quickShown()).toBe(true);
  });

  it('点暗底关闭菜单，点菜单内容不关', async () => {
    await toggleQuickMenu();
    const m = document.getElementById('qmenu')!;
    item('random')!.click(); // keepOpen：点条目本身不会收菜单
    expect(quickShown()).toBe(true);
    m.click();
    expect(quickShown()).toBe(false);

    await toggleQuickMenu();
    m.querySelector<HTMLElement>('.qbox')!.click();
    expect(quickShown()).toBe(true);
  });

  it('没有选中作品 / 只有一部时，随机入口不出现', async () => {
    state.games = [game('a')];
    await toggleQuickMenu();
    expect(item('random')).toBeNull();
  });
});

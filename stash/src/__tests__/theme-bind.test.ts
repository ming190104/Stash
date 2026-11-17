// @vitest-environment happy-dom
/** 外观页：EVA 主题与 EVA 起动序列的双向绑定。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openMenu: vi.fn(),
  previewBootAnim: vi.fn(),
  persist: vi.fn(async () => undefined),
}));
vi.mock('../quick', () => ({ openMenu: mocks.openMenu }));
vi.mock('../splash', () => ({ previewBootAnim: mocks.previewBootAnim }));
vi.mock('../screens/settings/persist', () => ({ persist: mocks.persist }));

import { state } from '../state';
import { mockSettings } from '../mock';
import { cachedBootAnim, bootForTheme, themeForBoot } from '../ui';
import type { BootAnim, ThemeName } from '../types';
import { appearanceHTML } from '../screens/settings-tabs/appearance';
import { wireAppearance } from '../screens/settings/wire/appearance';

type Item = { key: string; run: () => Promise<void> };

/** 挂载外观页并返回这次用的设置对象（断言直接看它） */
function mount(theme: ThemeName, bootAnim: BootAnim) {
  const s = { ...mockSettings(), theme, bootAnim };
  state.settings = s;
  document.body.innerHTML = `<div id="sbody">${appearanceHTML(s)}</div><div id="toast"></div>`;
  wireAppearance(document.getElementById('sbody') as HTMLElement);
  return s;
}

/** 点开下拉并执行指定选项 */
async function pick(btnId: string, key: string): Promise<void> {
  (document.getElementById(btnId) as HTMLElement).click();
  const calls = mocks.openMenu.mock.calls;
  const call = calls[calls.length - 1] as unknown as [string, string, Item[]];
  const item = call[2].find((i) => i.key === key);
  if (!item) throw new Error(`菜单里没有 ${key}`);
  await item.run();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('EVA 主题与启动动画绑定', () => {
  it('选 EVA 主题自动换同名启动动画', async () => {
    const s = mount('cinema', 'warp');
    await pick('pickTheme', 'rei');
    expect(s.theme).toBe('rei');
    expect(s.bootAnim).toBe('eva00');
    expect(cachedBootAnim()).toBe('eva00');
    expect(document.documentElement.dataset.theme).toBe('rei');
  });

  it('选 EVA 启动动画反向把主题切到同一台机体', async () => {
    const s = mount('cinema', 'warp');
    await pick('pickBootAnim', 'eva02');
    expect(s.theme).toBe('eva02');
    expect(s.bootAnim).toBe('eva02');
    expect(document.documentElement.dataset.theme).toBe('eva02');
  });

  it('从 EVA 主题退回普通主题时，EVA 动画收回流光跃迁', async () => {
    const s = mount('rei', 'eva00');
    await pick('pickTheme', 'cinema');
    expect(s.theme).toBe('cinema');
    expect(s.bootAnim).toBe('warp');
  });

  it('「关闭」是明确选择，不被主题绑定强行打开', async () => {
    const s = mount('cinema', 'off');
    await pick('pickTheme', 'nerv');
    expect(s.theme).toBe('nerv');
    expect(s.bootAnim).toBe('off');
  });

  it('warp / off 不反向改主题', async () => {
    const s = mount('rei', 'eva00');
    await pick('pickBootAnim', 'warp');
    expect(s.theme).toBe('rei');
    expect(s.bootAnim).toBe('warp');
  });

  it('绑定表一一对应', () => {
    expect(bootForTheme('eva01')).toBe('eva01');
    expect(bootForTheme('eva02')).toBe('eva02');
    expect(bootForTheme('nerv')).toBe('evaNerv');
    expect(bootForTheme('rei')).toBe('eva00');
    expect(bootForTheme('cinema')).toBeNull();
    expect(themeForBoot('evaNerv')).toBe('nerv');
    expect(themeForBoot('eva00')).toBe('rei');
    expect(themeForBoot('warp')).toBeNull();
    expect(themeForBoot('off')).toBeNull();
  });
});

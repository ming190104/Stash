// @vitest-environment happy-dom
/** 设置九页签的路由表：性能 / 外观 / 键位 / 启动 / 网络 / 库 / 统计 / 元数据 / 关于。
 *  页签索引被 syncBootState / loadLogIssues / 改键捕获共用，
 *  增删页签时最容易错的正是这张映射表，所以逐页断标题 + 关键控件。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSkeleton, resetState } from './dom-skeleton';
import { initSettings } from '../screens/settings';
import { dispatchNav } from '../nav';
import { setScreen } from '../state';

const TABS = ['性能', '外观', '键位映射', '启动', '网络', '库', '统计', '元数据', '关于'];

const navBtns = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('#snav button')];
const body = (): HTMLElement => document.getElementById('sbody')!;
const heading = (): string => (body().querySelector('.sh')?.textContent ?? '').trim();

async function openTab(i: number): Promise<void> {
  navBtns()[i].click();
  await vi.waitFor(() => expect(heading()).toBe(TABS[i]));
}

beforeEach(() => {
  mountSkeleton();
  resetState();
  // happy-dom 不做布局，offsetParent 恒为 null；ringEls 靠它过滤隐藏控件，
  // 不补这一层的话焦点环在测试里永远是空集（键盘/手柄导航完全测不到）
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  // 生产环境里这段结构来自 index.html；测试里按同样层级搭一份
  document.getElementById('app')!.insertAdjacentHTML(
    'beforeend',
    `<div class="set"><nav class="snav" id="snav">${TABS.map(() => '<button></button>').join('')}</nav><div class="sbody" id="sbody"></div></div>`,
  );
  initSettings();
});

describe('设置页签路由', () => {
  it('九页签顺序固定，逐页都能渲染出对应标题', async () => {
    expect(navBtns().length).toBe(9);
    for (let i = 0; i < TABS.length; i++) await openTab(i);
  });

  it('键位映射：手柄键位表在这里', async () => {
    await openTab(2);
    expect(body().querySelector('#padMapRows')).not.toBeNull();
    expect(body().querySelectorAll('#padMapRows .pmrow').length).toBe(7);
    expect(body().querySelector('#padReset')).not.toBeNull();
    expect(body().querySelector('#tgAbSwap')).not.toBeNull();
    expect(body().querySelector('#tgPadMouse')).not.toBeNull();

    await openTab(0);
    expect(body().querySelector('#padMapRows')).toBeNull();
    expect(body().querySelector('#padReset')).toBeNull();
  });

  it('键位映射：→ 进面板时首焦点落在第一条映射，不落在「恢复默认」', async () => {
    setScreen('settings');
    await openTab(2);
    dispatchNav({ intent: 'move', dir: 'right' });
    // rerender 是异步的（内部 await getSettings），等焦点环重新挂上
    await vi.waitFor(() => {
      const focused = document.querySelector<HTMLElement>('.focus');
      expect(focused?.classList.contains('pmrow')).toBe(true);
      expect(focused?.dataset.pad).toBe('accept');
    });
  });

  it('库页签不含演示库 / 测试入口', async () => {
    await openTab(5);
    expect(body().querySelector('[data-act="demo"]')).toBeNull();
    expect(body().textContent).not.toContain('载入演示库');
  });

  it('后移的页签仍然指向正确的面板（启动 / 网络 / 元数据 / 关于）', async () => {
    await openTab(3);
    expect(body().querySelector('#tgBoot')).not.toBeNull();
    await openTab(4);
    expect(body().querySelector('#tgNet')).not.toBeNull();
    await openTab(7);
    expect(body().querySelector('[data-act="match"]')).not.toBeNull();
    await openTab(8);
    expect(body().querySelector('#logBox')).not.toBeNull();
  });
});

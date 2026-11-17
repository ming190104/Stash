// @vitest-environment happy-dom
/** 卡片 / 列表 / 体检三处纯渲染：角标语义、焦点夹紧，以及标题注入防护。 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../state';
import { game, mountSkeleton, resetState } from './dom-skeleton';

// 封面 hydration 会调 asset()：测试里给一个固定 URL，避免去碰 Tauri
vi.mock('../ipc', () => ({
  asset: vi.fn(async () => 'asset://demo'),
  libraryHealth: vi.fn(),
  pruneMissingGames: vi.fn(),
  cleanStorage: vi.fn(),
}));

import { activateCard, buildCard, buildSlot, initCard, launchFromCard, openCard, openFromCard } from '../screens/card';
import { renderList, renderListPreview } from '../screens/list';
import { fmtBytes, healthHTML, runHealth } from '../screens/settings/health';
import { libraryHealth } from '../ipc';
import type { CardActions } from '../screens/card';
import type { HealthReport } from '../types';

beforeEach(() => {
  mountSkeleton();
  resetState();
  document.body.insertAdjacentHTML('beforeend', '<div id="listRows"></div><div id="listPreview"></div>');
});

function cardActions(over: Partial<CardActions> = {}): CardActions {
  return {
    onFocus: vi.fn(),
    onOpen: vi.fn(),
    onLaunch: vi.fn(),
    onToggleSel: vi.fn(),
    suppressed: () => false,
    multi: () => false,
    ...over,
  };
}

describe('封面卡片 buildCard', () => {
  it('携带序号与 id，并按状态标出收藏 / 最近 / 多版本', () => {
    const a = game('a', { title: '同名作品', favorite: true });
    const b = game('b', { title: '同名作品' });
    state.games = [a, b];
    const el = buildCard(a, 2, 'a');
    expect(el.className).toBe('card');
    expect(el.dataset.i).toBe('2');
    expect(el.dataset.id).toBe('a');
    expect(el.querySelector('.fav')).toBeTruthy();
    expect(el.querySelector('.np')).toBeTruthy(); // 最近
    expect(el.querySelector('.ver')!.textContent).toBe('+1 版');
  });

  it('没有最近 / 收藏时不出对应角标，并给出 NEW', () => {
    const a = game('a', { title: '新作' });
    state.games = [a];
    const el = buildCard(a, 0, null);
    expect(el.querySelector('.fav')).toBeFalsy();
    expect(el.querySelector('.np')).toBeFalsy();
    expect(el.querySelector('.new')).toBeTruthy();
    expect(el.querySelector('.ver')).toBeFalsy();
  });

  it('窗口化占位只保留几何，不渲染内容', () => {
    const slot = buildSlot(7);
    expect(slot.className).toBe('card slot');
    expect(slot.dataset.i).toBe('7');
    expect(slot.innerHTML).toBe('');
  });

  it('点击 / 双击按多选与横扫状态分流', () => {
    const acts = cardActions();
    initCard(acts);
    const a = game('a');
    const el = buildCard(a, 3, null);
    el.dispatchEvent(new MouseEvent('click'));
    expect(acts.onFocus).toHaveBeenCalledWith(3);
    el.dispatchEvent(new MouseEvent('dblclick'));
    expect(acts.onOpen).toHaveBeenCalledWith('a');
  });

  it('多选 / 横扫期间的点击语义', () => {
    const multiActs = cardActions({ multi: () => true });
    initCard(multiActs);
    activateCard(game('x'), 1);
    expect(multiActs.onToggleSel).toHaveBeenCalledWith('x');
    expect(multiActs.onFocus).not.toHaveBeenCalled();

    const suppressedActs = cardActions({ suppressed: () => true });
    initCard(suppressedActs);
    activateCard(game('x'), 1);
    openCard(game('x'));
    launchFromCard();
    expect(suppressedActs.onFocus).not.toHaveBeenCalled();
    expect(suppressedActs.onOpen).not.toHaveBeenCalled(); // 横扫期间的点击不开详情
    expect(suppressedActs.onLaunch).toHaveBeenCalledTimes(1); // 启动按钮不受横扫抑制
    openFromCard('x');
    expect(suppressedActs.onOpen).toHaveBeenCalledWith('x'); // 键盘直达不受影响
  });
});

describe('列表布局渲染', () => {
  it('renderList 建行、夹紧焦点并高亮当前行', () => {
    state.games = [game('a', { title: 'A', dir: 'D:\\A' }), game('b', { title: 'B' })];
    state.focus = 9;
    renderList(state.games, true);
    const rows = document.querySelectorAll<HTMLElement>('#listRows .lrow');
    expect(rows.length).toBe(2);
    expect(state.focus).toBe(1); // 夹到末行
    expect(rows[1].classList.contains('on')).toBe(true);
  });

  it('标题 / 开发商里的尖括号按文本渲染，不注入 HTML', () => {
    const evil = game('evil', { title: '<img src=x onerror=alert(1)>', developer: '<script>' });
    state.games = [evil];
    state.focus = 0;
    renderList([evil], false);
    const row = document.querySelector('#listRows .lrow')!;
    expect(row.querySelector('.lt')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(row.querySelector('.lt img')).toBeFalsy();
    expect(row.querySelector('.ls')!.textContent).toBe('<script>');

    renderListPreview();
    const preview = document.getElementById('listPreview')!;
    expect(preview.querySelector('.lp-t')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(preview.querySelector('.lp-t img')).toBeFalsy();
    expect(preview.querySelector('.lp-sum')).toBeTruthy();
  });
});

describe('库体检 HTML', () => {
  it('字节量按 GB / MB / KB / B 取整', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1023)).toBe('1023 B');
    expect(fmtBytes(1024)).toBe('1 KB');
    expect(fmtBytes(1536)).toBe('2 KB');
    expect(fmtBytes(1024 ** 2)).toBe('1.0 MB');
    expect(fmtBytes(1024 ** 3 * 2.5)).toBe('2.50 GB');
  });

  it('无报告时给出体检入口，有报告时汇总并逐条列出问题', () => {
    expect(healthHTML(null)).toContain('开始体检');
    const report: HealthReport = {
      total: 12,
      missingDirs: 1,
      missingExes: 1,
      duplicates: 0,
      unknownEngines: 0,
      missingCovers: 1,
      orphanThumbs: 3,
      orphanCovers: 0,
      tmpLeftovers: 0,
      issues: [
        { kind: 'missingDir', title: '<b>失效</b>', detail: 'D:\\gone' },
        { kind: 'dup', title: '重复', detail: 'x'.repeat(60) },
      ],
    };
    const out = healthHTML(report);
    expect(out).toContain('共 12 部 · 问题 3 项 · 孤儿缓存 3 个');
    expect(out).toContain('&lt;b&gt;失效&lt;/b&gt;'); // 标题被转义
    expect(out).toContain('失效目录'); // 已知 kind 走中文标签
    expect(out).toContain('x'.repeat(56) + '…'); // 详情截到 56 字
  });

  it('体检在途锁：上一轮未完成时重复调用直接返回', async () => {
    const report: HealthReport = {
      total: 0,
      missingDirs: 0,
      missingExes: 0,
      duplicates: 0,
      unknownEngines: 0,
      missingCovers: 0,
      orphanThumbs: 0,
      orphanCovers: 0,
      tmpLeftovers: 0,
      issues: [],
    };
    let release!: (r: HealthReport) => void;
    vi.mocked(libraryHealth)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise<HealthReport>((res) => {
            release = res;
          }),
      );
    const first = runHealth(false);
    await expect(runHealth(false)).resolves.toBeUndefined();
    expect(libraryHealth).toHaveBeenCalledTimes(1);
    release(report);
    await first;
    expect(libraryHealth).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment happy-dom
/** 设置页六个页签 + 共用小工具：分段选择、键位表、匹配队列、统计与体检块的 HTML 语义。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { state } from '../state';
import { game, mountSkeleton, resetState } from './dom-skeleton';
import type { Settings } from '../types';
import { PAD_DEFAULT } from '../padmap';
import { appearanceHTML } from '../screens/settings-tabs/appearance';
import { keysHTML } from '../screens/settings-tabs/keys';
import { startupHTML } from '../screens/settings-tabs/startup';
import { perfHTML } from '../screens/settings-tabs/perf';
import { networkHTML } from '../screens/settings-tabs/network';
import { libraryTabHTML } from '../screens/settings-tabs/library';
import { metadataHTML, matchedRowsHTML, setSourceProbe } from '../screens/settings-tabs/metadata';
import { statsHTML } from '../screens/settings-tabs/stats';
import { aboutHTML } from '../screens/settings-tabs/about';
import { basename, segHTML } from '../screens/settings-tabs/common';

function fixture(over: Partial<Record<string, unknown>> = {}): Settings {
  return {
    theme: 'sakura',
    layout: 'list',
    fontScale: 1.12,
    sound: { enabled: true, gain: 0.85 },
    abSwap: true,
    gamepadMouse: true,
    autostart: true,
    locale: { launch: true, toolPath: 'D:\\LocaleEmulator\\LEProc.exe' },
    fullscreen: true,
    fpsMode: '90',
    power60: true,
    padMap: PAD_DEFAULT,
    network: {
      metadataEnabled: true,
      moegirlFallback: false,
      sgdbKey: 'k"<x>',
    },
    ...over,
  } as unknown as Settings;
}

beforeEach(() => {
  mountSkeleton();
  resetState();
  localStorage.clear();
});

describe('外观 / 键位 / 启动 / 性能页签', () => {
  it('外观页签按当前设置标出主题、布局、字号与音效档', () => {
    const s = fixture();
    state.settings = s;
    state.motion = 1;
    state.verticalTitle = true;
    document.documentElement.dataset.layout = 'list'; // layoutMode 只读 html[data-layout]
    const out = appearanceHTML(s);
    expect(out).toContain('樱夜');
    expect(out).toContain('id="segLayout"');
    expect(out).toMatch(/class="on" data-v="list"/);
    expect(out).toMatch(/class="on" data-v="1.12"/);
    expect(out).toMatch(/class="on" data-v="0.85"/);
    expect(out).toContain('id="tgVt"></button>');
    expect(out).toContain('tg on" id="tgSound"');
  });

  it('键位页签：改键态显示「按手柄按键…」，并标出 A/B 互换与手柄鼠标', () => {
    const out = keysHTML(fixture(), 'accept');
    expect(out).toContain('按手柄按键…');
    expect(out.match(/pmrow cap/g)!.length).toBe(1);
    expect(out).toContain('id="tgAbSwap"');
    expect(out).toMatch(/tg on" id="tgAbSwap"/);
    expect(out).toMatch(/tg on" id="tgPadMouse"/);
  });

  it('键位页签：手感三行齐全，恢复默认是危险动作', () => {
    const out = keysHTML(fixture(), null);
    expect(out).toContain('id="tgDeadzone"');
    expect(out).toContain('id="tgRepeat"');
    expect(out).toContain('id="tgMouseSpeed"');
    expect(out).toMatch(/class="on" data-v="0.28"/);
    expect(out).toMatch(/class="on" data-v="60"/);
    expect(out).toMatch(/class="on" data-v="11"/);
    expect(out).toMatch(/id="padReset" data-danger="1"/);
    // 震动功能已移除：设置里不再出现任何开关 / 强度行
    expect(out).not.toContain('tgVib');
    expect(out).not.toContain('震动');
  });

  it('启动页签显示转区工具文件名；未选择时显示占位', () => {
    expect(startupHTML(fixture())).toContain('LEProc.exe');
    const none = fixture({ locale: { launch: false, toolPath: null } });
    expect(startupHTML(none)).toContain('选择…');
  });

  it('性能页签按档位标出帧率 / 全屏 / 60Hz，并跟随 FPS 面板存储位', () => {
    const out = perfHTML(fixture());
    expect(out).toMatch(/class="on" data-v="90"/);
    expect(out).toMatch(/tg on" id="tgFullMode"/);
    expect(out).toMatch(/tg on" id="tgPower"/);
    expect(out).toContain('运行测试');
    localStorage.setItem('fpsPanel', '1');
    expect(perfHTML(fixture())).toMatch(/tg on" id="tgFps"/);
  });
});

describe('网络 / 库页签', () => {
  it('网络页签对密钥做转义，且不再有代理地址输入框', () => {
    const out = networkHTML(fixture());
    expect(out).toContain('k&quot;&lt;x&gt;');
    expect(out).toContain('id="inpSgdb"');
    expect(out).toContain('id="tgMoegirl"');
    expect(out).not.toContain('id="inpProxy"');
    expect(out).not.toContain('内置代理');
  });

  it('库页签带上体检块', () => {
    state.settings = fixture();
    const withBlock = libraryTabHTML('<div class="health">体检</div>');
    expect(withBlock).toContain('体检');
  });
});

describe('元数据页签的匹配队列', () => {
  it('空队列给出占位文案', () => {
    expect(matchedRowsHTML('')).toContain('没有符合条件的作品');
  });

  it('超过 20 部时截断并提示关键字缩小范围，筛选命中原名', () => {
    state.games = Array.from({ length: 25 }, (_, i) =>
      game(`g${i}`, { title: `作品 ${i}`, titleOriginal: `原題 ${i}`, matched: true, bangumiId: i + 1 }),
    );
    const all = matchedRowsHTML('');
    expect(all).toContain('还有 5 部');
    expect(all.match(/data-rebind="g/g)!.length).toBe(20);
    expect(matchedRowsHTML('原題 24')).toContain('作品 24');
    expect(matchedRowsHTML('不存在')).toContain('没有符合条件');
  });

  it('元数据页签汇总已匹配 / 待确认 / 未匹配 / 隐藏四类计数', () => {
    state.games = [
      game('a', { title: '已匹配', matched: true, bangumiId: 12 }),
      game('b', { title: '待确认', pending: true, matchScore: 66 }),
      game('c', { title: '未匹配', matched: false }),
      game('d', { title: '隐藏', matched: false, hidden: true }),
    ];
    const out = metadataHTML();
    expect(out).toContain('<b>2</b><span>/ 4 已匹配</span>');
    expect(out).toContain('<b>1</b><span>部待确认</span>');
    expect(out).toContain('<b>1</b><span>部未匹配</span>');
    expect(out).toContain('data-unhide="d"');
    expect(out).toContain('data-bind="b"');
  });
});

describe('元数据页签的数据源可达性', () => {
  it('未探测时只给「尚未检测」提示', () => {
    setSourceProbe(null);
    const out = metadataHTML();
    expect(out).toContain('尚未检测');
    expect(out).toContain('data-act="probe"');
  });

  it('探测后逐源显示状态，直连且不可达时引导去网络设置', () => {
    setSourceProbe({
      bangumi: { status: 'offline', message: 'Bangumi：超时' },
      moegirl: { status: 'offline', message: '萌娘百科：不可达' },
      egs: { status: 'skipped', message: '匹配预检不探测' },
      kungal: { status: 'offline', message: '鲲 Galgame：不可达' },
      proxy: null,
      usable: false,
      message: 'Bangumi 需要代理，请到「设置 · 网络」配置',
    });
    const out = metadataHTML();
    expect(out).toContain('不可达');
    expect(out).toContain('直连（未启用系统代理）');
    expect(out).toContain('data-gonet');
    setSourceProbe(null);
  });

  it('有代理且可用时不显示跳转入口', () => {
    setSourceProbe({
      bangumi: { status: 'ok', message: 'Bangumi 可达' },
      moegirl: { status: 'ok', message: '萌娘百科可达' },
      egs: { status: 'ok', message: 'EGS 可达' },
      kungal: { status: 'ok', message: '鲲 Galgame 可达' },
      proxy: 'http://127.0.0.1:7890',
      usable: true,
      message: null,
    });
    const out = metadataHTML();
    expect(out).toContain('系统代理 · http://127.0.0.1:7890');
    expect(out).not.toContain('data-gonet');
    setSourceProbe(null);
  });
});

describe('统计 / 关于 / 共用小工具', () => {
  it('统计页签按场次与结局推导时长和进度', () => {
    const now = Date.now() / 1000;
    state.games = [
      game('a', {
        title: 'A',
        playSeconds: 7200,
        progress: 1,
        endings: [
          { name: 'END 1', done: true },
          { name: 'END 2', done: false },
        ],
        sessions: [{ at: now - 3600, seconds: 3600 }],
      }),
      game('b', { title: 'B', hidden: true }),
    ];
    const out = statsHTML();
    expect(out).toContain('<b>2 小时</b>');
    expect(out).toContain('<b>1</b><span>/ 1 部</span>');
    expect(out).toContain('<b>50%</b>');
    expect(out).toContain('1 / 2');
    expect(out).toContain('玩得最多');
    expect(out).not.toContain('还没有游玩记录');
  });

  it('空库统计给出占位并保留 7 天柱位', () => {
    const out = statsHTML();
    expect(out).toContain('还没有游玩记录');
    expect(out.match(/bar-col/g)!.length).toBe(7);
    expect(out).toContain('<b>—</b>');
  });

  it('关于页签带版本与四个数据入口', () => {
    const out = aboutHTML();
    expect(out).toContain('版本 1.0.2');
    for (const act of ['opendata', 'openlogs', 'diagnostics']) expect(out).toContain(act);
    expect(out).toContain('openHelpBtn');
  });

  it('分段选项可进入 Tab 顺序并具备按钮语义', () => {
    const host = document.createElement('div');
    host.innerHTML = segHTML('segX', [{ v: 'a', label: 'A' }], 'a');
    const option = host.querySelector<HTMLElement>('[data-v="a"]')!;
    expect(option.getAttribute('role')).toBe('button');
    expect(option.tabIndex).toBe(0);
  });

  it('分段选择器标出当前值并转义标签；basename 兼容两种分隔符', () => {
    expect(segHTML('segX', [{ v: 'a', label: '<b>' }], 'a')).toContain('&lt;b&gt;');
    expect(segHTML('segX', [{ v: 'a', label: 'A' }], 'a')).toContain('class="on" data-v="a"');
    expect(basename('D:\\LE\\LEProc.exe')).toBe('LEProc.exe');
    expect(basename('C:/tools/nleas.exe')).toBe('nleas.exe');
    expect(basename('LEProc.exe')).toBe('LEProc.exe');
  });
});

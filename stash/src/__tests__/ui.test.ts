// @vitest-environment happy-dom
/** 通用小部件纯逻辑：HTML 转义、CSS url 转义、时长格式化、主题 / 布局缓存、toast 汇点消毒。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cssUrl, cachedLayout, cachedTheme, cnFirst, errMsg, esc, fmtDuration, normalizeFontScale, stageScale, toast } from '../ui';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        store.set(k, v);
      },
    },
  });
});

describe('esc', () => {
  it('转义尖括号 / 引号 / 和号，阻断属性注入', () => {
    expect(esc(`<img src=x onerror="alert('x')">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
    );
    expect(esc('A & B')).toBe('A &amp; B');
  });
});

describe('errMsg', () => {
  it('AppError 取 message，普通 Error 取 message，字符串原样，未知值 String()', () => {
    expect(errMsg({ code: 'networkOffline', message: 'Bangumi 不可达' })).toBe('Bangumi 不可达');
    expect(errMsg(new Error('boom'))).toBe('boom');
    expect(errMsg('纯文本')).toBe('纯文本');
    expect(errMsg(42)).toBe('42');
    // 空 message 不能被当成有效文案（后端偶发空串时至少还能看出是什么错）
    expect(errMsg({ message: '' })).toBe('[object Object]');
  });
});

describe('cssUrl', () => {
  it('转义反斜杠 / 双引号 / 换行，避免破坏样式表', () => {
    expect(cssUrl('a\\b')).toBe('url("a\\\\b")');
    expect(cssUrl('a"b')).toBe('url("a\\"b")');
    expect(cssUrl('a\nb')).toBe('url("a\\a b")');
  });
});

describe('fmtDuration', () => {
  it('未游玩 / 不足一分钟 / 分钟 / 小时分档', () => {
    expect(fmtDuration(0)).toBe('—');
    expect(fmtDuration(30)).toBe('不足 1 分');
    expect(fmtDuration(3540)).toBe('59 分');
  });

  it('四舍五入到 60 分时进位成 1 小时', () => {
    expect(fmtDuration(3599)).toBe('1 小时');
    expect(fmtDuration(3600)).toBe('1 小时');
    expect(fmtDuration(7260)).toBe('2 小时 1 分');
  });
});

describe('简介中文优先', () => {
  it('日文段落在前、中文段落在后时，把中文提到前面', () => {
    const jp = '季節は春、楽しく等身大で過ごす学園での日常から物語は始まります。';
    const cn = '《CLANNAD》为2004年key社所发行的文字冒险游戏，核心是家族温情。';
    const raw = `${jp}\r\n${'-'.repeat(60)}\r\n\r\n${cn}\r\n`;
    expect(cnFirst(raw)).toBe(`${cn}\n\n${jp}`);
  });

  it('已经是中文在前就原样返回，不动排版', () => {
    const raw = '中文简介第一段。\n\n中文简介第二段。';
    expect(cnFirst(raw)).toBe(raw);
  });

  it('纯英文 / 纯日文不改顺序，短句不误判成中文', () => {
    const en = 'A story about family and growing up.\n\nSecond paragraph.';
    expect(cnFirst(en)).toBe(en);
    const jp = 'これは日本語の紹介です。\n\n二段落目です。';
    expect(cnFirst(jp)).toBe(jp);
    // 只有两三个汉字（如人名）不足以判定
    expect(cnFirst('「CLANNAD」\n\nEnglish text here.')).toBe('「CLANNAD」\n\nEnglish text here.');
  });
});

describe('舞台缩放', () => {
  it('掌机 1280×720 保持 1×，小窗口等比缩小', () => {
    expect(stageScale(1280, 720)).toBe(1);
    expect(stageScale(960, 540)).toBeCloseTo(0.75);
  });

  it('大屏等比放大但不超过 2×', () => {
    expect(stageScale(1920, 1080)).toBeCloseTo(1.5);
    expect(stageScale(2560, 1440)).toBe(2);
    expect(stageScale(3840, 2160)).toBe(2);
  });

  it('非 16:9 只留边，不拉伸', () => {
    // 超宽：高度先到 2×，宽度留边
    expect(stageScale(3440, 1440)).toBe(2);
    // 4:3：宽度先到 1.5，高度留边
    expect(stageScale(1920, 1440)).toBeCloseTo(1.5);
    // 退化尺寸不能返回 0 / NaN
    expect(stageScale(0, 0)).toBe(1);
  });
});

describe('界面字号档位', () => {
  it('只接受 0.9~1.25，脏值回落到标准', () => {
    expect(normalizeFontScale(1.12)).toBe(1.12);
    expect(normalizeFontScale(0.5)).toBe(0.9);
    expect(normalizeFontScale(9)).toBe(1.25);
    expect(normalizeFontScale(undefined)).toBe(1);
    expect(normalizeFontScale(NaN)).toBe(1);
  });
});

describe('主题 / 布局缓存', () => {
  it('只接受白名单，非法缓存回落默认值', () => {
    expect(cachedTheme()).toBe('cinema');
    expect(cachedLayout()).toBe('classic');
    store.set('vnTheme', 'sakura');
    store.set('vnLayout', 'wall');
    expect(cachedTheme()).toBe('sakura');
    expect(cachedLayout()).toBe('wall');
    store.set('vnTheme', 'neon');
    store.set('vnLayout', 'magazine');
    expect(cachedTheme()).toBe('cinema');
    expect(cachedLayout()).toBe('classic');
  });
});

describe('toast 汇点消毒', () => {
  it('保留键帽 span，拆掉其余标签与事件属性', () => {
    document.body.innerHTML = '<div id="toast"></div>';
    toast('<span class="kk acc" onclick="alert(1)">A</span><img src=x onerror="alert(2)">拖拽失败');
    const el = document.getElementById('toast')!;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[onclick]')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
    expect(el.textContent).toContain('拖拽失败');
    const kk = el.querySelector('.kk');
    expect(kk?.textContent).toBe('A');
    // 只保留白名单 class，其它属性（含 on*）一律丢弃
    expect(kk?.getAttributeNames()).toEqual(['class']);
  });
});

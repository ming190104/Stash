// @vitest-environment happy-dom
/** 自动转义模板：默认转义、嵌套不重复转义、raw 透传、setHTML 写入。 */

import { describe, expect, it } from 'vitest';
import { esc, html, raw, setHTML } from '../html';

describe('html 模板', () => {
  it('默认转义插值（含属性 / 数组 / null / false）', () => {
    const t = html`<b title="${'a"b'}">${'<script>&'}</b>${null}${false}${[1, 'x']}`;
    expect(t.value).toBe('<b title="a&quot;b">&lt;script&gt;&amp;</b>1x');
  });

  it('嵌套 html 不重复转义，raw 原样输出', () => {
    const inner = html`<i>${'<x>'}</i>`;
    expect(html`<p>${inner}</p>`.value).toBe('<p><i>&lt;x&gt;</i></p>');
    expect(html`${raw('<em>ok</em>')}`.value).toBe('<em>ok</em>');
  });

  it('esc 保持既有逐字符行为（与旧实现一致）', () => {
    expect(esc(`<img src=x onerror="alert('x')">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
    );
  });

  it('setHTML 写入元素，文本按转义后渲染', () => {
    const el = document.createElement('div');
    setHTML(el, html`<b>${'<x>'}</b>`);
    expect(el.querySelector('b')?.textContent).toBe('<x>');
  });
});

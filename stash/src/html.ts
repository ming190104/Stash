/** 自动转义模板 + 统一转义函数。
 *
 *  `esc()` 是既有写法：每个插值手动包一层。`html` 则是「默认转义」：
 *  插值里的 `& < > " '` 一律转义，只有 `raw()` 包过的片段原样输出；
 *  嵌套的 `html` 结果不会再被转义，所以可以安全地拼子树。
 *
 *  迁移策略：新模板优先 `html`；旧模板继续用 `esc()`（行为完全一致），
 *  按模块逐步替换，避免一次性改动 60+ 处模板带来的回归风险。 */

/** HTML 转义：与旧 `esc()` 逐字符一致（测试锁定）。 */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** 已转义 / 可信 HTML 片段的标记 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** 标记一段可信 HTML（调用方负责保证安全：常量、已转义内容或 html 结果） */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

function toHtml(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  return esc(String(v));
}

/** 自动转义模板：`html`<b>${title}</b>`` 里的 title 会被转义 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

/** DOM 版本号：每次重写子树就递增。
 *  依赖布局的缓存（如焦点环元素列表）用它与 DOM 重建对齐，而不是靠时间窗口。 */
let domEpoch = 0;

/** 当前 DOM 版本；缓存命中要求版本一致 */
export function domEpochNo(): number {
  return domEpoch;
}

/** 把模板写进元素（唯一允许直接碰 innerHTML 的入口，便于以后加 Trusted Types） */
export function setHTML(el: HTMLElement, tpl: SafeHtml): void {
  domEpoch++;
  el.innerHTML = tpl.value;
}

/** 写入「调用方已保证安全」的 HTML 字符串（常量模板，或已逐项 esc 的内容）。
 *  只是 setHTML 的字符串重载：仍然只有 html.ts 碰 innerHTML，
 *  迁移旧模板时不必先包一层 raw()。 */
export function setRawHTML(el: HTMLElement, markup: string): void {
  setHTML(el, raw(markup));
}

/** 清空子节点：替代 `el.innerHTML = ''`，让「只有 html.ts 碰 innerHTML」可被静态检查 */
export function clearHTML(el: HTMLElement): void {
  domEpoch++;
  el.textContent = '';
}

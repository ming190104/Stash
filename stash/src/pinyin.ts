/** 拼音检索：把标题 / 会社 / 标签转成「全拼 + 首字母」两串，拼进搜索索引。
 *  「千恋万花」→ qianlianwanhua / qlwh，因此输入 qlwh 或 qianlian 都能命中。
 *  词表随包内置（tiny-pinyin 的 GB2312 边界表 + Intl.Collator 排序），不联网、无额外启动成本。
 *  非汉字原样保留，中英混排标题（「AIR 夏日特典」）也能按各段拼音命中。 */

import TinyPinyin from 'tiny-pinyin';

interface Folded {
  flat: string;
  ini: string;
}

/** 按字符串缓存：库里的标题是固定集合，但搜索框每敲一个字都会产生新串。
 *  设上限并在超限时按插入序淘汰最旧的一半，避免长时间使用后无界增长。 */
const cache = new Map<string, Folded>();
const CACHE_MAX = 2000;

function remember(s: string, v: Folded): void {
  cache.set(s, v);
  if (cache.size <= CACHE_MAX) return;
  for (const k of cache.keys()) {
    cache.delete(k);
    if (cache.size <= CACHE_MAX / 2) break;
  }
}

function foldOne(s: string): Folded {
  // 系统缺少 zh-CN 排序数据时（极少数精简 WebView）直接退化为无拼音，不影响原有检索
  if (!TinyPinyin.isSupported()) return { flat: '', ini: '' };
  let flat = '';
  let ini = '';
  for (const t of TinyPinyin.parse(s)) {
    const low = t.target.toLowerCase();
    flat += low;
    // type 2 = 汉字（target 是无声调全拼）；其他类型是原字符，首字母取自身
    ini += t.type === 2 ? low.slice(0, 1) : low;
  }
  return { flat, ini };
}

/** 检索用的拼音串（全拼 + 首字母）；同一段文本只解析一次 */
export function pinyinHay(s: string): string {
  if (!s) return '';
  const hit = cache.get(s);
  if (hit) return `${hit.flat} ${hit.ini}`;
  const v = foldOne(s);
  remember(s, v);
  return `${v.flat} ${v.ini}`;
}

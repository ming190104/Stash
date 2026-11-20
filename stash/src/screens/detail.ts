/** 详情屏：全屏 KV + 信息面板（mockup buildDetail 迁移）。 */

import type { Game, NavIntent } from '../types';
import {
  launchGame,
  openDir,
  setLaunchArgs,
  mountIso,
  unmountIso,
  pickIso,
  pickImageFile,
  setGameTitle,
  setGameExe,
  pickExeFile,
  setLocaleOverride,
  setGameCover,
  smartCover,
  steamgridCover,
  setGameBackground,
  clearGameBackground,
  useBackgroundCandidate,
  touchAsset,
  setHidden,
  setUserTags,
  setNotes,
  setRating,
  removeGame,
  deleteGameDir,
  unmatchGame,
  ensureTags,
} from '../ipc';
import { state, gameById, setScreen, versionGroup, markLocalEdit, clearLocalEdit } from '../state';
import { PAD_DEFAULT, padGlyph } from '../padmap';
import { registerHandler } from '../nav';
import { toast, esc, fmtRelative, fmtDuration, press, ringEls, ringFocus, ringClear, ringActivate, cnFirst, clickable } from '../ui';
import { artHTML, hydrateArts } from './art';
import { clearHTML, setRawHTML } from '../html';
import { toggleFav, refreshLibrary } from '../library-bridge';
import { paintDetailArt, forgetDetailBg, prepareDetailBg } from './detail-bg';
import { anyState, openEndings } from '../overlay';
import { promptConfirm, promptInput } from '../prompt';
import { openMenu, type MenuItem } from '../quick';
import { openCandPanel } from '../candpanel';
import { openBgPanel, BG_PICK, BG_AUTO } from '../bgpanel';

/** 进程内记住「哪部游戏挂着哪个镜像」：重启后按未挂载显示，重新挂一次即可（挂载本身是系统态） */
const mountedIso = new Map<string, { path: string; letter: string }>();

/** 目录末段：版本切换只看得到「汉化」「生肉」这类目录名，比标题更有辨识度 */
function baseDir(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** 「参考」行：外部口碑分 + 参考时长（Bangumi / EGS / 鲲 Galgame），没有就显示 — */
function refText(g: Game): string {
  const src =
    g.metaScoreSource === 'egs' ? 'EGS' : g.metaScoreSource === 'kungal' ? '鲲' : 'Bangumi';
  const parts: string[] = [];
  if (g.metaScore !== null && g.metaScore !== undefined) {
    const score = Math.round(g.metaScore * 10) / 10;
    parts.push(`${src} ${score}`);
  }
  const m = g.lengthMinutes;
  if (m && m > 0) {
    parts.push(m < 60 ? `${m} 分钟` : `${Math.round((m / 60) * 10) / 10} 小时`);
  }
  return parts.length ? esc(parts.join(' · ')) : '—';
}

/** 详情页焦点环索引（0 = 启动游戏）。renderDetail 会重建 DOM，索引每次按新集合夹紧。 */
let detailIdx = 0;
/** 上一次渲染的游戏 id：换片时焦点回到第一项（A 启动），同一部重渲染则保留 */
let ringGameId: string | null = null;
/** 渲染序号：异步取数回来时若已开始渲染别的作品，丢弃这份旧结果 */
let detailToken = 0;
/** 本进程内已按需补过标签的作品：失败也不反复请求（详情页每次重渲染都会走到这里） */
const tagsAsked = new Set<string>();
/** 上一次渲染用的封面图源：图源没变就不重建 DOM（`.art img` 有 300ms 淡入，重建会闪） */
let lastArtKey: string | null = null;
/** 本次进入详情页（由 openDetail 打标记）：只有「翻到详情」才播放卷轴展开，评星/改标签等局刷不动 */
let enterFresh = false;
/** 同名版本环：renderDetail 按「当前作品 + 其它版本」重建，← / → 用它定位，
 *  否则每次都从 DOM 现取（已排除当前作品）算游标，索引恒为 0，多版本时方向会乱。 */
let verRing: string[] = [];
let verIdx = 0;

/** 进入详情屏时调用：下一次 renderDetail 播放卷轴展开 */
export function markDetailEnter(): void {
  enterFresh = true;
}

/** 封面换了但文件名没变（同一扩展名覆盖 `<id>_custom.png` / `_auto.png`）时，
 *  强制下次渲染重建封面 DOM——否则沿用旧图看起来像「没换成功」 */
function invalidateDetailArt(): void {
  lastArtKey = null;
}

/** 详情屏内切换同名版本（版本角标 / ← →）：**先把目标作品的背景解码好**再重渲染。
 *  `paintDetailArt` 换作品时会先摘掉 `has-bg`、再异步等图解码，那几十毫秒里
 *  `#kvArt`（整屏封面）会淡回来——上一部的封面闪一下。等图备齐后 paint 是同步的，
 * 摘掉 / 挂回 `has-bg` 发生在同一次样式提交里，用户看不到过渡。 */
function switchDetailGame(id: string): void {
  if (!id || id === state.detailId) return;
  const from = state.detailId;
  // 解码期间先不动 detailId：这几百毫秒里详情屏仍是旧作品，
  // A / R / 评分等入口按 detailId 取作品时不会出现「id 已是新的、DOM 还是旧的」错位。
  void prepareDetailBg(id).then(() => {
    if (state.detailId !== from) return; // 等待期间又切去了别处：交给后来那次
    state.detailId = id;
    void renderDetail();
  });
}

/** 可聚焦控件：右侧四键在前，信息面板里的行内按钮在后（DOM 顺序相反，这里显式排） */
function detailRingEls(): HTMLElement[] {
  const side = document.getElementById('dSide');
  const info = document.getElementById('dInfo');
  return [...(side ? ringEls(side) : []), ...(info ? ringEls(info) : [])];
}

function applyDetailRing(): void {
  const els = detailRingEls();
  if (!els.length) return;
  detailIdx = ringFocus(els, detailIdx);
}

export async function renderDetail(): Promise<void> {
  const token = ++detailToken;
  // 已移出库的作品不再保留 ISO 挂载记录（只清内存状态，卸载由用户手动做）
  for (const k of [...mountedIso.keys()]) if (!gameById(k)) mountedIso.delete(k);
  const g = gameById(state.detailId);
  const fresh = enterFresh || ringGameId !== state.detailId;
  enterFresh = false;
  if (ringGameId !== state.detailId) {
    ringGameId = state.detailId;
    detailIdx = 0;
  }
  const kv = document.getElementById('kvArt');
  const cover = document.getElementById('dCover');
  const info = document.getElementById('dInfo');
  const side = document.getElementById('dSide');
  if (!kv || !cover || !info || !side) return;
  if (!g) {
    // 条目已被移除 / 隐藏：清掉上一部的残留，给出返回提示（否则整屏都是旧作品）
    verRing = [];
    verIdx = 0;
    clearHTML(kv);
    clearHTML(cover);
    lastArtKey = null;
    clearHTML(side);
    paintDetailArt(null, () => token === detailToken);
    setRawHTML(
      info,
      '<div class="d-cn">作品已不在库中</div><p class="d-sum">可能已被移出库或隐藏；按 B 返回游戏库。</p>',
    );
    return;
  }

  // 整屏背景：清晰的完整原图（不是模糊的缩略图放大）
  paintDetailArt(g, () => token === detailToken);

  // 批量匹配不再为每部补 Bangumi 标签（省一次请求/部）：详情页第一次打开时按需补齐。
  // 标签只影响这篇详情与筛选；补齐后刷新一次库，让其它视图也跟着更新。
  if (g.bangumiId != null && g.tags.length === 0 && !tagsAsked.has(g.id)) {
    tagsAsked.add(g.id);
    void ensureTags(g.id)
      .then(async (tags) => {
        if (!tags.length) return;
        const cur = gameById(g.id);
        if (!cur || cur.tags.length) return;
        cur.tags = tags;
        await refreshLibrary();
        if (state.detailId === g.id) void renderDetail();
      })
      .catch(() => {
        /* 补标签失败不影响详情：下次打开详情仍会重试 */
        tagsAsked.delete(g.id);
      });
  }

  // 详情页用原封面而不是缩略图：缩略图 255×340 放到 200×266 的框里再放大，边缘会发虚
  const artGame = g.cover ? { ...g, thumb: null } : g;
  // 只在图源变化时重建封面 DOM：`.art img` 是 opacity 0 → 1 的 300ms 淡入，
  // 每次重渲染都重建等于「封面消失再淡回来」——匹配 / 评分 / 收藏后的刷新都会闪一下
  const artKey = artGame.cover || artGame.thumb || '';
  if (artKey !== lastArtKey) {
    lastArtKey = artKey;
    setRawHTML(kv, artHTML(artGame));
    setRawHTML(cover, artHTML(artGame));
    hydrateArts(kv);
    hydrateArts(cover);
  }
  const endsDone = g.endings.filter((e) => e.done).length;
  // B7：同名/同 Bangumi 条目的其它版本（汉化 / 生肉），一格铺满 d-meta 底行
  const versions = versionGroup(g);
  // 版本环：[当前作品, ...其它版本]。集合没变就只把游标对回当前作品；
  // 变了（换了同组作品 / 版本增删）才重建，游标归零。顺序无关比较，去重后再比。
  const want = [...new Set([state.detailId!, ...versions.map((v) => v.id)])];
  const same = want.length === verRing.length && want.every((id) => verRing.includes(id));
  if (!same) {
    verRing = want;
    verIdx = 0;
  } else {
    verIdx = Math.max(0, verRing.indexOf(state.detailId!));
  }
  const rating = g.rating ?? 0;
  // aria-label / aria-pressed：五颗星文字全是「★」，读屏否则无法区分点的是第几颗
  const stars = Array.from({ length: 5 }, (_, i) =>
    `<span class="dstar${i < rating ? ' on' : ''}" data-star="${i + 1}" aria-label="第 ${i + 1} 星" aria-pressed="${i < rating}">★</span>`,
  ).join('');
  const userTags = g.userTags ?? [];
  const pills = [
    ...g.tags.map((t) => `<span class="pill">${esc(t)}</span>`),
    ...userTags.map((t) => `<span class="pill user" data-tag="${esc(t)}">${esc(t)} ×</span>`),
  ];
  if (!pills.length) pills.push(`<span class="pill hot">${esc(g.engineLabel)}</span>`);
  const sess = (g.sessions ?? []).slice(-3).reverse();
  // 来源角标：区分「没中文数据」与「请求失败降级」；vndb / igdb 只用于兼容旧库
  const srcLabel = !g.matched
    ? '本地目录'
    : ({ bangumi: 'Bangumi', moegirl: '萌娘百科', kungal: '鲲 Galgame', vndb: 'VNDB', igdb: 'IGDB' } as Record<string, string>)[g.metaSource ?? ''] ?? '在线';
  const ref = refText(g);
  // 原名与标题相同（未匹配到日文原名）时不再重复一行；有罗马字时仍保留该行
  const orig = g.titleOriginal && g.titleOriginal !== g.title ? esc(g.titleOriginal) : '';
  const jpLine = [orig, g.romaji ? esc(g.romaji) : ''].filter(Boolean).join(' · ');
  // 同会社作品：只从当前库里取，用于详情页的横向推荐条
  const related = g.developer
    ? state.games.filter((x) => x.id !== g.id && !x.hidden && x.developer === g.developer).slice(0, 6)
    : [];

  setRawHTML(
    info,
    `
    <div class="d-cn">${esc(g.title)}</div>
    ${jpLine ? `<div class="d-jp">${jpLine}</div>` : ''}
    <div class="d-pills">${pills.join('')}</div>
    <p class="d-sum">${esc(cnFirst(g.summary ?? '') || '尚未匹配元数据——当前信息来自本地目录。可在「设置 · 元数据」里运行 Bangumi 匹配。')}</p>
    <div class="d-meta">
      <div>开发商<b class="${g.developer ? '' : 'na'}">${esc(g.developer ?? '—')}</b></div><div>发售日<b class="${g.year ? '' : 'na'}">${g.year ?? '—'}</b></div><div>参考<b class="${ref === '—' ? 'na' : ''}">${ref}</b></div><div>元数据<b>${esc(srcLabel)}</b></div><div>引擎<b>${esc(g.engineLabel)}${(g.localeOverride ?? g.needsLocale) ? '<i class="warn"> · 需转区</i>' : ''}</b></div>
      <div>最近游玩<b>${fmtRelative(g.lastPlayed)}</b></div><div>累计时长<b>${fmtDuration(g.playSeconds)}</b></div><div>启动次数<b>${g.playCount} 次</b></div>
      <div>结局<b class="${g.endings.length ? '' : 'na'}">${g.endings.length ? `${endsDone}/${g.endings.length}` : '—'}</b>${g.endings.length ? `<span class="linkbtn" id="dEnds">管理</span>` : `<span class="linkbtn" id="dEnds">标记…</span>`}</div>
      <div>评分<b class="dstars">${stars}</b></div>
      <div>标签<b>${userTags.length}</b><span class="linkbtn" id="dTagAdd">添加</span></div>
      <div>备注<b class="${g.notes ? '' : 'na'}">${g.notes ? '已写' : '—'}</b><span class="linkbtn" id="dNotes">编辑</span></div>
      ${sess.length ? `<div class="d-sess"><span>最近场次</span>${sess.map((s) => `<b>${esc(fmtRelative(s.at))} · ${esc(fmtDuration(s.seconds))}</b>`).join('')}</div>` : ''}
      ${versions.length ? `<div class="d-ver"><span>同名版本</span>${versions.map((v) => `<span class="vchip" data-ver="${esc(v.id)}">${esc(baseDir(v.dir))}</span>`).join('')}</div>` : ''}
    </div>
    ${related.length ? `<div class="d-rel"><span>同会社作品</span>${related.map((r) => `<span class="rel-chip" data-rel="${esc(r.id)}">${esc(r.title)}</span>`).join('')}</div>` : ''}`,
  );

  // 侧栏键帽跟随当前手柄映射：AB 互换 / 改键后不能还写着旧的 A / RB
  const padMap = state.settings?.padMap ?? PAD_DEFAULT;
  const acceptKey = padGlyph(padMap.accept, state.padKind);
  const favKey = padGlyph(padMap.r, state.padKind);
  setRawHTML(
    side,
    `
    <button class="cta" id="dPlay"><span class="k">${esc(acceptKey)}</span>启动游戏</button>
    <button class="ghost" id="dFav"><span class="k">${esc(favKey)}</span>${g.favorite ? '★ 已收藏' : '☆ 加入收藏'}</button>
    <button class="ghost" id="dOpen">打开游戏目录</button>
    <button class="ghost" id="dMore">更多操作…</button>`,
  );

  // 卷轴展开：只在「翻到详情 / 切换同名版本」时挂动画类；涉及结构重建再强制重排保证可重播
  const meta = info.querySelector('.d-meta');
  [cover, info, side].forEach((el) => el.classList.remove('unfold'));
  meta?.classList.remove('unfold');
  if (fresh) {
    void info.offsetWidth;
    cover.classList.add('unfold');
    info.classList.add('unfold');
    side.classList.add('unfold');
    meta?.classList.add('unfold');
  }

  side.querySelector('#dPlay')?.addEventListener('click', () => {
    press('#dPlay');
    // 与库屏 doLaunch 同一规则：已有游戏在运行时不再拉起第二份
    // （重启后 state.running 有值但没有启动遮罩，此处是唯一能绕过遮罩的入口）
    if (state.running) {
      toast('已有游戏在运行 · 先结束再启动');
      return;
    }
    // 详情页启动：直接调 launchGame（焦点不在轨道上）
    launchGame(g.id).catch((e) => toast(esc(String((e as { message?: string })?.message ?? e)), true));
  });
  side.querySelector('#dFav')?.addEventListener('click', () => {
    // 三处视图同步（轨道卡 / 网格卡 / 详情按钮）由 toggleFav 统一重建
    // 落盘：favorite 属于游玩记录字段，由 setFavorite 单独写库（失败会回滚内存标志）
    toggleFav(g.id);
  });
  side.querySelector('#dOpen')?.addEventListener('click', () => {
    press('#dOpen');
    openDir(g.id)
      .then(() => toast('已打开游戏目录'))
      .catch((e) => toast(esc(String((e as { message?: string })?.message ?? e)), true));
  });
  side.querySelector('#dMore')?.addEventListener('click', () => {
    press('#dMore');
    void openDetailMenu(g.id);
  });

  // 结局 / 路线标记：手动维护 END 清单，进度按清单推导
  info.querySelector('#dEnds')?.addEventListener('click', () => {
    void openEndings(g.id);
  });
  // B7：切到同名版本的另一个目录（汉化 ↔ 生肉），停在同一屏不打断浏览
  info.querySelectorAll<HTMLElement>('[data-ver]').forEach((el) => {
    clickable(el);
    el.addEventListener('click', () => {
      switchDetailGame(el.dataset.ver!);
    });
  });

  // M6：评分（再点当前星数 = 清零）
  info.querySelectorAll<HTMLElement>('[data-star]').forEach((el) => {
    clickable(el);
    el.addEventListener('click', async () => {
      const v = Number(el.dataset.star);
      const next = rating === v ? 0 : v;
      // 先登记意图：写盘期间后台缩略图刷新拿到旧快照时，不会被冲回旧评分
      markLocalEdit(g.id, { rating: next });
      try {
        await setRating(g.id, next);
        // 写入期间后台可能刷新过库（state.games 换成新对象），
        // 继续写闭包里的旧 g 只会改到一份没人读的副本，界面还是旧值
        (gameById(g.id) ?? g).rating = next;
        void renderDetail();
      } catch (e) {
        clearLocalEdit(g.id, ['rating']);
        toast(esc(String((e as { message?: string })?.message ?? e)), true);
      }
    });
  });
  // H2：点自定义标签直接移除
  info.querySelectorAll<HTMLElement>('[data-tag]').forEach((el) => {
    clickable(el);
    el.addEventListener('click', async () => {
      const t = el.dataset.tag!;
      const next = userTags.filter((x) => x !== t);
      markLocalEdit(g.id, { userTags: next });
      try {
        await setUserTags(g.id, next);
        (gameById(g.id) ?? g).userTags = next;
        void renderDetail();
      } catch (e) {
        clearLocalEdit(g.id, ['userTags']);
        toast(esc(String((e as { message?: string })?.message ?? e)), true);
      }
    });
  });
  info.querySelector('#dTagAdd')?.addEventListener('click', () => void addUserTag(g));
  info.querySelector('#dNotes')?.addEventListener('click', () => void editNotes(g));
  // 元数据格里的行内动作（结局管理、添加标签、编辑备注）同样是 span
  info.querySelectorAll<HTMLElement>('.linkbtn').forEach(clickable);
  // 同会社推荐：与同名版本一样，在同一屏内切换
  info.querySelectorAll<HTMLElement>('[data-rel]').forEach((el) => {
    clickable(el);
    el.addEventListener('click', () => switchDetailGame(el.dataset.rel!));
  });

  // DOM 刚重建（side/info 都换过），焦点环按新集合重新挂上
  applyDetailRing();
}

/* ============ H1 / H2 / M6 / M8 详情操作 ============ */

/** 改完库数据后统一刷新：先取服务端真值，再重渲染详情 */
async function afterChange(): Promise<void> {
  await refreshLibrary();
  void renderDetail();
}

async function addUserTag(g: Game): Promise<void> {
  const v = await promptInput({ title: '添加标签', sub: '多个标签用空格分隔 · 点标签可移除', cap: 120 });
  if (!v || !v.trim()) return;
  const next = [...(g.userTags ?? []), ...v.trim().split(/\s+/)];
  markLocalEdit(g.id, { userTags: next });
  try {
    await setUserTags(g.id, next);
    await afterChange();
    toast('标签已保存');
  } catch (e) {
    clearLocalEdit(g.id, ['userTags']);
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

async function editNotes(g: Game): Promise<void> {
  const v = await promptInput({
    title: '备注',
    sub: 'Ctrl+Enter 保存 · 最长 4000 字',
    value: g.notes ?? '',
    cap: 4000,
    multiline: true,
  });
  if (v === null) return;
  markLocalEdit(g.id, { notes: v });
  try {
    await setNotes(g.id, v);
    await afterChange();
    toast('备注已保存');
  } catch (e) {
    clearLocalEdit(g.id, ['notes']);
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

async function editArgs(g: Game): Promise<void> {
  const v = await promptInput({
    title: '启动参数',
    sub: '空格分隔，例如 -window -nojoy · 转区启动时会被忽略',
    value: g.launchArgs.join(' '),
  });
  if (v === null) return;
  const args = v.trim() ? v.trim().split(/\s+/) : [];
  // 后端有 32 项 / 1024 字符上限：超限会被拒，必须接住并提示，不能让拒绝冒到全局
  markLocalEdit(g.id, { launchArgs: args });
  try {
    await setLaunchArgs(g.id, args);
  } catch (e) {
    clearLocalEdit(g.id, ['launchArgs']);
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
    return;
  }
  g.launchArgs = args;
  toast(args.length ? `启动参数已保存 · ${args.length} 项` : '已清空启动参数');
  await afterChange();
}

async function manageIso(g: Game): Promise<void> {
  const cur = mountedIso.get(g.id);
  try {
    if (cur) {
      await unmountIso(cur.path);
      mountedIso.delete(g.id);
      toast(`已卸载镜像 ${cur.letter}`);
    } else {
      const p = await pickIso();
      if (!p) return;
      const letter = await mountIso(p);
      mountedIso.set(g.id, { path: p, letter });
      toast(`已挂载为 ${letter} · 在设置里手动添加该盘上的游戏 exe 即可入库`);
    }
    void renderDetail();
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

/** 详情页「更多操作」菜单：与快捷菜单共用同一个 #qmenu 层与键位。
 *  导出是为了让 DOM 测试能直接驱动菜单（候选绑定路径不依赖网络）。 */
export async function openDetailMenu(id: string): Promise<void> {
  const g = gameById(id);
  if (!g) return;
  const iso = mountedIso.get(id);
  const list: MenuItem[] = [
    {
      key: 'exe',
      label: '启动程序…',
      hint: g.exe.split(/[\\/]/).pop() ?? '',
      run: async () => {
        // 从游戏目录开始选：汉化版 / 日文版通常同目录并列，不用再逐层翻
        const picked = await pickExeFile(g.dir || undefined);
        if (!picked || picked === g.exe) return;
        try {
          await setGameExe(id, picked);
        } catch (e) {
          toast(esc(String((e as { message?: string })?.message ?? e)), true);
          return;
        }
        await afterChange();
        toast('启动程序已更新');
      },
    },
    {
      key: 'locale',
      label: '转区设置…',
      hint: (g.localeOverride ?? g.needsLocale) ? '需转区' : '不需要',
      keepOpen: true,
      run: () => openLocaleMenu(id),
    },
    {
      key: 'args',
      label: '启动参数…',
      hint: g.launchArgs.length ? `${g.launchArgs.length} 项` : '',
      run: () => editArgs(g),
    },
    {
      key: 'iso',
      label: iso ? `卸载镜像 ${iso.letter}` : '挂载光盘镜像…',
      run: () => manageIso(g),
    },
    {
      key: 'title',
      label: '重命名…',
      hint: g.title,
      run: async () => {
        const v = await promptInput({ title: '重命名', sub: '留空则恢复原名', value: g.title, cap: 120 });
        if (v === null) return;
        // 非空标题由前端确定，先记意图防止后台旧快照冲回；留空时最终标题由后端按目录重算，
        // 这里无法预知，交给写盘后的 refreshLibrary 读取
        if (v.trim()) markLocalEdit(id, { title: v.trim() });
        else clearLocalEdit(id, ['title']);
        try {
          await setGameTitle(id, v);
        } catch (e) {
          clearLocalEdit(id, ['title']);
          toast(esc(String((e as { message?: string })?.message ?? e)), true);
          return;
        }
        await afterChange();
        toast(v.trim() ? '标题已更新' : '已恢复自动标题');
      },
    },
    {
      key: 'cover',
      label: '更换封面…',
      hint: '›',
      keepOpen: true,
      run: () => openCoverMenu(id),
    },
    {
      key: 'bg',
      label: '背景图…',
      hint: '›',
      keepOpen: true,
      run: () => openBgMenu(id),
    },
    { key: 'tag', label: '添加标签…', run: () => addUserTag(g) },
    { key: 'notes', label: '编辑备注…', hint: g.notes ? '已有' : '', run: () => editNotes(g) },
    {
      key: 'match',
      label: '元数据匹配…',
      hint: g.bangumiId != null || g.matchScore != null ? '已匹配' : '›',
      keepOpen: true,
      run: () => openMatchMenu(id),
    },
    {
      key: 'remove',
      label: '移出库…',
      danger: true,
      hint: '›',
      keepOpen: true,
      run: () => openRemoveMenu(id),
    },
  ];
  await openMenu('游戏管理', g.title, list);
}

/** 子菜单：转区三态（自动 / 需要 / 不需要）。
 *  自动判定会误报（汉化版 / 重打包 / 引擎识别偏差），这里按作品纠正，重启后保留。 */
async function openLocaleMenu(id: string): Promise<void> {
  const g = gameById(id);
  if (!g) return;
  const tick = (on: boolean): string => (on ? '✓ ' : '');
  const items: MenuItem[] = [
    {
      key: 'auto',
      label: `${tick(g.localeOverride == null)}自动判断`,
      hint: g.needsLocale ? '当前：需转区' : '当前：不需要',
      run: () => applyLocale(id, null, '已恢复自动判断'),
    },
    {
      key: 'need',
      label: `${tick(g.localeOverride === true)}需要转区`,
      run: () => applyLocale(id, true, '已设为需要转区'),
    },
    {
      key: 'not',
      label: `${tick(g.localeOverride === false)}不需要转区`,
      run: () => applyLocale(id, false, '已设为不需要转区'),
    },
    { key: 'back', label: '返回', hint: 'B', keepOpen: true, run: () => openDetailMenu(id) },
  ];
  await openMenu('转区设置', g.title, items, { back: () => openDetailMenu(id) });
}

async function applyLocale(id: string, value: boolean | null, msg: string): Promise<void> {
  try {
    await setLocaleOverride(id, value);
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
    return;
  }
  await afterChange();
  toast(msg);
}

/** 子菜单：自动重匹配 / 手动选条目 / 取消匹配。
 *  已匹配的作品也要能改绑——自动匹配只有一次判断，选错条目（同会社同期的另一部）时
 *  以前只能反复按「重新匹配」碰运气；这里直接给候选列表让人挑。 */
async function openMatchMenu(id: string): Promise<void> {
  const g = gameById(id);
  if (!g) return;
  const matched = g.bangumiId != null || g.matchScore != null;
  const items: MenuItem[] = [
    {
      key: 'pick',
      label: '匹配元数据…',
      hint: '四源候选 · 手动选择',
      keepOpen: true,
      run: () => pickCandidates(id),
    },
  ];
  if (matched) {
    items.push({
      key: 'unmatch',
      label: '取消匹配',
      hint: '回到本地 meta.json',
      run: async () => {
        await unmatchGame(id);
        await afterChange();
        toast('已取消匹配 · 已回到本地元数据');
      },
    });
  }
  items.push({ key: 'back', label: '返回', hint: 'B', keepOpen: true, run: () => openDetailMenu(id) });
  await openMenu('元数据匹配', g.title, items, { back: () => openDetailMenu(id) });
}

/** 打开三源统一候选墙：挑一条即时应用（Bangumi 条目 / 萌娘百科 / EGS 评分）。 */
async function pickCandidates(id: string): Promise<void> {
  const g = gameById(id);
  if (!g) return;
  const r = await openCandPanel(id, g.title);
  if (!r) return;
  // 绑定 / 取消匹配都会换封面：让下一次渲染重建封面 DOM
  invalidateDetailArt();
  await afterChange();
  toast(r === 'bind' ? '已应用所选数据' : '已取消匹配 · 已回到本地元数据');
}

/** 子菜单：三种取封面的方式（原先是三行平铺，把菜单撑到溢出屏幕） */
async function openCoverMenu(id: string): Promise<void> {
  const g = gameById(id);
  if (!g) return;
  await openMenu('更换封面', g.title, [
    {
      key: 'file',
      label: '本地图片…',
      run: async () => {
        const p = await pickImageFile();
        if (!p) return;
        await setGameCover(id, p);
        invalidateDetailArt();
        await afterChange();
        toast('封面已更新');
      },
    },
    {
      key: 'auto',
      label: '目录里自动找',
      hint: '智能选',
      run: async () => {
        try {
          await smartCover(id);
          invalidateDetailArt();
          await afterChange();
          toast('已在目录里选好封面');
        } catch (e) {
          toast(esc(String((e as { message?: string })?.message ?? e)), true);
        }
      },
    },
    {
      key: 'sgdb',
      label: 'SteamGridDB',
      hint: '在线',
      run: async () => {
        try {
          await steamgridCover(id);
          invalidateDetailArt();
          await afterChange();
          toast('已从 SteamGridDB 取回封面');
        } catch (e) {
          toast(esc(String((e as { message?: string })?.message ?? e)), true);
        }
      },
    },
    { key: 'back', label: '返回', hint: 'B', keepOpen: true, run: () => openDetailMenu(id) },
  ], { back: () => openDetailMenu(id) });
}

/** 背景图：可视化候选卡片墙（上方画面 + 下方文字），点选即应用；
 *  另留「指定图片…」与「恢复自动」两个入口（面板里 P / R 也能触发）。 */
async function openBgMenu(id: string): Promise<void> {
  const g = gameById(id);
  if (!g) return;
  const choice = await openBgPanel(id, g.title);
  if (!choice) return;
  if (choice === BG_PICK) {
    const p = await pickImageFile();
    if (!p) return;
    try {
      // 背景图固定写 <id>_bg.jpg：同名覆盖必须换 URL，否则 WebView 一直显示旧图
      const saved = await setGameBackground(id, p);
      touchAsset(saved);
      forgetDetailBg(id); // 缓存里的路径已换图，下次重绘要重新解码新 URL
      await afterChange();
      toast('背景图已更新');
    } catch (e) {
      toast(esc(String((e as { message?: string })?.message ?? e)), true);
    }
    return;
  }
  if (choice === BG_AUTO) {
    try {
      await clearGameBackground(id);
      forgetDetailBg(id);
      await afterChange();
      toast('已恢复自动背景');
    } catch (e) {
      toast(esc(String((e as { message?: string })?.message ?? e)), true);
    }
    return;
  }
  try {
    const saved = await useBackgroundCandidate(id, choice);
    touchAsset(saved);
    forgetDetailBg(id);
    await afterChange();
    toast('背景图已更新');
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

/** 子菜单：隐藏（可恢复）与彻底移除分开，避免误触 */
async function openRemoveMenu(id: string): Promise<void> {
  const g = gameById(id);
  if (!g) return;
  await openMenu('移出库', g.title, [
    {
      key: 'hide',
      label: g.hidden ? '取消隐藏' : '隐藏这部',
      hint: '可恢复',
      run: async () => {
        // 先记下「本来是不是隐藏的」：这次操作就是把它取反。
        // 写盘后不要去读刷新过的副本——刷新失败 / 慢一步时会读到旧值，把分支走反。
        const wasHidden = gameById(id)?.hidden ?? g.hidden;
        markLocalEdit(id, { hidden: !wasHidden });
        try {
          await setHidden(id, !wasHidden);
        } catch (e) {
          clearLocalEdit(id, ['hidden']);
          toast(esc(String((e as { message?: string })?.message ?? e)), true);
          return;
        }
        await afterChange();
        if (!wasHidden) {
          // 隐藏后作品不再属于四屏浏览：清掉残留 detailId，否则数字 3 会回到已隐藏作品的详情
          state.detailId = null;
          setScreen('library');
          toast('已隐藏 · 设置 · 库可恢复');
        } else {
          toast('已取消隐藏');
        }
      },
    },
    {
      key: 'remove',
      label: '从库中移除…',
      hint: '不可恢复',
      run: async () => {
        const ok = await promptConfirm({
          title: '移除出库',
          // 说清副作用：移除会同时进忽略表，否则用户会以为下次扫描还能找回来
          sub: '只移除索引，不删除游戏文件；同时加入忽略列表，重扫不会再导入（设置 → 库与统计 可恢复）',
        });
        if (!ok) return;
        await removeGame(id);
        await refreshLibrary();
        // 条目已不存在：不清 detailId 的话，数字 3 会进「作品已不在库中」的占位详情
        state.detailId = null;
        setScreen('library');
        toast('已从库中移除 · 重扫不再导入');
      },
    },
    {
      key: 'delete',
      label: '删除游戏目录…',
      hint: '进回收站',
      danger: true,
      run: async () => {
        // 完整路径必须出现在确认框里：这是唯一会动文件的操作
        const ok = await promptConfirm({
          title: '删除游戏目录',
          sub: `将把整个目录移入系统回收站（可还原；该磁盘未启用回收站时会直接删除），并从库中移除这部作品：\n${g.dir}`,
        });
        if (!ok) return;
        try {
          await deleteGameDir(id);
        } catch (e) {
          // 后端护栏 / 回收站失败：文件仍在，直接报错让用户手动处理
          toast(esc(String((e as { message?: string })?.message ?? e)), true);
          return;
        }
        await refreshLibrary();
        // 条目已不存在：不清 detailId 的话，数字 3 会进「作品已不在库中」的占位详情
        state.detailId = null;
        setScreen('library');
        toast('已移入回收站 · 可从回收站还原');
      },
    },
    { key: 'back', label: '返回', hint: 'B', keepOpen: true, run: () => openDetailMenu(id) },
  ], { back: () => openDetailMenu(id) });
}

export function initDetail(): void {
  registerHandler('detail', (n: NavIntent) => {
    if (n.intent === 'back') {
      ringClear(detailRingEls()); // 回库时别把这圈焦点带回去
      const back = state.detailFrom;
      const viaSearch = state.detailFromSearch;
      state.detailFrom = 'library';
      state.detailFromSearch = false;
      setScreen(back);
      // 从搜索面板进来的：回到来处后重开面板并保留关键词，位置不丢
      if (viaSearch) void import('../search').then((m) => m.openSearch(true));
      return;
    }
    if (n.intent === 'accept') {
      ringActivate(detailRingEls()[detailIdx]);
      return;
    }
    if (n.intent === 'move' && (n.dir === 'up' || n.dir === 'down')) {
      const els = detailRingEls();
      if (!els.length) return;
      detailIdx = (detailIdx + (n.dir === 'down' ? 1 : els.length - 1)) % els.length;
      ringFocus(els, detailIdx);
      return;
    }
    // ← / →：同名版本之间按环循环（汉化 → 生肉 → 汉化…）。没有版本时不动，键盘与手柄同一套。
    if (n.intent === 'move' && (n.dir === 'left' || n.dir === 'right')) {
      if (verRing.length < 2) return;
      const step = n.dir === 'right' ? 1 : -1;
      verIdx = (verIdx + step + verRing.length) % verRing.length;
      const nextId = verRing[verIdx];
      if (nextId) switchDetailGame(nextId);
    }
  });
  // Y 结局标记 / R 收藏（keybar 声明的键位此前只在设计稿生效，实机补接）
  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'detail' || anyState()) return;
    if (e.code === 'KeyY') {
      document.getElementById('dEnds')?.click();
      // 只消费这一次 Y：面板打开后 nav / overlay 还会收到同一个事件，
      // 它们看到 endPanel 已开就会把 Y 当「新增结局」，凭空多一条 END。
      e.stopImmediatePropagation();
      e.preventDefault();
    }
    if (e.code === 'KeyR') {
      document.getElementById('dFav')?.click();
      e.preventDefault();
    }
  });
}

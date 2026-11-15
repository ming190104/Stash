/** 详情屏：全屏 KV + 信息面板（mockup buildDetail 迁移；截图改右侧按钮进查看器）。 */

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
  unmatchGame,
  captureScreenshot,
} from '../ipc';
import { state, gameById, setScreen, versionGroup } from '../state';
import { registerHandler } from '../nav';
import { toast, esc, fmtRelative, fmtDuration, press, ringEls, ringFocus, ringClear, ringActivate, cnFirst, clickable } from '../ui';
import { artHTML, hydrateArts } from './art';
import { clearHTML, setRawHTML } from '../html';
import { toggleFav, refreshLibrary } from './library';
import { paintDetailArt, forgetDetailBg, prepareDetailBg } from './detail-bg';
import { anyState, openShots, openEndings } from '../overlay';
import { promptConfirm, promptInput } from '../prompt';
import { openMenu, close, type MenuItem } from '../quick';
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
/** 上一次渲染用的封面图源：图源没变就不重建 DOM（`.art img` 有 300ms 淡入，重建会闪） */
let lastArtKey: string | null = null;
/** 本次进入详情页（由 openDetail 打标记）：只有「翻到详情」才播放卷轴展开，评星/改标签等局刷不动 */
let enterFresh = false;

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
  state.detailId = id;
  void prepareDetailBg(id).then(() => {
    if (state.detailId !== id) return; // 等待期间又切走了：交给后来那次渲染
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
  const rating = g.rating ?? 0;
  const stars = Array.from({ length: 5 }, (_, i) => `<span class="dstar${i < rating ? ' on' : ''}" data-star="${i + 1}">★</span>`).join('');
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

  setRawHTML(
    info,
    `
    <div class="d-cn">${esc(g.title)}</div>
    <div class="d-jp">${esc(g.titleOriginal || g.title)}${g.romaji ? ' · ' + esc(g.romaji) : ''}</div>
    <div class="d-pills">${pills.join('')}</div>
    <p class="d-sum">${esc(cnFirst(g.summary ?? '') || '尚未匹配元数据——当前信息来自本地目录。可在「设置 · 元数据」里运行 Bangumi 匹配。')}</p>
    <div class="d-meta">
      <div>开发商<b>${esc(g.developer ?? '—')}</b></div><div>发售日<b>${g.year ?? '—'}</b></div><div>参考<b>${refText(g)}</b></div><div>元数据<b>${esc(srcLabel)}</b></div><div>引擎<b>${esc(g.engineLabel)}${g.needsLocale ? '<i class="warn"> · 需转区</i>' : ''}</b></div>
      <div>最近游玩<b>${fmtRelative(g.lastPlayed)}</b></div><div>累计时长<b>${fmtDuration(g.playSeconds)}</b></div><div>启动次数<b>${g.playCount} 次</b></div>
      <div>通关进度<b>${Math.round(g.progress * 100)}%</b></div>
      <div>结局<b>${g.endings.length ? `${endsDone}/${g.endings.length}` : '—'}</b>${g.endings.length ? `<span class="linkbtn" id="dEnds">管理</span>` : `<span class="linkbtn" id="dEnds">标记…</span>`}</div>
      <div>评分<b class="dstars">${stars}</b></div>
      <div>标签<b>${userTags.length}</b><span class="linkbtn" id="dTagAdd">添加</span></div>
      <div>备注<b>${g.notes ? '已写' : '—'}</b><span class="linkbtn" id="dNotes">编辑</span></div>
      ${sess.length ? `<div class="d-sess"><span>最近场次</span>${sess.map((s) => `<b>${esc(fmtRelative(s.at))} · ${esc(fmtDuration(s.seconds))}</b>`).join('')}</div>` : ''}
      ${versions.length ? `<div class="d-ver"><span>同名版本</span>${versions.map((v) => `<span class="vchip" data-ver="${esc(v.id)}">${esc(baseDir(v.dir))}</span>`).join('')}</div>` : ''}
    </div>`,
  );

  // 截图收进右侧按钮：三张缩略图会挤占 KV 画面，点按钮再进全屏查看器
  setRawHTML(
    side,
    `
    <button class="cta" id="dPlay"><span class="k">A</span>启动游戏</button>
    <button class="ghost" id="dFav"><span class="k">RB</span>${g.favorite ? '★ 已收藏' : '☆ 加入收藏'}</button>
    <button class="ghost" id="dShots">${g.shots.length ? `截图 · ${g.shots.length} 张` : '截图'}</button>
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
  side.querySelector('#dShots')?.addEventListener('click', () => {
    press('#dShots');
    if (!g.shots.length) {
      toast('还没有截图 · 游戏内按手柄「截图」键（键位页可改，默认 Select）');
      return;
    }
    // 从最新一张开始（shots 数组按时间正序，末尾是最新）
    openShots(g.id, g.shots, g.shots.length - 1);
  });
  side.querySelector('#dOpen')?.addEventListener('click', () => {
    press('#dOpen');
    openDir(g.id).catch((e) => toast(esc(String((e as { message?: string })?.message ?? e)), true));
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
      try {
        await setRating(g.id, next);
        g.rating = next;
        void renderDetail();
      } catch (e) {
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
      try {
        await setUserTags(g.id, next);
        g.userTags = next;
        void renderDetail();
      } catch (e) {
        toast(esc(String((e as { message?: string })?.message ?? e)), true);
      }
    });
  });
  info.querySelector('#dTagAdd')?.addEventListener('click', () => void addUserTag(g));
  info.querySelector('#dNotes')?.addEventListener('click', () => void editNotes(g));
  // 元数据格里的行内动作（结局管理、添加标签、编辑备注）同样是 span
  info.querySelectorAll<HTMLElement>('.linkbtn').forEach(clickable);

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
  try {
    await setUserTags(g.id, next);
    await afterChange();
    toast('标签已保存');
  } catch (e) {
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
  try {
    await setNotes(g.id, v);
    await afterChange();
    toast('备注已保存');
  } catch (e) {
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
  await setLaunchArgs(g.id, args);
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
        await setGameTitle(id, v);
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
      key: 'shot',
      label: '截屏',
      hint: '抓主屏',
      run: async () => {
        // 菜单是应用内浮层：先收起并等过渡结束，避免把它一起拍进 PNG
        close();
        await new Promise((r) => window.setTimeout(r, 260));
        await captureScreenshot(id);
        await afterChange();
        toast('已截图到 shots/');
      },
    },
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
      hint: '›',
      keepOpen: true,
      run: () => openRemoveMenu(id),
    },
  ];
  await openMenu('游戏管理', g.title, list);
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
        await setHidden(id, !g.hidden);
        await afterChange();
        if (!g.hidden) {
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
          sub: '只移除索引，不删除游戏文件',
        });
        if (!ok) return;
        await removeGame(id);
        await refreshLibrary();
        // 条目已不存在：不清 detailId 的话，数字 3 会进「作品已不在库中」的占位详情
        state.detailId = null;
        setScreen('library');
        toast('已从库中移除');
      },
    },
    { key: 'back', label: '返回', hint: 'B', keepOpen: true, run: () => openDetailMenu(id) },
  ], { back: () => openDetailMenu(id) });
}

export function initDetail(): void {
  registerHandler('detail', (n: NavIntent) => {
    if (n.intent === 'back') {
      ringClear(detailRingEls()); // 回库时别把这圈焦点带回去
      setScreen('library');
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
    // ← / →：同名版本之间切换（汉化 ↔ 生肉）。没有版本时不动，键盘与手柄同一套。
    if (n.intent === 'move' && (n.dir === 'left' || n.dir === 'right')) {
      const others = [...document.querySelectorAll<HTMLElement>('#dInfo .vchip')]
        .map((el) => el.dataset.ver)
        .filter((x): x is string => !!x);
      if (!others.length || !state.detailId) return;
      const ring = [state.detailId, ...others];
      const cur = Math.max(0, ring.indexOf(state.detailId));
      const step = n.dir === 'right' ? 1 : -1;
      const next = ring[(cur + step + ring.length) % ring.length];
      switchDetailGame(next);
    }
  });
  // Y 结局标记 / R 收藏（keybar 声明的键位此前只在设计稿生效，实机补接）
  window.addEventListener('keydown', (e) => {
    if (state.screen !== 'detail' || anyState()) return;
    if (e.code === 'KeyY') {
      document.getElementById('dEnds')?.click();
      e.preventDefault();
    }
    if (e.code === 'KeyR') {
      document.getElementById('dFav')?.click();
      e.preventDefault();
    }
  });
}

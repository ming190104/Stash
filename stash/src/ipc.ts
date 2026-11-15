/** IPC 封装：Tauri 可用时走 invoke，浏览器直开（vite dev）时走 mock 数据。
 *  mock 模式用于纯 UI 开发与校验，占位美术同样是正式降级设计。 */

import type { EndMark, Game, HealthReport, MetaCandidate, Settings } from './types';
import { normalizePadMap, normalizePadTuning } from './padmap';

export const TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/* ============ 运行时兜底 ============
 * Rust 侧结构漂移（字段改名 / 偶发 null）不能直接把界面打崩：核心字段缺失的条目丢弃并 warn，
 * 数组 / 嵌套对象缺失补安全默认值。只做「不崩」级别的校验，不做完整 schema。 */

function warnDropped(what: string, n: number): void {
  if (n > 0) console.warn(`[ipc] ${what}：丢弃 ${n} 条结构不完整的记录`);
}

/** 库返回兜底：缺 id/title/dir 的条目丢弃；数组字段缺失补空数组 */
export function sanitizeLibrary(raw: unknown): Game[] {
  if (!Array.isArray(raw)) {
    console.warn('[ipc] get_library 返回的不是数组，按空库处理');
    return [];
  }
  const out: Game[] = [];
  let dropped = 0;
  for (const x of raw) {
    const g = x as Partial<Game> | null;
    if (!g || typeof g.id !== 'string' || !g.id || typeof g.title !== 'string' || typeof g.dir !== 'string') {
      dropped++;
      continue;
    }
    out.push({
      ...(g as Game),
      tags: Array.isArray(g.tags) ? g.tags : [],
      userTags: Array.isArray(g.userTags) ? g.userTags : [],
      aliases: Array.isArray(g.aliases) ? g.aliases : [],
      endings: Array.isArray(g.endings) ? g.endings : [],
      shots: Array.isArray(g.shots) ? g.shots : [],
      sessions: Array.isArray(g.sessions) ? g.sessions : [],
      launchArgs: Array.isArray(g.launchArgs) ? g.launchArgs : [],
    });
  }
  warnDropped('get_library', dropped);
  return out;
}

/** 设置返回兜底：界面会直接解引用的嵌套对象全部补默认值，非法枚举回落 */
export function sanitizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const out = { ...s } as Settings;
  let patched = 0;
  const need = (ok: boolean): boolean => {
    if (!ok) patched++;
    return ok;
  };
  if (!need(typeof out.version === 'number')) out.version = 2;
  if (!need(typeof out.theme === 'string')) out.theme = 'cinema';
  if (!need(out.layout === 'classic' || out.layout === 'list' || out.layout === 'wall')) out.layout = 'classic';
  if (!need(typeof out.motion === 'number')) out.motion = 0;
  if (!need(typeof out.animSpeed === 'number')) out.animSpeed = 1;
  if (!need(out.bootAnim === 'core' || out.bootAnim === 'warp' || out.bootAnim === 'off')) out.bootAnim = 'core';
  if (!need(typeof out.verticalTitle === 'boolean')) out.verticalTitle = true;
  if (!need(typeof out.autostart === 'boolean')) out.autostart = false;
  if (!need(typeof out.fullscreen === 'boolean')) out.fullscreen = true;
  if (!need(typeof out.gamepadMouse === 'boolean')) out.gamepadMouse = false;
  if (!need(typeof out.power60 === 'boolean')) out.power60 = false;
  if (!need(!!(out.sound && typeof out.sound === 'object'))) out.sound = { enabled: true, gain: 0.6 };
  if (!need(!!(out.network && typeof out.network === 'object'))) out.network = { metadataEnabled: false };
  if (!need(!!(out.locale && typeof out.locale === 'object'))) out.locale = { warnOnly: true, toolPath: null, launch: false };
  if (!need(Array.isArray(out.libraryRoots))) out.libraryRoots = [];
  out.libraryRoots = (out.libraryRoots ?? []).filter((p) => typeof p === 'string' && !!p.trim());
  if (patched) console.warn(`[ipc] get_settings：补齐 ${patched} 个缺失字段`);
  out.padMap = normalizePadMap(out);
  out.padTuning = normalizePadTuning(out.padTuning);
  return out;
}

const META_SOURCES = new Set(['bangumi', 'moegirl', 'egs', 'kungal']);

/** 四源候选兜底：来源未知、key / 标题缺失的条目丢弃 */
export function sanitizeMetaCandidates(raw: unknown): MetaCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.filter((c): c is MetaCandidate => {
    const x = c as Partial<MetaCandidate> | null;
    return (
      !!x &&
      typeof x.source === 'string' &&
      META_SOURCES.has(x.source) &&
      typeof x.key === 'string' &&
      !!x.key &&
      typeof x.title === 'string'
    );
  });
  warnDropped('match_candidates_all', raw.length - out.length);
  return out;
}

export async function getLibrary(): Promise<Game[]> {
  if (TAURI) return inv<unknown>('get_library').then(sanitizeLibrary);
  // 浏览器预览的 mock 数据只在 dev 构建里打包；发布构建此分支被摇树移除
  if (import.meta.env.DEV) return (await import('./mock')).MOCK_GAMES;
  return [];
}

/** 手动添加单部作品：选主程序 exe + 标题，绕过目录识别门槛直接入库 */
export async function addGame(exe: string, title: string): Promise<Game> {
  if (!TAURI) throw new Error('浏览器预览不支持手动添加');
  return inv<Game>('add_game', { exe, title });
}

export interface PadStatus {
  connected: boolean;
  name: string;
  /** xbox / playstation / nintendo；旧后端可能不带 */
  kind?: string;
  /** wired / charging:NN / discharging:NN / charged / unknown */
  power?: string;
  /** 是否支持力反馈；旧后端可能不带 */
  ff?: boolean;
}

/** 手柄是否已连接：`pad://status` 事件可能在页面就绪前发出（丢了收不到），
 *  启动时补查一次，底栏据此决定显示手柄键位还是键盘键位。 */
export async function padStatus(): Promise<PadStatus> {
  return TAURI ? inv<PadStatus>('pad_status') : { connected: false, name: '' };
}

export async function getSettings(): Promise<Settings> {
  if (TAURI) {
    const raw = await inv<unknown>('get_settings');
    // 旧配置只有 abSwap、没有键位表：sanitizeSettings 里统一补默认并回填互换结果
    return sanitizeSettings(raw);
  }
  // 与 getLibrary 同口径：mock 数据只在 dev 构建里打包，发布构建此分支被摇树移除
  const m = import.meta.env.DEV ? await import('./mock') : null;
  if (!m) throw new Error('浏览器预览需要 dev 构建');
  return sanitizeSettings(m.mockSettings());
}

export async function updateSettings(s: Settings): Promise<void> {
  if (TAURI) await inv('update_settings', { settings: s });
}

/* ============ P3 掌机化：开机自启 + 全屏 ============ */

/** 开关开机自启（写 HKCU\...\Run；浏览器预览下为 no-op） */
export async function setAutostart(enabled: boolean): Promise<void> {
  if (TAURI) await inv('set_autostart', { enabled });
}

/** 注册表里是否真的有启动项（用户可能在任务管理器里手动关掉） */
export async function autostartEnabled(): Promise<boolean> {
  return TAURI ? inv<boolean>('autostart_enabled') : false;
}

/** 全屏切换（设置项落盘由调用方负责） */
export async function setFullscreen(enabled: boolean): Promise<void> {
  if (TAURI) await inv('set_fullscreen', { enabled });
}

/** 锁 60Hz 省电 / 还原，返回切换后的实际刷新率（浏览器预览下直接返回 60） */
export async function setPower60(enabled: boolean): Promise<number> {
  return TAURI ? inv<number>('set_power60', { enabled }) : 60;
}

/** 收藏落盘（游玩记录字段，改一次写一次盘） */
export async function setFavorite(id: string, favorite: boolean): Promise<void> {
  if (TAURI) await inv('set_favorite', { id, favorite });
}

/** 每游戏启动参数落盘（P4 B10） */
export async function setLaunchArgs(id: string, args: string[]): Promise<void> {
  if (TAURI) await inv('set_launch_args', { id, args });
}

/** 挂载 ISO，返回盘符（如 "H:"）；需要管理员权限 */
export async function mountIso(path: string): Promise<string> {
  return TAURI ? inv<string>('mount_iso', { path }) : 'H:';
}

export async function unmountIso(path: string): Promise<void> {
  if (TAURI) await inv('unmount_iso', { path });
}

/* ============ H1 库管理 / H2 标签 / M6 记录 ============ */

export async function removeGame(id: string): Promise<void> {
  if (TAURI) await inv('remove_game', { id });
}

export async function setGameTitle(id: string, title: string): Promise<void> {
  if (TAURI) await inv('set_game_title', { id, title });
}

export async function setGameCover(id: string, path: string | null): Promise<void> {
  if (TAURI) await inv('set_game_cover', { id, path });
}

/** 智能选封面（本地启发式：尺寸 / 长宽比 / 黑边）：返回新封面路径 */
export interface SmartCoverOut {
  cover: string;
}

export async function smartCover(id: string): Promise<SmartCoverOut> {
  return inv<SmartCoverOut>('smart_cover', { id });
}

export async function steamgridCover(id: string): Promise<string> {
  return inv<string>('steamgrid_cover', { id });
}

/** 详情页背景图：`fetch=false` 只查本地缓存；`true` 还会去 SteamGridDB 取一张商店横幅 */
export async function detailBackground(id: string, fetch = false): Promise<string | null> {
  if (!TAURI) return null;
  return inv<string | null>('detail_background', { id, fetch });
}

/** 手动指定背景图（复制进 covers/<id>_bg.*），返回新的背景图路径 */
export async function setGameBackground(id: string, src: string): Promise<string> {
  return inv<string>('set_game_background', { id, src });
}

/** 背景候选卡片：`thumb` 是后端生成好的 16:9 本地缩略图（前端只走 asset: 协议） */
export interface BgCandidate {
  key: string;
  label: string;
  /** current / local / sgdb */
  source: string;
  width: number;
  height: number;
  thumb: string | null;
  current: boolean;
}

/** 候选返回兜底：缺 key / label 的条目丢弃（面板无法操作它），缩略图路径非字符串按无预览处理 */
function sanitizeBgCandidates(raw: unknown): BgCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: BgCandidate[] = [];
  let dropped = 0;
  for (const x of raw) {
    const c = x as Partial<BgCandidate> | null;
    if (!c || typeof c.key !== 'string' || !c.key || typeof c.label !== 'string') {
      dropped++;
      continue;
    }
    out.push({
      key: c.key,
      label: c.label,
      source: typeof c.source === 'string' ? c.source : '',
      width: typeof c.width === 'number' ? c.width : 0,
      height: typeof c.height === 'number' ? c.height : 0,
      thumb: typeof c.thumb === 'string' && c.thumb ? c.thumb : null,
      current: !!c.current,
    });
  }
  warnDropped('background_candidates', dropped);
  return out;
}

/** 背景候选：当前背景 / 目录截图 / 商店横幅。
 *  `online=false` 只取本地（首屏立即出卡片），`true` 再补一次在线候选。 */
export async function backgroundCandidates(id: string, online = false): Promise<BgCandidate[]> {
  if (!TAURI) return [];
  return inv<unknown>('background_candidates', { id, online }).then(sanitizeBgCandidates);
}

/** 应用某张候选，返回 covers/<id>_bg.jpg 的新路径 */
export async function useBackgroundCandidate(id: string, key: string): Promise<string> {
  if (!TAURI) throw new Error('浏览器预览不支持背景图');
  return inv<string>('use_background_candidate', { id, key });
}


/** 恢复自动背景（删掉自定义背景图） */
export async function clearGameBackground(id: string): Promise<void> {
  if (TAURI) await inv('clear_game_background', { id });
}

export async function setHidden(id: string, hidden: boolean): Promise<void> {
  if (TAURI) await inv('set_hidden', { id, hidden });
}

export async function setUserTags(id: string, tags: string[]): Promise<void> {
  if (TAURI) await inv('set_user_tags', { id, tags });
}

export async function setNotes(id: string, notes: string): Promise<void> {
  if (TAURI) await inv('set_notes', { id, notes });
}

export async function setRating(id: string, rating: number): Promise<void> {
  if (TAURI) await inv('set_rating', { id, rating });
}

/* ============ H3 匹配取消 ============ */

export async function cancelMatch(): Promise<void> {
  if (TAURI) await inv('cancel_match');
}

/* ============ M7 导出 / 导入 ============ */

export async function exportData(path: string): Promise<number> {
  return TAURI ? inv<number>('export_data', { path }) : 0;
}

export async function importData(path: string): Promise<number> {
  return TAURI ? inv<number>('import_data', { path }) : 0;
}

/* ============ 库体检 ============ */

const EMPTY_HEALTH: HealthReport = {
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

export async function libraryHealth(): Promise<HealthReport> {
  if (TAURI) return inv<HealthReport>('library_health');
  if (!import.meta.env.DEV) return EMPTY_HEALTH;
  const total = (await import('./mock')).MOCK_GAMES.length;
  return { ...EMPTY_HEALTH, total };
}

/** 移除目录/主程序已丢失的条目，返回移除数量 */
export async function pruneMissingGames(): Promise<number> {
  return TAURI ? inv<number>('prune_missing_games') : 0;
}

/** 批量清理结果 */
export interface CleanOut {
  freedBytes: number;
  cacheRemoved: number;
}

/** 批量清理无用缓存（孤儿缩略图 / 封面 / .tmp） */
export async function cleanStorage(): Promise<CleanOut> {
  return TAURI
    ? inv<CleanOut>('clean_storage')
    : { freedBytes: 0, cacheRemoved: 0 };
}

/** 保存对话框（JSON） */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!TAURI) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const p = await save({ defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] });
  return typeof p === 'string' ? p : null;
}

/** 打开对话框（JSON） */
export async function pickJsonFile(): Promise<string | null> {
  if (!TAURI) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const p = await open({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
  return typeof p === 'string' ? p : null;
}

/** 打开对话框（封面图片） */
export async function pickImageFile(): Promise<string | null> {
  if (!TAURI) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const p = await open({
    multiple: false,
    filters: [{ name: '封面图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  });
  return typeof p === 'string' ? p : null;
}

/** 启动窗口内（转区接管最长 8 秒）重复按键：前端直接拦下，避免后端 AlreadyRunning 弹错误提示。
 *  但后端若因转区接管等原因长时间不返回，这把锁不能永久卡死——超时后放行。 */
const LAUNCH_TIMEOUT_MS = 20_000;
let launchBusy = false;
/** 用 token 区分「这一轮启动」：看门狗放行后旧请求才返回时，不能把新一轮的锁清掉 */
let launchToken: symbol | null = null;

export async function launchGame(id: string): Promise<void> {
  if (!TAURI) return;
  // 静默丢弃重复启动：后端 AlreadyRunning 的报错提示对连按没有意义
  if (launchBusy) return;
  launchBusy = true;
  const token = Symbol('launch');
  launchToken = token;
  const watchdog = window.setTimeout(() => {
    if (launchToken !== token) return;
    launchBusy = false;
    launchToken = null;
    console.warn('[ipc] launch_game 超过 20s 未返回，已放行后续启动');
  }, LAUNCH_TIMEOUT_MS);
  try {
    await inv('launch_game', { id });
  } finally {
    window.clearTimeout(watchdog);
    if (launchToken === token) {
      launchBusy = false;
      launchToken = null;
    }
  }
}

export async function stopGame(id: string): Promise<void> {
  if (TAURI) await inv('stop_game', { id });
}

export async function openDir(id: string): Promise<void> {
  if (TAURI) await inv('open_dir', { id });
}

/** 关于页自助排障：打开数据目录（kind="data"）或日志目录（"logs"） */
export async function openAppDir(kind: 'data' | 'logs'): Promise<void> {
  if (TAURI) await inv('open_app_dir', { kind });
}

/* ============ 更新检查 ============ */

export interface UpdateInfo {
  /** 当前版本（与安装包一致） */
  current: string;
  /** 最新 Release 的版本号（已去掉前缀 v） */
  latest: string;
  /** 下载页（github.com） */
  url: string;
  newer: boolean;
}

/** 查 GitHub 最新 Release。必须走 Rust：前端 CSP 的 connect-src 不放行外网 */
export async function checkUpdate(): Promise<UpdateInfo> {
  if (!TAURI) throw new Error('浏览器预览不检查更新');
  return inv<UpdateInfo>('check_update');
}

/** 用系统默认浏览器打开 http(s) 链接 */
export async function openExternal(url: string): Promise<void> {
  if (TAURI) await inv('open_url', { url });
}

/* ============ 只读文件浏览（设置 · 库 → 浏览文件） ============ */

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** 目录恒为 0（不递归统计） */
  size: number;
  /** 修改时间（Unix 秒），取不到为 0 */
  modified: number;
  hidden: boolean;
}

export interface FsDrive {
  /** "C:" */
  name: string;
  /** "C:\" */
  path: string;
}

export interface FsListing {
  /** null = 盘符列表（此电脑） */
  path: string | null;
  parent: string | null;
  entries: FsEntry[];
  drives: FsDrive[];
  truncated: boolean;
}

/** 列目录；path 为空/不传 = 盘符列表 */
export async function fsList(path?: string | null): Promise<FsListing> {
  if (!TAURI) {
    return { path: null, parent: null, entries: [], drives: [], truncated: false };
  }
  return inv<FsListing>('fs_list', { path: path ?? null });
}

export interface LogIssue {
  time: string;
  level: string;
  text: string;
}

/** 最近几条 WARN / ERROR（关于页展示，便于用户自己先看原因） */
export async function recentLogIssues(limit = 6): Promise<LogIssue[]> {
  return TAURI ? inv<LogIssue[]>('recent_log_issues', { limit }) : [];
}

/** 导出诊断报告（版本 / 环境 / 设置脱敏 / 库统计 / 最近问题），返回落盘路径 */
export async function exportDiagnostics(): Promise<string> {
  return TAURI ? inv<string>('export_diagnostics') : Promise.reject(new Error('仅桌面版可用'));
}

/** 启动耗时埋点：name 为阶段名，ms 为前端 performance.now() 读数（后端同时记进程耗时） */
export function reportTiming(name: string, ms?: number): void {
  if (!TAURI) return;
  // 埋点失败不能影响启动：吞掉即可，日志里缺一行比白屏好
  inv('report_timing', { name, ms }).catch(() => undefined);
}

/** 本地文件路径 → 可显示 URL（asset 协议） */
/** 本地图的版本号：同名覆盖（背景图 / 换封面）时用来绕开 WebView 的 URL 缓存。
 *  文件名不变、内容变了的话，asset.localhost 会一直吐旧图，必须换 URL。 */
const ASSET_VER = new Map<string, number>();

/** 刚覆盖写过某个本地图：让下一次 asset() 给它一个新 URL */
export function touchAsset(path: string): void {
  ASSET_VER.set(path, (ASSET_VER.get(path) ?? 0) + 1);
}

export async function asset(path: string): Promise<string> {
  if (!TAURI) return path;
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  const url = convertFileSrc(path);
  const v = ASSET_VER.get(path);
  return v ? `${url}?v=${v}` : url;
}

/** 订阅失败提示只弹一次：多个订阅同时挂时不刷屏 */
let eventFailWarned = false;

/** 订阅 Rust 事件；mock 模式返回空退订函数。
 *  订阅失败不外抛：调用点多为 fire-and-forget，否则会变成 unhandled rejection。
 *  但不能完全无感——matchRunning 复位、运行遮罩关闭都依赖事件回调，
 *  静默吞错会让这些状态机卡死且用户无从知晓，所以至少提示一次。 */
export async function onEvent<T>(name: string, cb: (payload: T) => void): Promise<() => void> {
  if (!TAURI) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<T>(name, (e) => cb(e.payload));
  } catch (e) {
    console.error(`[ipc] 订阅 ${name} 失败：`, e);
    if (!eventFailWarned) {
      eventFailWarned = true;
      void import('./ui')
        .then((m) => m.toast('事件通道异常，部分状态可能不会自动刷新，建议重启应用', true))
        .catch(() => {});
    }
    return () => {};
  }
}

/* ============ END / 路线标记（P2） ============ */

/** 当前运行中的游戏（启动后对账用；没有则 null） */
export async function runningGame(): Promise<Game | null> {
  if (!TAURI) return null;
  return inv<Game | null>('running_game');
}

/** 整份清单回写（增删改都走这一条，避免索引漂移）；返回推导后的进度 */
export async function updateEndings(id: string, endings: EndMark[]): Promise<number> {
  if (!TAURI) {
    if (!import.meta.env.DEV) return 0;
    // 浏览器预览：直接改 mock 数据，刷新后能看到进度联动
    const g = (await import('./mock')).MOCK_GAMES.find((x) => x.id === id);
    if (!g) return 0;
    g.endings = endings;
    const done = endings.filter((e) => e.done).length;
    if (endings.length) g.progress = done / endings.length;
    return g.progress;
  }
  return inv<number>('update_endings', { id, endings });
}

/* ============ Bangumi 元数据（总案第 7 章） ============ */

/** 网络自检：真实发一次搜索请求 */
export async function testNetwork(): Promise<string> {
  if (!TAURI) return '浏览器预览：未接 Tauri 网络层';
  return inv<string>('test_network');
}

/** 单个数据源的探测状态（与后端 SourceStatus 对应） */
export type SourceState = 'ok' | 'offline' | 'limited' | 'error' | 'disabled' | 'skipped';

export interface SourceStatus {
  status: SourceState;
  message: string;
}

/** 元数据源可达性探测结果（设置 · 元数据页） */
export interface SourceProbe {
  bangumi: SourceStatus;
  moegirl: SourceStatus;
  egs: SourceStatus;
  kungal: SourceStatus;
  /** 当前生效代理；null = 直连 */
  proxy: string | null;
  /** Bangumi 或萌娘百科任一可用 */
  usable: boolean;
  message: string | null;
}

/** 逐源探测：结构化返回每个源的状态与当前代理 */
export async function probeSources(): Promise<SourceProbe | null> {
  if (!TAURI) return null;
  return inv<SourceProbe>('probe_sources');
}

/** 全量匹配（后台线程跑，进度走 match://progress） */
export async function matchAll(force = false): Promise<void> {
  if (TAURI) await inv('match_all', { force });
}

/** 全量匹配是否仍在后台进行（done 事件丢失时前端用它兜底收尾） */
export async function matchRunning(): Promise<boolean> {
  return TAURI ? inv<boolean>('match_running') : false;
}

/** 四源并行候选（Bangumi / 萌娘百科 / 批评空间 / 鲲 Galgame），人工选择用 */
export async function metaCandidates(id: string, limit = 4): Promise<MetaCandidate[]> {
  if (!TAURI) return [];
  return inv<unknown>('match_candidates_all', { id, limit }).then(sanitizeMetaCandidates);
}

/** 字段 id：只写这些字段；省略 = 全部。传空数组 = 只确认条目、不覆盖元数据。 */
export type MetaField = 'title' | 'original' | 'year' | 'summary' | 'cover' | 'score' | 'length';

/** 应用选中的候选：source + key 交给后端走对应绑定链路；fields 控制写入范围。 */
export async function applyCandidate(
  id: string,
  source: MetaCandidate['source'],
  key: string,
  fields?: MetaField[],
): Promise<void> {
  if (TAURI) await inv('apply_candidate', { id, source, key, fields });
}

export async function unmatchGame(id: string): Promise<void> {
  if (TAURI) await inv('unmatch_game', { id });
}

/** 选择转区工具（LEProc.exe / Ntleas.exe），仅取路径，不在此处落盘 */
export async function pickLocaleTool(): Promise<string | null> {
  if (!TAURI) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const f = await open({ multiple: false, filters: [{ name: '转区工具', extensions: ['exe'] }] });
  return typeof f === 'string' ? f : null;
}

/** 选择游戏主程序 exe（手动添加单部作品） */
export async function pickExeFile(): Promise<string | null> {
  if (!TAURI) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const f = await open({ multiple: false, filters: [{ name: '游戏主程序', extensions: ['exe'] }] });
  return typeof f === 'string' ? f : null;
}

/** 选择文件夹（添加游戏库根目录） */
export async function pickFolder(): Promise<string | null> {
  if (!TAURI) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const p = await open({ directory: true, multiple: false });
  return typeof p === 'string' ? p : null;
}

/* ============ 游戏库根目录（扫描 → 预览 → 确认导入） ============ */

/** 扫描候选：尚未入库，确认勾选后才写库 */
export interface ScanCandidate {
  dir: string;
  exe: string;
  /** 默认标题（子目录名），可在预览里手改 */
  title: string;
  /** 识别到的引擎中文名 */
  engine: string;
  /** 该目录已在库中（预览里置灰、默认不勾选） */
  inLibrary: boolean;
}

/** 用户勾选确认的一条 */
export interface ScanPick {
  dir: string;
  exe: string;
  title: string;
}

/** 导入一个库根后的结果摘要 */
export interface RootScanOut {
  root: string;
  report: { total: number; added: number; removed: number; updated: number; durationMs: number };
}

function sanitizeScanCandidates(raw: unknown): ScanCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: ScanCandidate[] = [];
  for (const x of raw) {
    const c = x as Partial<ScanCandidate> | null;
    if (!c || typeof c.dir !== 'string' || !c.dir || typeof c.exe !== 'string' || !c.exe) continue;
    out.push({
      dir: c.dir,
      exe: c.exe,
      title: typeof c.title === 'string' && c.title ? c.title : c.dir.split(/[\\/]+/).filter(Boolean).pop() ?? '',
      engine: typeof c.engine === 'string' ? c.engine : '',
      inLibrary: !!c.inLibrary,
    });
  }
  return out;
}

/** 添加游戏库根目录：持久化配置并返回扫描候选（不入库） */
export async function addLibraryRoot(path: string): Promise<ScanCandidate[]> {
  if (!TAURI) return [];
  return inv<unknown>('add_library_root', { path }).then(sanitizeScanCandidates);
}

/** 重新扫描一个已配置的库根 */
export async function previewLibraryRoot(path: string): Promise<ScanCandidate[]> {
  if (!TAURI) return [];
  return inv<unknown>('preview_library_root', { path }).then(sanitizeScanCandidates);
}

/** 把勾选的候选完整探测后写入库 */
export async function importLibraryRoot(path: string, picks: ScanPick[]): Promise<RootScanOut> {
  if (!TAURI) throw new Error('浏览器预览不支持扫描入库');
  return inv<RootScanOut>('import_library_root', { path, picks });
}

/** 只移除库根配置，已入库作品保留 */
export async function removeLibraryRoot(path: string): Promise<void> {
  if (TAURI) await inv('remove_library_root', { path });
}

/* ============ Steam 库（只读扫描 → 勾选导入） ============ */

/** 本机已安装的 Steam 游戏（尚未入库） */
export interface SteamCandidate {
  appId: number;
  name: string;
  dir: string;
  exe: string;
  engine: string;
  /** 该目录已在库中（预览里置灰、默认不勾选） */
  inLibrary: boolean;
}

/** Steam 导入结果 */
export interface SteamImportOut {
  report: { total: number; added: number; removed: number; updated: number; durationMs: number };
}

function sanitizeSteamCandidates(raw: unknown): SteamCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: SteamCandidate[] = [];
  for (const x of raw) {
    const c = x as Partial<SteamCandidate> | null;
    if (!c || typeof c.name !== 'string' || !c.name) continue;
    if (typeof c.appId !== 'number' || !Number.isFinite(c.appId)) continue;
    if (typeof c.dir !== 'string' || !c.dir || typeof c.exe !== 'string' || !c.exe) continue;
    out.push({
      appId: c.appId,
      name: c.name,
      dir: c.dir,
      exe: c.exe,
      engine: typeof c.engine === 'string' ? c.engine : '',
      inLibrary: !!c.inLibrary,
    });
  }
  return out;
}

/** 扫描本机 Steam 库（多库目录），只返回候选，不入库 */
export async function scanSteam(): Promise<SteamCandidate[]> {
  if (!TAURI) return [];
  return inv<unknown>('scan_steam').then(sanitizeSteamCandidates);
}

/** 按 AppID 导入勾选的 Steam 游戏 */
export async function importSteam(appIds: number[]): Promise<SteamImportOut> {
  if (!TAURI) throw new Error('浏览器预览不支持 Steam 入库');
  return inv<SteamImportOut>('import_steam', { appIds });
}

/** 选择 ISO / 光盘镜像（P4 B11） */
export async function pickIso(): Promise<string | null> {
  if (!TAURI) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const f = await open({ multiple: false, filters: [{ name: '光盘镜像', extensions: ['iso', 'mdf', 'mds', 'cue', 'bin'] }] });
  return typeof f === 'string' ? f : null;
}

/** 与 Rust models.rs 的 serde camelCase 输出一一对应 */

export type FpsMode = 'auto' | '120' | '90' | '60';
export type SortMode = 'lastPlayed' | 'title' | 'year';

/** 引擎枚举：与后端 `EngineKind` 的 camelCase 序列化值保持一致（含未知兜底） */
export type EngineKind =
  | 'kirikiri'
  | 'renPy'
  | 'nScripter'
  | 'oNScripter'
  | 'artemis'
  | 'majiro'
  | 'bgi'
  | 'catSystem2'
  | 'yuRis'
  | 'siglus'
  | 'cmvs'
  | 'qlie'
  | 'wolfRpg'
  | 'rpgMaker'
  | 'unity'
  | 'unknown';

/** 一条结局（END）标记：玩家手动维护的路线清单 */
export interface EndMark {
  name: string;
  done: boolean;
}

/** 一次游玩场次（M6） */
export interface PlaySession {
  at: number;
  seconds: number;
}

export interface Game {
  id: string;
  title: string;
  titleOriginal: string | null;
  romaji: string | null;
  dir: string;
  exe: string;
  /**
   * 引擎枚举：与 `src-tauri/src/models.rs::EngineKind` 的 camelCase 序列化值一一对应。
   * 后端遇到未知值会降级为 `unknown`，前端不要写入其它字符串。
   */
  engine: EngineKind;
  engineLabel: string;
  engineEvidence: string;
  cover: string | null;
  thumb: string | null;
  shots: string[];
  peProduct: string | null;
  peCompany: string | null;
  developer: string | null;
  sizeGb: number;
  lastPlayed: number | null;
  playCount: number;
  /** 累计游玩秒数（P2） */
  playSeconds: number;
  /** 手动 END 清单（P2）：全部勾选即视为已通关 */
  endings: EndMark[];
  favorite: boolean;
  addedAt: number;
  needsLocale: boolean;
  matched: boolean;
  /** 每游戏启动参数（P4 B10：详情页填写） */
  launchArgs: string[];
  bangumiId: number | null;
  /** 鲲 Galgame 作品 id（第四数据源） */
  kungalId?: string | null;
  /** 匹配得分（总案 7.2） */
  matchScore: number | null;
  /** 50–80 分：已入库但待人工确认 */
  pending: boolean;
  summary: string | null;
  tags: string[];
  /** 搜索别名（meta.json 手填，不展示） */
  aliases: string[];
  year: number | null;
  /** 用户标题覆盖（H1） */
  titleOverride?: string | null;
  /** 用户封面覆盖（H1） */
  coverOverride?: string | null;
  /** 隐藏（默认视图不显示）；后端恒返回，不用 undefined 代替 false */
  hidden: boolean;
  /** 自定义标签（H2）；后端恒返回空数组而不是缺省 */
  userTags: string[];
  /** 备注（M6）；后端恒返回空串而不是缺省 */
  notes: string;
  /** 评分 0–5（M6） */
  rating?: number;
  /** 最近游玩场次（M6） */
  sessions?: PlaySession[];
  /** 手改过简介 / 年份 / 开发商 / 标签：自动匹配不覆盖 */
  metaManual?: boolean;
  /** 手动添加（库只靠手动 exe 建立） */
  manual?: boolean;
  /** 参考游玩时长（分钟，EGS）：用于「短篇」集合与详情参考，不覆盖本机统计 */
  lengthMinutes?: number | null;
  /** 外部口碑分（0–100 归一：Bangumi 0–10 ×10，EGS 原值） */
  metaScore?: number | null;
  /** 口碑来源：bangumi / egs / kungal */
  metaScoreSource?: string | null;
  /** 评分样本数 */
  metaScoreCount?: number | null;
  /** 元数据实际来源：bangumi / moegirl / kungal；未匹配为空 */
  metaSource?: string | null;
}

/** 保存的筛选视图：状态筛选 + 分面 + 智能集合 + 排序 */
export interface SavedView {
  name: string;
  filter: string;
  tag: string | null;
  dev: string | null;
  year: number | null;
  collection: string | null;
  sort: string;
}

/** 布局皮肤：classic = 大海报 + 封面轨道；list = 左列表 + 右大图；wall = 海报墙 */
export type LayoutName = 'classic' | 'list' | 'wall';

export type ThemeName =
  | 'cinema'
  | 'oled'
  | 'sakura'
  | 'frost'
  | 'amber'
  | 'iris'
  | 'moss'
  | 'crimson'
  | 'eva01'
  | 'eva02'
  | 'nerv'
  | 'rei';

/** 冷启动动画：warp = 流光跃迁（5.0s）/ eva01·eva02·evaNerv·eva00 = EVA 起动序列（5.0s）/ off = 关闭。
 *  全屏切换复用同一段完整动画，速度与冷启动共用一个倍率。 */
export type BootAnim = 'warp' | 'eva01' | 'eva02' | 'evaNerv' | 'eva00' | 'off';

/** 后端命令错误（Rust AppError）。code 是稳定分类（camelCase），
 *  message 是可直接展示的文案；前端只按 code 分支，绝不匹配 message。 */
export interface AppError {
  code?: string;
  message: string;
}

/** 库体检（无 AI）：失效条目 / 重复项 / 未识别引擎 / 孤儿缓存 */
export interface HealthIssue {
  kind: string;
  title: string;
  detail: string;
}

export interface HealthReport {
  total: number;
  missingDirs: number;
  missingExes: number;
  duplicates: number;
  unknownEngines: number;
  missingCovers: number;
  orphanThumbs: number;
  orphanCovers: number;
  tmpLeftovers: number;
  issues: HealthIssue[];
}

export interface Settings {
  version: number;
  /** 界面主题（令牌在 app.css 的 html[data-theme] 下） */
  theme: ThemeName;
  /** 界面布局（app.css 的 html[data-layout] 下） */
  layout: LayoutName;
  fpsMode: FpsMode;
  sort: SortMode;
  /** 动效强度：0 标准 / 1 柔和 */
  motion: number;
  /** 界面字号缩放：0.9 小 / 1 标准 / 1.12 大 / 1.25 特大（只放大文字，不动版式） */
  fontScale?: number;
  /** 启动与全屏转场速度：1 标准 / 1.5 快 / 2 很快（只缩放转场时长） */
  animSpeed?: number;
  /** 冷启动动画：warp 流光跃迁 / off 关闭（全屏切换复用同一段完整跃迁） */
  bootAnim?: BootAnim;
  /** 竖排原文名 */
  verticalTitle: boolean;
  /** 开机自启（P3，写当前用户启动项） */
  autostart: boolean;
  /** 启动即全屏（P3） */
  fullscreen: boolean;
  /** 游戏运行期间手柄映射鼠标（P3） */
  gamepadMouse: boolean;
  /** 手柄 A/B 键互换（Nintendo 布局） */
  abSwap?: boolean;
  /** 手柄键位：动作 → 物理键名（south/east/west/north/start/select/lb/rb） */
  padMap?: PadMap;
  /** 手柄手感：死区 / 重复率 / 鼠标速度（缺省走 PAD_TUNING_DEFAULT） */
  padTuning?: PadTuning;
  /** 锁 60Hz 省电（P3，退出还原） */
  power60: boolean;
  /** 交互音效：开关 + 总音量（0–1）；全部由前端 WebAudio 合成，无音频文件 */
  sound: { enabled: boolean; gain: number };
  network: {
    metadataEnabled: boolean;
    /** Bangumi 召回不足时用萌娘百科兜底（默认开） */
    moegirlFallback?: boolean;
    /** SteamGridDB API Key（封面 / 截图 / 横版图；为空跳过该源） */
    sgdbKey?: string | null;
  };
  /** 转区：warnOnly = 仅提示；toolPath = LEProc/Ntleas；launch = 对需转区游戏经工具启动 */
  locale: { warnOnly: boolean; toolPath: string | null; launch: boolean };
  /** 保存的筛选视图（网格「集合」列；随设置导出 / 导入） */
  views?: SavedView[];
  /** 游戏库根目录（可多个）：添加后扫描预览，确认才入库；移除目录不删已入库作品 */
  libraryRoots?: string[];
}

export type NavIntent =
  | { intent: 'move'; dir: 'up' | 'down' | 'left' | 'right' }
  | { intent: 'accept' }
  | { intent: 'back' }
  | { intent: 'switchView' }
  | { intent: 'menu' }
  | { intent: 'actionX' }
  | { intent: 'actionY' }
  | { intent: 'actionL' }
  | { intent: 'actionR' };

export type Screen = 'library' | 'grid' | 'detail' | 'settings' | 'files';

/** 手柄键位：动作 → 物理键名。方向键与摇杆推动是固定导航，不参与改键；摇杆按下（l3/r3）可改键。 */
export interface PadMap {
  /** 确认 / 启动（默认 south = A） */
  accept: string;
  /** 返回（默认 east = B） */
  back: string;
  /** 快捷菜单（默认 start） */
  menu: string;
  /** X 语义：多选 / 批量（默认 west） */
  x: string;
  /** Y 语义：详情 / 结局 / 筛选（默认 north） */
  y: string;
  /** 收藏 / 分类右（默认 rb） */
  r: string;
  /** 分类左（默认 lb） */
  lb: string;
}

/** 手柄手感：与 Rust 端 models::PadTuning 一一对应（范围也在后端再夹一次）。 */
export interface PadTuning {
  /** 左摇杆死区：0.10–0.45，默认 0.28（越大越不漂移，轻推越钝） */
  deadzone: number;
  /** 方向重复间隔（毫秒）：40–200，默认 60 */
  repeatMs: number;
  /** 手柄映射鼠标的满推速度：4–24，默认 11 */
  mouseSpeed: number;
}

/** Bangumi 条目（net.rs Subject 的 camelCase 镜像） */
export interface BangumiSubject {
  id: number;
  name: string;
  nameCn: string | null;
  imagesLarge: string | null;
  summary: string | null;
  year: number | null;
  score: number | null;
  tags: string[];
}

/** 四源统一候选（人工选择用）：source + key 决定应用时走哪条绑定链路 */
export interface MetaCandidate {
  source: 'bangumi' | 'moegirl' | 'egs' | 'kungal';
  /** Bangumi 条目 id / 鲲 Galgame 作品 id；萌娘百科 / EGS 用页面标题 */
  key: string;
  title: string;
  original: string | null;
  year: number | null;
  /** 标题相似度（EGS 固定 60，仅用于排序展示） */
  score: number;
  summary: string | null;
  /** 候选封面本地缓存路径（后端下载成 thumbs/cand-<id>.webp）；无图时为空 */
  thumb: string | null;
  egs: { score: number | null; votes: number | null; minutes: number | null } | null;
}

use serde::{Deserialize, Serialize};

/// Galgame 引擎类型。识别结果直接决定启动参数、存档位置与转区需求。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineKind {
    Kirikiri,
    RenPy,
    NScripter,
    ONScripter,
    Artemis,
    Majiro,
    Bgi,
    CatSystem2,
    YuRis,
    Siglus,
    Cmvs,
    Qlie,
    WolfRpg,
    RpgMaker,
    Unity,
    /// 未识别 / 新版本新增但当前不认识的引擎。
    /// `other` 是兜底：一个未知枚举值不能让它所在的整个 library.json 解析失败。
    #[serde(other)]
    #[default]
    Unknown,
}

impl EngineKind {
    pub fn label(self) -> &'static str {
        match self {
            EngineKind::Kirikiri => "吉里吉里",
            EngineKind::RenPy => "Ren'Py",
            EngineKind::NScripter => "NScripter",
            EngineKind::ONScripter => "ONScripter",
            EngineKind::Artemis => "Artemis",
            EngineKind::Majiro => "Majiro",
            EngineKind::Bgi => "BGI",
            EngineKind::CatSystem2 => "CatSystem2",
            EngineKind::YuRis => "YU-RIS",
            EngineKind::Siglus => "SiglusEngine",
            EngineKind::Cmvs => "CMVS",
            EngineKind::Qlie => "QLIE",
            EngineKind::WolfRpg => "Wolf RPG",
            EngineKind::RpgMaker => "RPG Maker",
            EngineKind::Unity => "Unity",
            EngineKind::Unknown => "未知引擎",
        }
    }
}

/// 一条结局（END）标记：玩家手动维护的路线清单。
/// 不存时间戳：掌机上「什么时候通的」价值低，多一个字段就多一处迁移风险。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndMark {
    /// 名称（默认 END 1、END 2…，可手改）
    pub name: String,
    /// 是否已达成
    #[serde(default)]
    pub done: bool,
}

/// 一次游玩场次（M6：详情页展示最近几次「什么时候玩了多久」）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaySession {
    /// 开始时间戳（秒）
    pub at: i64,
    /// 本次时长（秒）
    pub seconds: u64,
}

/// 一部游戏在库中的完整记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
// 缺字段按 Default 兜底：library.json 是唯一不可再生的数据（游玩记录），
// 旧版本写入的文件少了哪一个字段都不能让整库反序列化失败——
// 否则一次升级就会把 12 部作品的记录全判成「损坏」并清空（只能去 quarantine 里捞）。
#[serde(rename_all = "camelCase", default)]
pub struct Game {
    /// 稳定 id（目录路径 FNV-1a 哈希），用于跨次合并保留游玩记录
    pub id: String,
    /// 展示标题（目录名清洗得到；P1 起可由 Bangumi 覆盖）
    pub title: String,
    /// 日文原名（本地 meta.json 或 Bangumi）
    pub title_original: Option<String>,
    /// 罗马字（本地 meta.json）
    pub romaji: Option<String>,
    /// 游戏根目录
    pub dir: String,
    /// 主程序完整路径
    pub exe: String,
    /// 识别到的引擎
    pub engine: EngineKind,
    /// 引擎中文名
    pub engine_label: String,
    /// 识别依据，方便排查误判
    pub engine_evidence: String,
    /// 封面原图绝对路径
    pub cover: Option<String>,
    /// 轨道档缩略图（255×340 WebP）路径，后台生成，可能尚未就绪
    pub thumb: Option<String>,
    /// 作品目录实机图路径（背景候选与本地背景用）
    pub shots: Vec<String>,
    /// PE 资源中的产品名
    pub pe_product: Option<String>,
    /// PE 资源中的公司名
    pub pe_company: Option<String>,
    /// 开发商（本地 meta.json）
    pub developer: Option<String>,
    /// 目录总大小（GB 保留两位）
    pub size_gb: f64,
    /// 最近启动时间戳（秒）
    pub last_played: Option<i64>,
    /// 累计启动次数
    pub play_count: u32,
    /// 累计游玩秒数（P2：启动到退出按 Job Object 监控时长累加）
    #[serde(default)]
    pub play_seconds: u64,
    /// 手动维护的 END / 路线清单（P2）
    #[serde(default)]
    pub endings: Vec<EndMark>,
    /// 收藏
    pub favorite: bool,
    /// 入库时间戳（秒）
    pub added_at: i64,
    /// 是否需要转区（目录含日文 + 非日文系统；汉化版 exe 视为不需要）
    pub needs_locale: bool,
    /// 转区覆盖：None = 按自动判定；Some(true) = 强制转区；Some(false) = 不转区。
    /// 自动判定会误报（汉化版 / 重打包 / 引擎识别偏差），详情页可逐部纠正。
    #[serde(default)]
    pub locale_override: Option<bool>,
    /// 是否已匹配到元数据（P0：meta.json 存在即视为已匹配）
    pub matched: bool,
    /// 每游戏启动参数（P4 B10：详情页填写，原样追加到命令行；meta.json 亦可提供）
    #[serde(default)]
    pub launch_args: Vec<String>,
    /// Bangumi subject id（P1）
    pub bangumi_id: Option<u32>,
    /// 鲲 Galgame 作品 id（第四数据源）
    #[serde(default)]
    pub kungal_id: Option<String>,
    /// 匹配得分（总案 7.2；未匹配过为 None）
    #[serde(default)]
    pub match_score: Option<u32>,
    /// 50–80 分的「待确认」状态：已入库但需人工过一眼
    #[serde(default)]
    pub pending: bool,
    /// 中文简介
    pub summary: Option<String>,
    /// 标签
    pub tags: Vec<String>,
    /// 搜索别名（meta.json 手填：英文名 / 简称 / 错译），不参与展示，只喂搜索
    #[serde(default)]
    pub aliases: Vec<String>,
    /// 发售年份
    pub year: Option<u32>,
    /// 用户自定义标题（H1：非空时合并 / 重匹配都不覆盖）
    #[serde(default)]
    pub title_override: Option<String>,
    /// 用户自定义封面（H1：复制到 covers/ 后记录新路径）
    #[serde(default)]
    pub cover_override: Option<String>,
    /// 隐藏（默认视图不显示，库管理里可恢复）
    #[serde(default)]
    pub hidden: bool,
    /// 用户标签（H2：详情页维护，参与筛选与搜索）
    #[serde(default)]
    pub user_tags: Vec<String>,
    /// 备注（M6）
    #[serde(default)]
    pub notes: String,
    /// 评分 0–5 星（M6）
    #[serde(default)]
    pub rating: u8,
    /// 最近游玩场次，最多保留 50 条（M6）
    #[serde(default)]
    pub sessions: Vec<PlaySession>,
    /// 用户手改过简介 / 年份 / 开发商 / 标签：自动重匹配不覆盖，
    /// 只有用户主动「重新匹配」才重置（那时才算重新信任元数据源）
    #[serde(default)]
    pub meta_manual: bool,
    /// 手动添加（库只靠手动 exe 建立）
    #[serde(default)]
    pub manual: bool,
    /// 参考游玩时长（分钟，EGS）：只用于「短篇」集合与详情参考，
    /// 不覆盖本机 play_seconds 的真实统计
    #[serde(default)]
    pub length_minutes: Option<u32>,
    /// 外部口碑分（0–100 归一：Bangumi 的 0–10 分 ×10，EGS 原值）
    #[serde(default)]
    pub meta_score: Option<f64>,
    /// meta_score 的来源：bangumi / egs
    #[serde(default)]
    pub meta_score_source: Option<String>,
    /// 参与评分的样本数（EGS 投票数）
    #[serde(default)]
    pub meta_score_count: Option<u32>,
    /// 元数据实际来源：bangumi / moegirl；未匹配为 None。
    /// 详情页据此显示来源角标，区分「没有中文数据」与「请求失败降级」。
    #[serde(default)]
    pub meta_source: Option<String>,
}

impl Default for Game {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            title_original: None,
            romaji: None,
            dir: String::new(),
            exe: String::new(),
            engine: EngineKind::Unknown,
            engine_label: EngineKind::Unknown.label().to_string(),
            engine_evidence: String::new(),
            cover: None,
            thumb: None,
            shots: Vec::new(),
            pe_product: None,
            pe_company: None,
            developer: None,
            size_gb: 0.0,
            last_played: None,
            play_count: 0,
            play_seconds: 0,
            endings: Vec::new(),
            favorite: false,
            added_at: 0,
            needs_locale: false,
            locale_override: None,
            matched: false,
            launch_args: Vec::new(),
            bangumi_id: None,
            kungal_id: None,
            match_score: None,
            pending: false,
            summary: None,
            tags: Vec::new(),
            aliases: Vec::new(),
            year: None,
            title_override: None,
            cover_override: None,
            hidden: false,
            user_tags: Vec::new(),
            notes: String::new(),
            rating: 0,
            sessions: Vec::new(),
            meta_manual: false,
            manual: false,
            length_minutes: None,
            meta_score: None,
            meta_score_source: None,
            meta_score_count: None,
            meta_source: None,
        }
    }
}

/// 手动添加时探测出的候选游戏（尚未入库）
#[derive(Debug, Clone)]
pub struct DetectedGame {
    pub title: String,
    pub title_original: Option<String>,
    pub romaji: Option<String>,
    pub dir: String,
    pub exe: String,
    pub engine: EngineKind,
    pub engine_label: String,
    pub engine_evidence: String,
    pub cover: Option<String>,
    pub shots: Vec<String>,
    pub pe_product: Option<String>,
    pub pe_company: Option<String>,
    pub developer: Option<String>,
    pub size_gb: f64,
    pub matched: bool,
    /// 每游戏启动参数（meta.json `launchArgs`）
    pub launch_args: Vec<String>,
    pub summary: Option<String>,
    pub tags: Vec<String>,
    /// 搜索别名（meta.json 手填）
    pub aliases: Vec<String>,
    pub year: Option<u32>,
}

/// 手柄键位映射：动作 → 物理键名
/// （south/east/west/north/start/select/mode/lb/rb/lt/rt/l3/r3）。
/// 方向键与摇杆推动不参与改键——导航是几何焦点引擎的固定输入；摇杆按下（l3/r3）可绑定。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PadMap {
    /// 确认 / 启动（默认 south = A）
    pub accept: String,
    /// 返回（默认 east = B）
    pub back: String,
    /// 快捷菜单（默认 start）
    pub menu: String,
    /// X 语义：多选 / 批量（默认 west = X）
    pub x: String,
    /// Y 语义：详情 / 结局 / 筛选（默认 north = Y）
    pub y: String,
    /// 收藏 / 分类右（默认 rb）
    pub r: String,
    /// 分类左（默认 lb）
    pub lb: String,
    /// 随机一部：库 / 网格两屏生效（默认 l3 = 左摇杆按下）
    pub random: String,
}

impl Default for PadMap {
    fn default() -> Self {
        Self {
            accept: "south".into(),
            back: "east".into(),
            menu: "start".into(),
            x: "west".into(),
            y: "north".into(),
            r: "rb".into(),
            lb: "lb".into(),
            random: "l3".into(),
        }
    }
}

/// 手柄手感：死区 / 方向键重复率 / 鼠标速度。
///
/// 输入线程每帧读一次，改设置即时生效（不用重启线程）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PadTuning {
    /// 摇杆死区 0.10–0.45（迟滞取 0.57×）
    pub deadzone: f64,
    /// 方向键重复间隔 40–200ms
    pub repeat_ms: u32,
    /// 摇杆当鼠标的速度 4–24（像素/8ms 满推上限）
    pub mouse_speed: f64,
}

impl Default for PadTuning {
    fn default() -> Self {
        Self {
            deadzone: 0.28,
            repeat_ms: 60,
            mouse_speed: 11.0,
        }
    }
}

/// 交互音效（默认开、中等音量）。只在前端合成，后端仅负责持久化。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SoundSettings {
    pub enabled: bool,
    /// 总音量 0–1（update_settings 会校验范围）
    pub gain: f64,
}

impl Default for SoundSettings {
    fn default() -> Self {
        Self { enabled: true, gain: 0.6 }
    }
}

/// settings.json（总案 10.2）
#[derive(Debug, Clone, Serialize, Deserialize)]
// 缺字段按 Default 兜底：老版本的 settings.json 没有 network/locale 时，
// 不能因为整份反序列化失败而把用户的配置一起丢掉
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    /// 界面主题：cinema / oled / sakura / frost / amber / iris / moss / crimson
    /// + eva01 / eva02 / nerv
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 界面布局：classic（大海报 + 封面轨道）/ list / wall
    #[serde(default = "default_layout")]
    pub layout: String,
    /// auto / 120 / 90 / 60
    pub fps_mode: String,
    /// lastPlayed / title / year
    pub sort: String,
    /// 动效强度：0 标准 / 1 柔和（旧 settings.json 无此字段时按标准）
    #[serde(default)]
    pub motion: u8,
    /// 界面字号缩放：0.9 小 / 1 标准 / 1.12 大 / 1.25 特大（只放大文字，不动版式）
    #[serde(default = "default_font_scale")]
    pub font_scale: f64,
    /// 启动与全屏转场速度：1 标准 / 1.5 快 / 2 很快（只缩放转场时长）
    #[serde(default = "default_anim_speed")]
    pub anim_speed: f64,
    /// 冷启动动画：warp 流光跃迁 / eva01·eva02·evaNerv·eva00 EVA 起动序列 / off 关闭
    /// （全屏切换复用同一段动画；旧版的 core 档与前端一致收敛为 warp）
    #[serde(default = "default_boot_anim")]
    pub boot_anim: String,
    /// 竖排原文名（旧文件缺字段时默认开启，与设计一致）
    #[serde(default = "default_true")]
    pub vertical_title: bool,
    /// 开机自启（P3：写 HKCU\...\Run，默认关，需用户显式开启）
    #[serde(default)]
    pub autostart: bool,
    /// 启动即全屏（P3：无边框窗口铺满屏幕；掌机优先，默认开）
    #[serde(default = "default_true")]
    pub fullscreen: bool,
    /// 游戏运行期间把游戏手柄映射为鼠标（P3：左摇杆移动 / A 左键 / B 右键 / 右摇杆滚轮）
    #[serde(default)]
    pub gamepad_mouse: bool,
    /// 手柄 A/B 键互换（Nintendo 布局）：确认在 East、返回在 South
    #[serde(default)]
    pub ab_swap: bool,
    /// 手柄键位映射（P5）：动作 → 物理键名；缺字段按默认 Xbox 布局
    #[serde(default)]
    pub pad_map: PadMap,
    /// 手柄手感（死区 / 重复率 / 鼠标速度）；缺字段按默认值
    #[serde(default)]
    pub pad_tuning: PadTuning,
    /// 深度省电：把系统刷新率锁到 60Hz（P3：默认关，退出应用自动还原）
    #[serde(default)]
    pub power60: bool,
    /// 交互音效：开关 + 总音量（0–1，前端 WebAudio 合成，不涉及音频文件）
    #[serde(default)]
    pub sound: SoundSettings,
    pub network: NetworkSettings,
    pub locale: LocaleSettings,
    /// 保存的筛选视图：网格「集合」面板一键回到常用组合（设置导出/导入一并带走）
    #[serde(default)]
    pub views: Vec<SavedView>,
    /// 游戏库根目录（可多个）：添加后扫描预览，确认才入库
    #[serde(default)]
    pub library_roots: Vec<String>,
}

/// 保存的筛选视图：状态筛选 + 分面 + 智能集合 + 排序的组合。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedView {
    pub name: String,
    /// 网格状态筛选：all / playing / done / unstarted / fav / hidden
    pub filter: String,
    pub tag: Option<String>,
    pub dev: Option<String>,
    pub year: Option<u32>,
    /// 智能集合 id：unplayed / short / series / recent
    pub collection: Option<String>,
    /// 排序：lastPlayed / title / year
    pub sort: String,
}

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    "cinema".into()
}

fn default_layout() -> String {
    "classic".into()
}

fn default_font_scale() -> f64 {
    1.0
}

fn default_anim_speed() -> f64 {
    1.0
}

fn default_boot_anim() -> String {
    "warp".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkSettings {
    /// P0 恒为 false（纯离线）；P1 打开后走 Bangumi
    pub metadata_enabled: bool,
    /// Bangumi 召回不足（<80）时用萌娘百科兜底（默认开）
    #[serde(default = "default_true")]
    pub moegirl_fallback: bool,
    /// SteamGridDB API Key（横版 hero / 封面 / 截图；为空即跳过该源）
    #[serde(default)]
    pub sgdb_key: Option<String>,
    /// 全量匹配时是否查询 EGS（每部要 2 次请求，是最慢的一环）。
    /// 默认关：关闭后整轮匹配明显更快；手动打开候选面板时 EGS 仍然可用。
    #[serde(default)]
    pub egs: bool,
}

/// 旧配置可能只有其中一部分键：逐字段兜底，缺一个键不该让整份设置回落到默认值
impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            metadata_enabled: false,
            moegirl_fallback: true,
            sgdb_key: None,
            egs: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocaleSettings {
    /// true = 仅提示需要转区，不阻止启动
    pub warn_only: bool,
    /// LEProc.exe / Ntleas.exe 路径；为空时只能提示、不能转区启动
    #[serde(default)]
    pub tool_path: Option<String>,
    /// 开启后：needsLocale 的游戏经 toolPath 转区启动
    /// （作品有 `<exe>.le.config` 走 `-run`，否则用 LEConfig.xml 第一条配置 `-runas <guid>`）；
    /// 工具缺失时启动会直接报错，不会静默直启
    #[serde(default)]
    pub launch: bool,
}

impl Default for LocaleSettings {
    fn default() -> Self {
        Self { warn_only: true, tool_path: None, launch: false }
    }
}

/// 单个手柄键位收敛：非法键名回落默认值；默认值被占用时取第一颗空闲键。
/// 与前端 `padmap.dedupePadMap` 使用同一组键名与同一顺序。
fn fix_pad_key(v: &mut String, def: &str, used: &mut Vec<String>) {
    const KEYS: &[&str] = &[
        "south", "east", "west", "north", "start", "select", "mode", "lb", "rb", "lt", "rt",
        "l3", "r3",
    ];
    const SPARE: &[&str] = &[
        "l3", "r3", "select", "mode", "lt", "rt", "lb", "rb", "start", "south", "east", "west",
        "north",
    ];
    let mut key = if KEYS.contains(&v.as_str()) {
        v.clone()
    } else {
        def.to_string()
    };
    if used.iter().any(|u| u == &key) {
        // 撞键先回默认键；默认键也被占用时再挪到第一颗空闲备用键
        key = if used.iter().any(|u| u == def) {
            SPARE
                .iter()
                .find(|k| !used.iter().any(|u| u == **k))
                .map(|k| (*k).to_string())
                .unwrap_or(key)
        } else {
            def.to_string()
        };
    }
    used.push(key.clone());
    *v = key;
}

/// 手柄键位归一化：非法键名会让对应动作永久失联（named_button 返回 None），
/// 重复键会让一次按压同时触发两个动作。读盘、导入、保存三条路径共用这一份规则。
fn normalize_pad_map(m: &mut PadMap) {
    let d = PadMap::default();
    let mut used: Vec<String> = Vec::new();
    fix_pad_key(&mut m.accept, &d.accept, &mut used);
    fix_pad_key(&mut m.back, &d.back, &mut used);
    fix_pad_key(&mut m.menu, &d.menu, &mut used);
    fix_pad_key(&mut m.x, &d.x, &mut used);
    fix_pad_key(&mut m.y, &d.y, &mut used);
    fix_pad_key(&mut m.r, &d.r, &mut used);
    fix_pad_key(&mut m.lb, &d.lb, &mut used);
    fix_pad_key(&mut m.random, &d.random, &mut used);
}

impl Settings {
    /// 把设置收敛到受支持的取值：手改 / 旧版本 / 备份导入都可能越界
    /// （例如 `fontScale: 99` 会让整套版式崩掉）。读盘与导入共用同一套规则。
    pub fn normalized(mut self) -> Self {
        const THEMES: &[&str] = &[
            "cinema", "oled", "sakura", "frost", "amber", "iris", "moss", "crimson", "eva01",
            "eva02", "nerv", "rei",
        ];
        const LAYOUTS: &[&str] = &["classic", "list", "wall"];
        // 键位与界面无关，但同样可能被手改 / 旧版本写坏：读盘即收敛
        normalize_pad_map(&mut self.pad_map);
        // v2：掌机优先，升级后默认全屏；用户之后仍可在设置里关掉（version 已是 2，不会反复改）
        if self.version < 2 {
            self.version = 2;
            self.fullscreen = true;
        }
        if !THEMES.contains(&self.theme.as_str()) {
            self.theme = "cinema".into();
        }
        if !LAYOUTS.contains(&self.layout.as_str()) {
            self.layout = "classic".into();
        }
        if !["auto", "120", "90", "60"].contains(&self.fps_mode.as_str()) {
            self.fps_mode = "auto".into();
        }
        if !["lastPlayed", "title", "year"].contains(&self.sort.as_str()) {
            self.sort = "lastPlayed".into();
        }
        self.motion = self.motion.min(1);
        // 字号只放大文字、不动版式：0.9–1.25 是设计给的区间
        if !self.font_scale.is_finite() {
            self.font_scale = 1.0;
        }
        self.font_scale = self.font_scale.clamp(0.9, 1.25);
        if !self.anim_speed.is_finite() {
            self.anim_speed = 1.0;
        }
        // 前端只提供 1 / 1.5 / 2 三档。后端若接受任意实数，存量 1.7 会在界面上
        // 显示成 1×，保存时又被改写成 1（用户看到的值和落盘值长期不一致）。
        // 读盘即收敛到最近档，两端只认同一组值。
        let v = self.anim_speed;
        self.anim_speed = [1.0, 1.5, 2.0]
            .into_iter()
            .min_by(|a, b| {
                (*a - v)
                    .abs()
                    .partial_cmp(&(*b - v).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(1.0);
        // 启动动画只认已知档位；旧版的 core（后端独有）与未知值统一收敛为 warp，
        // 与前端 normalizeBootAnim 的兜底保持一致
        if !matches!(
            self.boot_anim.as_str(),
            "warp" | "eva01" | "eva02" | "evaNerv" | "eva00" | "off"
        ) {
            self.boot_anim = "warp".into();
        }
        if !self.sound.gain.is_finite() {
            self.sound.gain = SoundSettings::default().gain;
        }
        self.sound.gain = self.sound.gain.clamp(0.0, 1.0);
        // 手柄手感：死区不能夹到 0（会漂移），也不能大到推不满；重复率给出可用区间
        let d = PadTuning::default();
        if !self.pad_tuning.deadzone.is_finite() {
            self.pad_tuning.deadzone = d.deadzone;
        }
        self.pad_tuning.deadzone = self.pad_tuning.deadzone.clamp(0.10, 0.45);
        self.pad_tuning.repeat_ms = self.pad_tuning.repeat_ms.clamp(40, 200);
        if !self.pad_tuning.mouse_speed.is_finite() {
            self.pad_tuning.mouse_speed = d.mouse_speed;
        }
        self.pad_tuning.mouse_speed = self.pad_tuning.mouse_speed.clamp(4.0, 24.0);
        // 游戏库目录：去空、按归一化路径去重（大小写 / 斜杠差异视为同一个），并限个数
        let mut seen = std::collections::HashSet::new();
        self.library_roots = self
            .library_roots
            .iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .filter(|p| seen.insert(crate::store::normalize_dir(p)))
            .take(16)
            .collect();
        self
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 2,
            theme: "cinema".into(),
            layout: "classic".into(),
            fps_mode: "auto".into(),
            sort: "lastPlayed".into(),
            motion: 0,
            font_scale: 1.0,
            anim_speed: 1.0,
            boot_anim: "warp".into(),
            vertical_title: true,
            autostart: false,
            fullscreen: true,
            gamepad_mouse: false,
            ab_swap: false,
            pad_map: PadMap::default(),
            pad_tuning: PadTuning::default(),
            power60: false,
            sound: SoundSettings::default(),
            network: NetworkSettings {
                metadata_enabled: false,
                moegirl_fallback: true,
                sgdb_key: None,
                egs: false,
            },
            locale: LocaleSettings { warn_only: true, tool_path: None, launch: false },
            views: Vec::new(),
            library_roots: Vec::new(),
        }
    }
}

/// 合并结果摘要（merge_games 返回；手动入库时 added = 1）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub total: usize,
    pub added: usize,
    pub removed: usize,
    pub updated: usize,
    pub duration_ms: u64,
}

/// 库根扫描候选（预览用，未入库）：用户确认勾选后才写库
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCandidate {
    pub dir: String,
    pub exe: String,
    /// 默认标题（子目录名），可在预览里手改
    pub title: String,
    /// 识别到的引擎中文名，帮助判断是不是真游戏
    pub engine: String,
    /// 该目录已在库中（预览里置灰、默认不勾选）
    pub in_library: bool,
}

/// 「移除出库」时记住的作品：重扫同一根目录不再列出，避免「删了又回来」。
/// 只按 exe 归一化路径比较；手动添加 exe 会清掉对应条目，因此不会永久锁死。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IgnoredGame {
    pub dir: String,
    pub exe: String,
    pub title: String,
    /// 加入忽略的时间戳（秒），设置页按新→旧展示
    pub at: i64,
}

/// 从本机 Steam 库发现的已安装游戏（预览用，未入库）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamCandidate {
    /// Steam AppID，导入时按它重新定位，前端路径不参与写库
    pub app_id: u32,
    /// Steam 清单里的官方名称
    pub name: String,
    pub dir: String,
    pub exe: String,
    pub engine: String,
    /// 该目录已在库中（预览里置灰、默认不勾选）
    pub in_library: bool,
}

/// Steam 导入结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamImportOut {
    pub report: ScanReport,
}


/// 用户在预览里勾选确认的一条（标题可改）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPick {
    pub dir: String,
    pub exe: String,
    pub title: String,
}

/// 导入一个库根后的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootScanOut {
    pub root: String,
    pub report: ScanReport,
}

/// 错误模型（总案 10.1）：`code` 是稳定分类（日志 / 埋点 / 需要语义分支时使用），
/// `message` 是直接展示给用户的中文文案——前端目前一律展示 message，不按文案做分支。
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: ErrCode,
    pub message: String,
    /// 「连不上主机」类错误（DNS 失败 / 连接超时 / TLS 握手失败）。
    /// 同域名的备用接口必然也连不上，调用方据此短路重试。只在进程内使用，
    /// 不参与序列化——前端不依赖 transport。
    #[serde(skip)]
    pub(crate) transport: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrCode {
    NotFound,
    NotScanned,
    AlreadyRunning,
    /// 同一目录重复入库：前端据此直接打开库里那部，而不是弹红条
    AlreadyInLibrary,
    LaunchFailed,
    NetworkOffline,
    /// 主机可达但服务端返回错误（5xx）：不等于「断网」，不能触发整轮离线短路
    ServerError,
    RateLimited,
    IoError,
    ConfigInvalid,
}

impl AppError {
    pub fn new(code: ErrCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), transport: false }
    }

    /// 标记成「连不上主机」：供调用方判断要不要换备用接口再试一次
    pub fn transport(mut self) -> Self {
        self.transport = true;
        self
    }

    pub fn is_transport(&self) -> bool {
        self.transport
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new(ErrCode::IoError, e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧版 library.json 少字段时不能整库解析失败：一次失败 = 全部游玩记录被清空
    #[test]
    fn game_tolerates_missing_fields() {
        let json = r#"{
            "id": "0123456789abcdef",
            "title": "AIR",
            "dir": "D:/games/AIR",
            "exe": "D:/games/AIR/game.exe",
            "engine": "kirikiri",
            "favorite": true,
            "playSeconds": 3600
        }"#;
        let g: Game = serde_json::from_str(json).unwrap();
        assert_eq!(g.title, "AIR");
        assert_eq!(g.engine, EngineKind::Kirikiri);
        assert!(g.favorite);
        assert_eq!(g.play_seconds, 3600, "已有字段要照常读进");
        // 缺失字段按 Default 兜底，而不是让整条 / 整库解析失败
        assert_eq!(g.play_count, 0);
        assert_eq!(g.engine_label, "未知引擎");
        assert!(g.endings.is_empty() && g.user_tags.is_empty());
        assert!(g.cover.is_none() && g.title_override.is_none());
    }

    /// 未知 engine 只降级为 Unknown：一个手改/新版本值不能让整库解析失败
    #[test]
    fn unknown_engine_falls_back_instead_of_failing_library() {
        let json = r#"{"id":"0123456789abcdef","title":"X","engine":"brandNewEngine"}"#;
        let g: Game = serde_json::from_str(json).unwrap();
        assert_eq!(g.engine, EngineKind::Unknown);
    }

    /// 旧的 core 档（后端独有）必须收敛为 warp，与前端 normalizeBootAnim 一致
    #[test]
    fn legacy_core_boot_anim_falls_back_to_warp() {
        let legacy = Settings { boot_anim: "core".into(), ..Settings::default() };
        assert_eq!(legacy.normalized().boot_anim, "warp");

        let known = Settings { boot_anim: "evaNerv".into(), ..Settings::default() };
        assert_eq!(known.normalized().boot_anim, "evaNerv");
    }

    /// 前端只有 1 / 1.5 / 2 三档：后端必须收敛到最近档，
    /// 否则 1.7 会「界面显示 1×、保存写回 1」，两端长期不一致
    #[test]
    fn anim_speed_snaps_to_design_steps() {
        let snap = |v: f64| Settings { anim_speed: v, ..Settings::default() }.normalized().anim_speed;
        assert_eq!(snap(1.7), 1.5);
        assert_eq!(snap(1.8), 2.0);
        assert_eq!(snap(2.6), 2.0);
        assert_eq!(snap(0.3), 1.0);
        assert_eq!(snap(f64::NAN), 1.0);
        assert_eq!(snap(f64::INFINITY), 1.0);
        // 正好落在档位上时不得漂移
        assert_eq!(snap(1.5), 1.5);
        assert_eq!(snap(2.0), 2.0);
    }

    /// 契约：错误码序列化为 camelCase，transport 不外泄
    #[test]
    fn err_code_serializes_camel_case() {
        let e = AppError::new(ErrCode::AlreadyRunning, "游戏已在运行");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "alreadyRunning");
        assert_eq!(v["message"], "游戏已在运行");
        assert!(v.get("transport").is_none());

        // 前端重复入库分支依赖这个稳定值，改名前先看 actions.ts
        let dup = serde_json::to_value(AppError::new(ErrCode::AlreadyInLibrary, "已在库中")).unwrap();
        assert_eq!(dup["code"], "alreadyInLibrary");
    }

    /// 写出再读回必须完全保真（library.json 是唯一不可再生数据）
    #[test]
    fn game_roundtrip_is_lossless() {
        let g = Game {
            id: "0123456789abcdef".into(),
            title: "AIR".into(),
            dir: "D:/games/AIR".into(),
            exe: "D:/games/AIR/game.exe".into(),
            engine: EngineKind::Kirikiri,
            engine_label: "吉里吉里".into(),
            engine_evidence: "*.xp3".into(),
            favorite: true,
            play_seconds: 7200,
            notes: "通关留念".into(),
            rating: 5,
            endings: vec![EndMark { name: "END 1".into(), done: true }],
            sessions: vec![PlaySession { at: 1_700_000_000, seconds: 600 }],
            ..Game::default()
        };
        let text = serde_json::to_string(&g).unwrap();
        let back: Game = serde_json::from_str(&text).unwrap();
        assert_eq!(back.id, g.id);
        assert_eq!(back.favorite, g.favorite);
        assert_eq!(back.play_seconds, 7200);
        assert_eq!(back.notes, "通关留念");
        assert_eq!(back.rating, 5);
        assert_eq!(back.endings.len(), 1);
        assert_eq!(back.sessions[0].seconds, 600);
    }

    /// 旧设置的 padMap 可能还带已下线的 shot：忽略它，其余映射保持不变
    #[test]
    fn pad_map_ignores_legacy_shot() {
        let json = r#"{
            "accept": "east", "back": "south", "menu": "start",
            "x": "west", "y": "north", "r": "rb", "lb": "lb", "shot": "select"
        }"#;
        let m: PadMap = serde_json::from_str(json).unwrap();
        assert_eq!(m.accept, "east", "已有映射保持不变");
    }

    /// 旧设置里没有 random（本次新增）：缺字段要补默认 L3，而不是让整个 padMap 解析失败
    #[test]
    fn pad_map_missing_random_falls_back_to_l3() {
        let json = r#"{
            "accept": "south", "back": "east", "menu": "start",
            "x": "west", "y": "north", "r": "rb", "lb": "lb"
        }"#;
        let m: PadMap = serde_json::from_str(json).unwrap();
        assert_eq!(m.random, "l3");
        assert_eq!(PadMap::default().random, "l3");
    }

    /// 读盘即收敛：未知键名会让动作永久失联，重复键会让一次按压触发两个动作
    #[test]
    fn pad_map_normalizes_invalid_and_duplicate_keys() {
        let s = Settings {
            pad_map: PadMap {
                accept: "south".into(),
                back: "south".into(), // 与 accept 重复
                menu: "guide".into(), // 非法键名
                x: "west".into(),
                y: "north".into(),
                r: "rb".into(),
                lb: "lb".into(),
                random: "l3".into(),
            },
            ..Settings::default()
        };
        let m = s.normalized().pad_map;
        assert_eq!(m.accept, "south", "先出现的动作保留");
        assert_eq!(m.back, "east", "重复键回落默认");
        assert_eq!(m.menu, "start", "非法键名回落默认");
        let all = [
            &m.accept, &m.back, &m.menu, &m.x, &m.y, &m.r, &m.lb, &m.random,
        ];
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), 8, "归一化后不允许撞键");
    }

    /// 旧版本允许把动作绑到 L3：升级后 random 默认也是 L3，必须自动让位
    #[test]
    fn pad_map_random_moves_off_taken_l3() {
        let s: Settings = serde_json::from_str(r#"{"version":2,"padMap":{"y":"l3"}}"#).unwrap();
        let m = s.normalized().pad_map;
        assert_eq!(m.y, "l3", "用户原来的绑定保留");
        assert_eq!(m.random, "r3", "random 让位到第一颗空闲备用键");
    }

    /// 手改 / 外来设置越界时必须收敛，否则 fontScale=99 会把整套版式撑坏
    #[test]
    fn settings_normalized_clamps_hostile_values() {
        let s: Settings = serde_json::from_str(
            r#"{"version":1,"fpsMode":"144","sort":"name","motion":9,
                "fontScale":99,"theme":"neon","layout":"masonry",
                "sound":{"enabled":true,"gain":7}}"#,
        )
        .unwrap();
        let n = s.normalized();
        assert_eq!(n.fps_mode, "auto");
        assert_eq!(n.sort, "lastPlayed");
        assert_eq!(n.motion, 1);
        assert!((n.font_scale - 1.25).abs() < 1e-9, "字号收敛到上限");
        assert_eq!(n.theme, "cinema");
        assert_eq!(n.layout, "classic");
        assert!((n.sound.gain - 1.0).abs() < 1e-9, "音量收敛到 1.0");
    }

    /// 游戏库根：旧设置缺字段默认空；去空、去重（大小写 / 斜杠 / 末尾分隔符视为同一个）
    #[test]
    fn settings_library_roots_are_normalized() {
        let s: Settings = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert!(s.library_roots.is_empty(), "旧设置缺 libraryRoots 时为空");

        let s: Settings = serde_json::from_str(
            r#"{"version":1,"libraryRoots":[" D:\\Games\\ ","","d:/games","E:\\VN"]}"#,
        )
        .unwrap();
        let n = s.normalized();
        assert_eq!(
            n.library_roots,
            vec!["D:\\Games\\".to_string(), "E:\\VN".to_string()]
        );
    }

    /// 契约快照：Game / Settings 的序列化字段名必须与 contract/fields.json 完全一致。
    /// 48 / 22 个字段本来全靠人眼在 Rust 与 types.ts 之间同步：任何一侧加字段、改名或删字段
    /// 都会让前端静默拿 undefined。这里与前端 src/__tests__/contract.test.ts 共用同一份清单。
    #[test]
    fn serialized_fields_match_shared_contract() {
        let raw: serde_json::Value =
            serde_json::from_str(include_str!("../../contract/fields.json")).expect("契约清单不是合法 JSON");
        let keys = |v: &serde_json::Value, name: &str| -> Vec<String> {
            let mut k: Vec<String> = v
                .as_object()
                .unwrap_or_else(|| panic!("{name} 序列化结果不是对象"))
                .keys()
                .cloned()
                .collect();
            k.sort();
            k
        };
        let want = |name: &str| -> Vec<String> {
            let mut k: Vec<String> = raw[name]
                .as_array()
                .unwrap_or_else(|| panic!("contract/fields.json 缺少 {name} 数组"))
                .iter()
                .map(|x| x.as_str().unwrap_or_else(|| panic!("{name} 里混入了非字符串")).to_string())
                .collect();
            k.sort();
            k
        };
        assert_eq!(
            keys(&serde_json::to_value(Game::default()).unwrap(), "Game"),
            want("game")
        );
        assert_eq!(
            keys(&serde_json::to_value(Settings::default()).unwrap(), "Settings"),
            want("settings")
        );
    }

    /// 旧 settings.json 没有 sound：音效默认开着、中等音量（不能悄悄变成静音）
    #[test]
    fn settings_defaults_turn_sound_on() {
        let s: Settings = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert!(s.sound.enabled);
        assert!((s.sound.gain - 0.6).abs() < 1e-9);
        assert_eq!(s.theme, "cinema", "其余字段走默认");
    }
}


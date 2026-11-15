//! settings / library 持久化：原子写 + 双副本恢复（总案 10.3）。
//!
//! library.json 是全应用唯一不可再生的数据（游玩记录），保存前先滚动 .bak，
//! 读取顺序 library.json → .bak → 空库。

use crate::models::{DetectedGame, Game, ScanReport, Settings};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// library.json 的「读—改—写」串行锁。
///
/// 多个入口会各自 load → 改 → save：收藏、END 清单、手动入库、启动器退出记录。
/// 这四类写盘横跨几秒到几分钟（探测、匹配期间用户还能操作），没有锁时任意两处交错
/// 就是「后写覆盖先写」——典型症状是「刚点的收藏没了」或「游玩次数回退」。
/// 约定：**网络与拷贝这类慢操作放在锁外，锁只包住 load → 改 → save**。
static LIB_LOCK: Mutex<()> = Mutex::new(());

/// 取库写锁（中毒也继续用：锁只用于串行化，不保护不变量）
pub fn lock_library() -> MutexGuard<'static, ()> {
    LIB_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// settings.json 的「读—改—写」串行锁。
///
/// update_settings（前端整份覆盖）、省电模式、开机自启都会
/// load → 改 → save。没有锁时两个入口交错就会「后写覆盖先写」：典型症状是
/// 刚保存的主题被后台一次状态回写冲掉。约定同库锁：慢操作放锁外。
static SET_LOCK: Mutex<()> = Mutex::new(());

pub fn lock_settings() -> MutexGuard<'static, ()> {
    SET_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone)]
pub struct Store {
    pub dir: PathBuf,
}

/// 数据目录名（%APPDATA% 下）
const DIR_NAME: &str = "Stash";
/// 改名前的目录名：只在启动迁移时读取
const LEGACY_NAME: &str = "vn-shelf";

/// 数据根目录：优先新目录，迁移失败（旧目录还在）时继续用旧目录，避免「库突然空了」。
pub fn data_root() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let new = base.join(DIR_NAME);
    if new.exists() {
        return new;
    }
    let old = base.join(LEGACY_NAME);
    if old.exists() {
        return old;
    }
    new
}

/// 旧版数据目录一次性搬到新目录。
///
/// 必须在 `log::init` 之前调用：日志目录在新目录下，先初始化会把新目录建出来，
/// 整体重命名就不会再发生（迁移被静默跳过）。新目录已存在时不动；
/// 重命名失败（同步盘 / 杀软占用）改整目录复制，旧目录一律保留。
pub fn migrate_legacy_dir() -> Option<(PathBuf, PathBuf)> {
    let base = dirs::data_dir()?;
    let old = base.join(LEGACY_NAME);
    let new = base.join(DIR_NAME);
    if new.exists() || !old.exists() {
        return None;
    }
    if fs::rename(&old, &new).is_ok() {
        return Some((old, new));
    }
    match copy_dir_all(&old, &new) {
        Ok(()) => Some((old, new)),
        Err(e) => {
            // 复制失败：data_root 会继续指向旧目录，数据不丢，只少了新目录
            eprintln!("stash: 数据目录迁移失败（{e}），继续使用 {}", old.display());
            None
        }
    }
}

/// 整目录复制（迁移兜底用）：保留子目录层级，文件复制失败即整体失败
fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

impl Store {
    /// %APPDATA%\Stash\（老版本目录由 migrate_legacy_dir 迁移）
    pub fn open() -> Self {
        let base = data_root();
        let _ = fs::create_dir_all(&base);
        let _ = fs::create_dir_all(base.join("thumbs"));
        let _ = fs::create_dir_all(base.join("covers"));
        Self { dir: base }
    }

    pub fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }
    pub fn library_path(&self) -> PathBuf {
        self.dir.join("library.json")
    }
    pub fn library_bak_path(&self) -> PathBuf {
        self.dir.join("library.json.bak")
    }
    pub fn settings_bak_path(&self) -> PathBuf {
        self.dir.join("settings.json.bak")
    }
    pub fn thumbs_dir(&self) -> PathBuf {
        self.dir.join("thumbs")
    }
    /// Bangumi 下载的原图缓存（两档缩略图由 thumb.rs 从这里生成）
    pub fn covers_dir(&self) -> PathBuf {
        self.dir.join("covers")
    }

    /// 读设置：现行文件解析失败时依次退回 .bak，两份都坏才用默认值。
    /// 关键点是**先把坏文件改名留档**：否则随后任何一次 save_settings 都会把
    /// 用户配置（根目录 / 主题 / 代理 / API Key）整份覆盖成默认值，且无法恢复。
    pub fn load_settings(&self) -> Settings {
        for p in [self.settings_path(), self.settings_bak_path()] {
            let Ok(s) = fs::read_to_string(&p) else { continue };
            match serde_json::from_str::<Settings>(&s) {
                // 读盘即收敛：手改过的 fontScale / theme / 音量不会带进界面
                Ok(v) => return v.normalized(),
                Err(e) => tracing::warn!("{} 无法解析：{e}", p.display()),
            }
        }
        self.quarantine("settings.json");
        Settings::default()
    }

    pub fn save_settings(&self, s: &Settings) -> std::io::Result<()> {
        // 与 library 同规则：现行文件能解析才滚动 .bak，坏文件不能把好副本顶掉
        if self.settings_path().exists() {
            let current_ok = fs::read_to_string(self.settings_path())
                .ok()
                .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
                .is_some();
            if current_ok {
                let _ = fs::copy(self.settings_path(), self.settings_bak_path());
            }
        }
        save_atomic(&self.settings_path(), &serde_json::to_string_pretty(s)?)
    }

    pub fn load_library(&self) -> Vec<Game> {
        for p in [self.library_path(), self.library_bak_path()] {
            if let Ok(s) = fs::read_to_string(&p) {
                let s = self.rebase_legacy_paths(s);
                if let Ok(g) = serde_json::from_str::<Vec<Game>>(&s) {
                    return g;
                }
            }
        }
        self.quarantine("library.json");
        Vec::new()
    }

    /// 目录改名后，旧版写进 library.json 的绝对路径（封面等）全部失效。
    /// 读库时把 `%APPDATA%\vn-shelf` 前缀换成现行数据目录；只改内存不落盘，
    /// 用户下次保存库时自然写回新路径。
    fn rebase_legacy_paths(&self, raw: String) -> String {
        let Some(base) = dirs::data_dir() else {
            return raw;
        };
        let old = base.join(LEGACY_NAME).to_string_lossy().into_owned();
        let new = self.dir.to_string_lossy().into_owned();
        if old == new {
            return raw;
        }
        // JSON 里的反斜杠是成对的；旧数据也可能是正斜杠写法
        let old_esc = old.replace('\\', "\\\\");
        let new_esc = new.replace('\\', "\\\\");
        let old_fwd = old.replace('\\', "/");
        let new_fwd = new.replace('\\', "/");
        raw.replace(&old_esc, &new_esc)
            .replace(&old_fwd, &new_fwd)
            .replace(&old, &new)
    }

    /// 把无法解析的数据文件改名留档（`*.corrupt-<ts>`），返回是否真的动了文件。
    /// 失败也继续（只打日志）：宁可少一份现场，也不能让启动卡在磁盘错误上。
    fn quarantine(&self, name: &str) -> bool {
        let src = self.dir.join(name);
        if !src.is_file() {
            return false;
        }
        let dst = self.dir.join(format!("{name}.corrupt-{}", now_secs()));
        match fs::rename(&src, &dst) {
            Ok(()) => {
                tracing::error!(
                    "{} 无法解析，已原样保留为 {}（不会再用默认值覆盖它）",
                    src.display(),
                    dst.display()
                );
                true
            }
            Err(e) => {
                tracing::error!("{} 无法解析，留档失败：{e}", src.display());
                false
            }
        }
    }

    pub fn save_library(&self, games: &[Game]) -> std::io::Result<()> {
        // 滚动备份：现行 → .bak，再写新文件。
        // 只有现行文件**能被解析**时才滚动：library.json 损坏时把它覆盖到 .bak，
        // 等于把唯一还能恢复的副本也毁掉（load_library 的二级兜底从此失效）。
        // 用 rename 而不是 copy：同卷 rename 只改元数据，省掉一次全量读 + 全量写。
        if self.library_path().exists() {
            let current_ok = fs::read_to_string(self.library_path())
                .ok()
                .and_then(|s| serde_json::from_str::<Vec<Game>>(&s).ok())
                .is_some();
            if current_ok {
                let _ = fs::rename(self.library_path(), self.library_bak_path());
            } else {
                tracing::warn!("library.json 无法解析，跳过 .bak 滚动以保住可恢复副本");
            }
        }
        save_atomic(&self.library_path(), &serde_json::to_string_pretty(games)?)
    }
}

/// 原子写的临时文件名序号：固定 `.json.tmp` 在两个入口同时写同一文件时会互相截断，
/// rename 后可能落下一份「两条 JSON 拼在一起」的坏文件。
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 原子写：先写唯一的 .tmp 并刷盘，再 rename（Windows 走 MOVEFILE_REPLACE_EXISTING，可覆盖）。
///
/// 只 rename 不 fsync 的话，断电后可能「元数据先落盘、数据没落盘」，
/// 留下 0 字节 / 截断的 JSON —— 正是这个函数要避免的情况。
pub fn save_atomic(path: &Path, json: &str) -> std::io::Result<()> {
    use std::io::Write;
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "data.json".into());
    let tmp = path.with_file_name(format!("{name}.{}-{seq}.tmp", std::process::id()));
    let mut f = match fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if let Err(e) = f.write_all(json.as_bytes()) {
        // 写一半失败会留下 .tmp 垃圾，长期累积后清理脚本也认不出来
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = f.sync_all() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    drop(f);
    // Windows 上杀软扫描 / 另一个实例短暂持有目标文件时 rename 会报「拒绝访问」。
    // 这类占用通常几十毫秒内就释放，重试两次能过掉绝大多数瞬时失败；
    // 仍失败才把临时文件带走并报错（调用方有的会重试 / 提示，绝不能当成写成功）。
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..3 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(60));
                }
            }
        }
    }
    // 重试后仍失败：把临时文件带走，不留垃圾
    let _ = fs::remove_file(&tmp);
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 稳定 id：目录路径 FNV-1a 64bit。哈希前先做 Windows 路径归一化
/// （分隔符、大小写、末尾反斜杠），否则同一个目录只因根目录写法不同就会换 id。
pub fn stable_id(dir: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in normalize_dir(dir).bytes().chain([0xffu8]) {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// 路径归一化：`/` → `\`、去掉末尾分隔符、统一小写。
/// 只用于「比较 / 生成 id」，原始 dir 仍按用户写法保留用于显示与启动。
pub fn normalize_dir(dir: &str) -> String {
    let mut s = dir.replace('/', "\\");
    // 根目录 "D:\" 只有 3 个字符，不能把分隔符删掉
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s.to_lowercase()
}

/// 把「刚探测到的作品」合进现有库：同目录沿用旧条目（保留游玩记录），
/// 其余字段以最新探测为准。手动添加时 `old` 传空，只起「造一条 Game」的作用。
pub fn merge_games(old: &[Game], detected: Vec<DetectedGame>) -> (Vec<Game>, ScanReport) {
    let started = std::time::Instant::now();
    let mut out: Vec<Game> = Vec::with_capacity(detected.len());
    let mut added = 0usize;
    let mut updated = 0usize;
    // 系统 ACP 在进程生命周期内不变，循环外只查一次
    let system_jp = crate::engine::system_is_japanese();

    // 旧条目按「归一化目录」建索引：用户改了根目录写法（大小写 / 斜杠）时 id 会变，
    // 但目录其实是同一个；只按 id 找会把整库判成「全新 + 全删」，游玩记录全丢
    let mut by_dir: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, g) in old.iter().enumerate() {
        by_dir.entry(normalize_dir(&g.dir)).or_insert(i);
    }

    for d in detected {
        let new_id = stable_id(&d.dir);
        let prev = by_dir.get(&normalize_dir(&d.dir)).map(|&i| &old[i]);
        // 命中旧条目时沿用旧 id：封面 / 缩略图都以 id 命名，
        // 这里换 id 等于让它们全部失联（列表里还是旧文件名）
        let id = prev.map(|p| p.id.clone()).unwrap_or(new_id);
        // 重叠根目录（D:\Games 与 D:\Games\Sub）会让同一目录被扫两次：
        // 同 id 只保留第一次，否则库里出现两条相同记录，改收藏 / 改名只改得到第一条
        if out.iter().any(|g| g.id == id) {
            continue;
        }
        let needs_locale = crate::engine::needs_locale(Path::new(&d.dir), d.engine, system_jp);
        match prev {
            Some(p) => {
                updated += 1;
                // Bangumi / 萌娘百科 / EGS 写入的字段（中文名 / 简介 / 标签 / 年份 / 封面）
                // 必须原样保留：合并只负责「目录事实」（exe / 引擎 / 大小 / 截图）。
                // 萌娘百科命中不会写 bangumi_id，只写 match_score / meta_source——漏掉它的话，
                // 一次合并就把联网匹配到的简介 / 封面全部回退，且没有 id 可以 resume。
                let remote_ids = p.bangumi_id.is_some();
                let keep_meta = remote_ids || p.match_score.is_some() || p.meta_manual;
                // 标题只由带正式条目 id 的源或已匹配记录接管：改名后合并要能跟上
                let by_meta = remote_ids || p.meta_source.is_some();
                out.push(Game {
                    id,
                    // 用户标题覆盖 > 远程元数据 > 目录名
                    title: if p.title_override.is_some() || by_meta {
                        p.title.clone()
                    } else {
                        d.title
                    },
                    title_original: if by_meta {
                        p.title_original.clone().or(d.title_original)
                    } else {
                        d.title_original
                    },
                    romaji: d.romaji,
                    dir: d.dir,
                    exe: d.exe,
                    engine: d.engine,
                    engine_label: d.engine_label,
                    engine_evidence: d.engine_evidence,
                    cover: if p.cover_override.is_some() {
                        p.cover.clone()
                    } else if keep_meta {
                        p.cover.clone().or(d.cover)
                    } else {
                        d.cover
                    },
                    thumb: p.thumb.clone(),
                    shots: if d.shots.is_empty() { p.shots.clone() } else { d.shots },
                    pe_product: d.pe_product,
                    pe_company: d.pe_company,
                    developer: if p.meta_manual {
                        p.developer.clone().or(d.developer)
                    } else {
                        d.developer
                    },
                    size_gb: d.size_gb,
                    // 游玩记录保留
                    last_played: p.last_played,
                    play_count: p.play_count,
                    play_seconds: p.play_seconds,
                    endings: p.endings.clone(),
                    favorite: p.favorite,
                    added_at: p.added_at,
                    needs_locale,
                    matched: d.matched || keep_meta,
                    // 启动参数是手工配置：详情页改过就以库为准，meta.json 没写才用探测值
                    launch_args: if p.launch_args.is_empty() { d.launch_args } else { p.launch_args.clone() },
                    bangumi_id: p.bangumi_id,
                    kungal_id: p.kungal_id.clone(),
                    // 匹配结果与待确认标记都保留：合并不该把人工确认过的结论冲掉
                    match_score: p.match_score,
                    pending: p.pending,
                    summary: if keep_meta { p.summary.clone().or(d.summary) } else { d.summary },
                    tags: if keep_meta && !p.tags.is_empty() { p.tags.clone() } else { d.tags },
                    // 别名是 meta.json 的手工输入：合并读到就更新，没写就保留旧值
                    aliases: if d.aliases.is_empty() { p.aliases.clone() } else { d.aliases },
                    year: if keep_meta { p.year.or(d.year) } else { d.year },
                    // 有手动 END 清单时进度由清单推导，不能被 meta.json 的旧值覆盖
                    progress: crate::models::progress_from_endings(&p.endings, d.progress),
                    // 以下全部是用户手工数据：合并必须原样保留
                    title_override: p.title_override.clone(),
                    cover_override: p.cover_override.clone(),
                    hidden: p.hidden,
                    user_tags: p.user_tags.clone(),
                    notes: p.notes.clone(),
                    rating: p.rating,
                    sessions: p.sessions.clone(),
                    meta_manual: p.meta_manual,
                    manual: p.manual,
                    // 参考时长 / 外部评分只由联网匹配写入：合并保留
                    length_minutes: p.length_minutes,
                    meta_score: p.meta_score,
                    meta_score_source: p.meta_score_source.clone(),
                    meta_score_count: p.meta_score_count,
                    meta_source: p.meta_source.clone(),
                });
            }
            None => {
                added += 1;
                out.push(Game {
                    id,
                    title: d.title,
                    title_original: d.title_original,
                    romaji: d.romaji,
                    dir: d.dir,
                    exe: d.exe,
                    engine: d.engine,
                    engine_label: d.engine_label,
                    engine_evidence: d.engine_evidence,
                    cover: d.cover,
                    thumb: None,
                    shots: d.shots,
                    pe_product: d.pe_product,
                    pe_company: d.pe_company,
                    developer: d.developer,
                    size_gb: d.size_gb,
                    last_played: None,
                    play_count: 0,
                    play_seconds: 0,
                    endings: Vec::new(),
                    favorite: false,
                    added_at: now_secs(),
                    needs_locale,
                    matched: d.matched,
                    launch_args: d.launch_args,
                    bangumi_id: None,
                    kungal_id: None,
                    match_score: None,
                    pending: false,
                    summary: d.summary,
                    tags: d.tags,
                    aliases: d.aliases,
                    year: d.year,
                    progress: d.progress,
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
                });
            }
        }
    }

    // 默认排序：最近游玩优先，其次新入库
    out.sort_by(|a, b| b.last_played.unwrap_or(0).cmp(&a.last_played.unwrap_or(0))
        .then(b.added_at.cmp(&a.added_at)));

    // removed = 旧库中已不在结果里的
    let removed = old.iter().filter(|g| !out.iter().any(|x| x.id == g.id)).count();
    let report = ScanReport {
        total: out.len(),
        added,
        removed,
        updated,
        duration_ms: started.elapsed().as_millis() as u64,
    };
    (out, report)
}

/// 库根扫描后的增量合并：本轮只探测了一个目录树，未探测到的旧条目（其他库根、
/// 手动添加、离线盘作品）必须原样保留——直接用 `merge_games` 的结果覆盖整库会把它们删掉。
///
/// 返回的 `removed` 恒为 0：扫描不删条目，失效清理仍走「体检 · 清理失效条目」。
pub fn merge_into_library(old: &[Game], detected: Vec<DetectedGame>) -> (Vec<Game>, ScanReport) {
    let started = std::time::Instant::now();
    let (mut out, mut report) = merge_games(old, detected);
    for g in old {
        let seen = out
            .iter()
            .any(|x| x.id == g.id || normalize_dir(&x.dir) == normalize_dir(&g.dir));
        if !seen {
            out.push(g.clone());
        }
    }
    // 与 merge_games 一致的默认排序：最近游玩优先，其次新入库
    out.sort_by(|a, b| {
        b.last_played
            .unwrap_or(0)
            .cmp(&a.last_played.unwrap_or(0))
            .then(b.added_at.cmp(&a.added_at))
    });
    report.total = out.len();
    report.removed = 0;
    report.duration_ms = started.elapsed().as_millis() as u64;
    (out, report)
}

/// 目录所在「盘」是否还在：盘符 / UNC 根不存在 = 移动盘没插 / 网络盘掉线。
/// 盘还在而目录没了，才说明用户真的删了（「清理失效条目」与体检都靠它区分）。
pub(crate) fn volume_available(dir: &Path) -> bool {
    let root = dir.ancestors().last().unwrap_or(dir);
    root.as_os_str().is_empty() || root.exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::EngineKind;

    fn detected(dir: &str) -> DetectedGame {
        DetectedGame {
            title: "AIR".into(),
            title_original: Some("AIR".into()),
            romaji: Some("AIR".into()),
            dir: dir.into(),
            exe: format!("{dir}/game.exe"),
            engine: EngineKind::Kirikiri,
            engine_label: "吉里吉里".into(),
            engine_evidence: "test".into(),
            cover: Some(format!("{dir}/cover.jpg")),
            shots: Vec::new(),
            pe_product: None,
            pe_company: None,
            developer: None,
            size_gb: 1.0,
            matched: false,
            launch_args: Vec::new(),
            summary: None,
            tags: Vec::new(),
            aliases: Vec::new(),
            year: None,
            progress: 0.0,
        }
    }

    /// 合并必须保留 Bangumi 写入的字段（否则 bangumi_id 还在、中文名已丢，永久不可恢复）
    #[test]
    fn merge_keeps_bangumi_metadata() {
        let dir = "D:/games/AIR";
        let (mut games, _) = merge_games(&[], vec![detected(dir)]);
        {
            let g = &mut games[0];
            g.bangumi_id = Some(232);
            g.title = "AIR 青空".into();
            g.title_original = Some("AIR".into());
            g.summary = Some("Bangumi 简介".into());
            g.tags = vec!["催泪".into(), "Key".into()];
            g.year = Some(2000);
            g.cover = Some("C:/covers/xxx_src.jpg".into());
            g.match_score = Some(110);
            g.matched = true;
            g.pending = false;
        }

        let (after, report) = merge_games(&games, vec![detected(dir)]);
        let g = &after[0];
        assert_eq!(report.updated, 1);
        assert_eq!(g.title, "AIR 青空");
        assert_eq!(g.title_original.as_deref(), Some("AIR"));
        assert_eq!(g.summary.as_deref(), Some("Bangumi 简介"));
        assert_eq!(g.tags, vec!["催泪", "Key"]);
        assert_eq!(g.year, Some(2000));
        assert_eq!(g.cover.as_deref(), Some("C:/covers/xxx_src.jpg"));
        assert_eq!(g.bangumi_id, Some(232));
        assert_eq!(g.match_score, Some(110));
        assert!(g.matched, "已匹配状态不能被合并冲掉");
    }

    /// 路径写法差异（斜杠 / 大小写 / 末尾分隔符）不能产生不同 id
    #[test]
    fn stable_id_ignores_path_spelling() {
        assert_eq!(stable_id("D:/Games/AIR"), stable_id(r"d:\games\air\"));
        assert_ne!(stable_id("D:/Games/AIR"), stable_id("D:/Games/AIR2"));
    }

    /// 根目录写法变化不能让整库「全新 + 全删」：应命中原条目、沿用旧 id
    #[test]
    fn merge_matches_same_dir_with_different_spelling() {
        let (mut games, _) = merge_games(&[], vec![detected(r"D:\Games\AIR")]);
        games[0].play_seconds = 120;
        games[0].favorite = true;
        let old_id = games[0].id.clone();

        let (after, report) = merge_games(&games, vec![detected("D:/games/air")]);
        assert_eq!(after.len(), 1);
        assert_eq!(report.added, 0);
        assert_eq!(report.removed, 0);
        assert_eq!(report.updated, 1);
        assert_eq!(after[0].id, old_id, "沿用旧 id，封面 / 缩略图不失联");
        assert_eq!(after[0].play_seconds, 120);
        assert!(after[0].favorite);
    }

    /// 同一目录在一次探测里出现两次（例如手工选了两个同目录的 exe）：
    /// 合并后必须只留一条，否则库里出现两条同 id 记录
    #[test]
    fn merge_dedupes_same_dir_in_one_batch() {
        let d = detected("D:/games/AIR");
        let (games, report) = merge_games(&[], vec![d.clone(), d]);
        assert_eq!(games.len(), 1);
        assert_eq!(report.added, 1);
    }

    /// 回归：手动添加第二部作品时，旧库绝不能参与合并。
    /// 旧实现把整个库传进 merge_games，玩过的旧手动条目会按 last_played 排在首位，
    /// 调用方取到的就成了旧作品 —— 新作品没入库，库里还多出一条同 id 记录
    #[test]
    fn merge_for_manual_add_must_start_from_empty_library() {
        let base = std::env::temp_dir().join(format!("stash-add-{}", std::process::id()));
        let a = base.join("A");
        let b = base.join("B");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let (a_s, b_s) = (a.to_string_lossy().to_string(), b.to_string_lossy().to_string());

        let (mut old, _) = merge_games(&[], vec![detected(&a_s)]);
        old[0].manual = true;
        old[0].last_played = Some(1_700_000_000);

        let fresh = detected(&b_s);
        // 错误用法（曾经的 bug 形状）：把整库当 old 传进来 → 本轮只探测到这一条，
        // 旧条目会被判成「目录消失」而丢掉
        let (mixed, _) = merge_games(&old, vec![fresh.clone()]);
        assert_eq!(mixed.len(), 1, "整库合并会把未探测到的旧条目清掉");
        assert_eq!(mixed[0].dir, b_s);

        // 正确用法：手动添加只合并这一条
        let (only, _) = merge_games(&[], vec![fresh]);
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].dir, b_s);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 未匹配的游戏仍以探测结果为准（目录改名 / 新增 meta.json 要能立刻体现）
    #[test]
    fn merge_uses_scan_values_without_bangumi() {
        let dir = "D:/games/NEW";
        let (mut games, _) = merge_games(&[], vec![detected(dir)]);
        games[0].title = "旧标题".into();
        games[0].summary = Some("旧简介".into());
        let mut d = detected(dir);
        d.title = "新标题".into();
        d.summary = Some("新简介".into());
        let (after, _) = merge_games(&games, vec![d]);
        assert_eq!(after[0].title, "新标题");
        assert_eq!(after[0].summary.as_deref(), Some("新简介"));
    }

    /// P2：累计游玩时长与 END 清单都要跨合并保留；进度由清单推导
    #[test]
    fn merge_keeps_playtime_and_endings() {
        let dir = "D:/games/CLANNAD";
        let (mut games, _) = merge_games(&[], vec![detected(dir)]);
        {
            let g = &mut games[0];
            g.play_seconds = 7200;
            g.endings = vec![
                crate::models::EndMark { name: "END 1".into(), done: true },
                crate::models::EndMark { name: "END 2".into(), done: false },
            ];
            g.progress = 0.5;
        }
        let (after, _) = merge_games(&games, vec![detected(dir)]);
        let g = &after[0];
        assert_eq!(g.play_seconds, 7200, "累计时长不能被合并清零");
        assert_eq!(g.endings.len(), 2);
        assert!(g.endings[0].done);
        assert_eq!(g.progress, 0.5, "有 END 清单时进度按清单推导，不能被 meta 覆盖");
    }

    /// 库根导入只影响本轮扫到的目录：其他库根 / 手动条目必须原样保留
    #[test]
    fn merge_into_library_keeps_untouched_entries() {
        let (mut old, _) = merge_games(&[], vec![detected("D:/games/OTHER"), detected("D:/lib/B")]);
        old[0].manual = true;
        old[0].favorite = true;
        old[0].play_seconds = 99;
        old[1].play_seconds = 3600;

        let (after, report) = merge_into_library(&old, vec![detected("D:/lib/B")]);
        assert_eq!(after.len(), 2, "未参与扫描的条目必须保留");
        assert_eq!(report.removed, 0, "扫描不删条目");
        assert_eq!(report.added, 0);
        assert_eq!(report.updated, 1);
        assert_eq!(report.total, 2);

        let other = after.iter().find(|g| g.dir.ends_with("OTHER")).unwrap();
        assert!(other.manual, "手动添加标记不能被冲掉");
        assert!(other.favorite);
        assert_eq!(other.play_seconds, 99);
        let b = after.iter().find(|g| g.dir.ends_with("B")).unwrap();
        assert_eq!(b.play_seconds, 3600, "被重扫的条目保留游玩记录");
    }

    /// 库写锁必须让「读—改—写」原子：两个线程各自累加不同字段，最终两边都不能丢
    #[test]
    fn library_lock_serializes_read_modify_write() {
        let dir = std::env::temp_dir().join(format!("stash-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store { dir };
        let (games, _) = merge_games(&[], vec![detected("D:/games/LOCK")]);
        store.save_library(&games).unwrap();

        let a = store.clone();
        let b = store.clone();
        let ha = std::thread::spawn(move || {
            for _ in 0..40 {
                let _g = lock_library();
                let mut list = a.load_library();
                list[0].play_seconds += 1;
                a.save_library(&list).unwrap();
            }
        });
        let hb = std::thread::spawn(move || {
            for _ in 0..40 {
                let _g = lock_library();
                let mut list = b.load_library();
                list[0].favorite = !list[0].favorite;
                b.save_library(&list).unwrap();
            }
        });
        ha.join().unwrap();
        hb.join().unwrap();

        let g = store.load_library();
        assert_eq!(g[0].play_seconds, 40, "时长累加不能被收藏写入覆盖");
        assert!(!g[0].favorite, "翻转 40 次（偶数）应回到未收藏");
    }

    /// 旧 library.json 没有 playSeconds / endings 字段：必须能读，且默认值为 0 / 空
    #[test]
    fn old_library_json_defaults_p2_fields() {
        let dir = std::env::temp_dir().join(format!("stash-oldlib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (games, _) = merge_games(&[], vec![detected("D:/games/OLD")]);
        let mut v = serde_json::to_value(&games[0]).unwrap();
        let obj = v.as_object_mut().unwrap();
        obj.remove("playSeconds");
        obj.remove("endings");
        std::fs::write(dir.join("library.json"), serde_json::to_string(&vec![v]).unwrap()).unwrap();

        let loaded = Store { dir }.load_library();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].play_seconds, 0);
        assert!(loaded[0].endings.is_empty());
    }

    /// 目录改名后，旧库里的封面绝对路径要跟着换到新目录，否则封面全部 404
    #[test]
    fn legacy_cover_paths_rebase_to_current_dir() {
        let dir = std::env::temp_dir().join(format!("stash-rebase-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (mut games, _) = merge_games(&[], vec![detected("D:/games/REBASE")]);
        let old_cover = dirs::data_dir()
            .unwrap()
            .join(LEGACY_NAME)
            .join("covers")
            .join("x.jpg");
        games[0].cover = Some(old_cover.to_string_lossy().into_owned());
        std::fs::write(
            dir.join("library.json"),
            serde_json::to_string(&games).unwrap(),
        )
        .unwrap();

        let loaded = Store { dir: dir.clone() }.load_library();
        let cover = loaded[0].cover.clone().unwrap();
        assert!(
            cover.starts_with(&*dir.to_string_lossy()),
            "应换到现行目录：{cover}"
        );
        assert!(
            cover.ends_with("covers\\x.jpg") || cover.ends_with("covers/x.jpg"),
            "{cover}"
        );
        assert!(!cover.contains(LEGACY_NAME), "{cover}");
    }

    /// 旧 settings.json 没有 motion / verticalTitle 字段：必须仍能读，其余字段走默认
    #[test]
    fn settings_without_new_fields_defaults() {
        let dir = std::env::temp_dir().join(format!("stash-set-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"version":1,"fpsMode":"90","sort":"title",
                "network":{"metadataEnabled":true,"proxy":null},"locale":{"warnOnly":true}}"#,
        )
        .unwrap();
        let s = Store { dir }.load_settings();
        assert_eq!(s.fps_mode, "90");
        assert_eq!(s.sort, "title");
        assert_eq!(s.motion, 0, "缺字段时按标准动效");
        assert!(s.vertical_title, "缺字段时竖排原名默认开启");
        assert!(!s.autostart, "缺字段时开机自启默认关闭");
        assert!(s.fullscreen, "缺字段时全屏默认开启（掌机优先）");
        assert_eq!(s.theme, "cinema", "旧设置缺 theme 时回落影院暗色");
        assert_eq!(s.layout, "classic", "旧设置缺 layout 时回落经典布局");
        assert_eq!(s.pad_map, crate::models::PadMap::default(), "缺 padMap 时按键位表默认值");
    }

    /// 键位表写入后要能原样读回（含撞键 / 非默认值），否则改键在重启后丢失
    #[test]
    fn settings_roundtrip_keeps_custom_pad_map() {
        let dir = std::env::temp_dir().join(format!("stash-set-map-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store { dir };
        let mut s = store.load_settings();
        s.pad_map.accept = "west".into();
        s.pad_map.y = "rb".into();
        store.save_settings(&s).unwrap();
        let back = store.load_settings();
        assert_eq!(back.pad_map.accept, "west");
        assert_eq!(back.pad_map.y, "rb");
        assert_eq!(back.pad_map.back, "east", "未改的键保持默认");
    }

    /// 坏掉的 settings.json 不能被「回默认值 + 下次保存覆盖」静默吃掉：
    /// 读失败时先把原文件改名留档，用户至少还能从 *.corrupt-* 里捞回配置
    #[test]
    fn corrupt_settings_is_quarantined() {
        let dir = std::env::temp_dir().join(format!("stash-set-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), "{ \"theme\": [\"D:\\\\Galgame\" ").unwrap();

        let s = Store { dir: dir.clone() }.load_settings();
        assert_eq!(s.theme, "cinema", "坏文件回落默认值");
        assert!(!dir.join("settings.json").exists(), "坏文件应改名留档");
        let kept = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("settings.json.corrupt-"));
        assert!(kept, "应留下 settings.json.corrupt-<ts>");
    }

    /// 同上：library.json 坏掉时也要留档，不能直接覆盖成空库
    #[test]
    fn corrupt_library_is_quarantined() {
        let dir = std::env::temp_dir().join(format!("stash-lib-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("library.json"), "[ { \"id\": ").unwrap();

        let games = Store { dir: dir.clone() }.load_library();
        assert!(games.is_empty(), "坏文件当空库处理");
        assert!(!dir.join("library.json").exists(), "坏文件应改名留档");
        let kept = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("library.json.corrupt-"));
        assert!(kept, "应留下 library.json.corrupt-<ts>");
    }
}

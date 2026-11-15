//! 维护类命令：库体检 / 失效清理 / 存储清理 / 导入导出 / 诊断报告。
//!
//! 全部是「读整库 + 遍历磁盘」的重活，命令层一律 spawn_blocking；
//! 判定规则（离线盘保留、孤儿归属）与 store 保持一致。
use crate::log;
use crate::models::{AppError, ErrCode, Game, Settings};
use crate::store::{self, Store};
use serde::{Deserialize, Serialize};
use tauri::State;

/// explorer.exe 的绝对路径：裸名 "explorer" 会走 PATH 解析，同目录被塞一个
/// explorer.exe 就能被劫持——固定用系统目录下的绝对路径
#[cfg(windows)]
fn explorer_exe() -> String {
    std::env::var("SystemRoot")
        .map(|r| format!(r"{r}\explorer.exe"))
        .unwrap_or_else(|_| r"C:\Windows\explorer.exe".to_string())
}

/// 用资源管理器打开一个目录（不弹控制台窗口）
pub fn open_in_explorer(dir: &std::path::Path) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(explorer_exe())
            .arg(dir)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| AppError::new(ErrCode::IoError, format!("打开目录失败：{e}")))?;
    }
    #[cfg(not(windows))]
    let _ = dir;
    Ok(())
}

#[tauri::command]
pub fn open_dir(store: State<'_, Store>, id: String) -> Result<(), AppError> {
    let games = store.load_library();
    let g = games
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
    open_in_explorer(std::path::Path::new(&g.dir))
}

/// 关于页自助排障：打开数据目录 / 日志目录（`kind = "logs"` 时后者）
#[tauri::command]
pub fn open_app_dir(store: State<'_, Store>, kind: String) -> Result<(), AppError> {
    let dir = if kind == "logs" {
        log::logs_dir()
    } else {
        store.dir.clone()
    };
    let _ = std::fs::create_dir_all(&dir);
    open_in_explorer(&dir)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogIssue {
    time: String,
    level: String,
    text: String,
}

/// 关于页自助排障：最近几条 WARN / ERROR。
/// `async`：要整份读日志文件（单份上限 5MB、最多 7 天），不能占主线程。
#[tauri::command]
pub async fn recent_log_issues(limit: Option<usize>) -> Vec<LogIssue> {
    tauri::async_runtime::spawn_blocking(move || {
        log::recent_issues(limit.unwrap_or(6).clamp(1, 50))
            .into_iter()
            .map(|i| LogIssue {
                time: i.time,
                level: i.level,
                text: i.text,
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 前端首帧 / 库就绪耗时回传：只在日志里留一行，供压测与用户反馈时对时间线。
/// 前端 `performance.now()` 的起点是页面加载，进程耗时由后端自己算，两者都记便于区分瓶颈。
#[tauri::command]
pub fn report_timing(name: String, ms: Option<f64>) {
    match ms {
        Some(ms) => tracing::info!("timing: {name} 前端 {ms:.0} ms / 进程 {:.0} ms", crate::boot_ms()),
        None => tracing::info!("timing: {name} 进程 {:.0} ms", crate::boot_ms()),
    }
}

/// 关于页自助排障：把版本 / 环境 / 设置 / 库统计 / 最近问题汇成一份文本报告。
///
/// 落盘到 `<数据目录>/diagnostics/` 并返回路径，用户可直接把文件发给开发者。
/// 刻意不打包 zip：一条文本零依赖、可直接阅读，体积也远小于日志原件；
/// 订阅地址与代理一律只报「已配置」，不写回原文——它们属于用户凭据。
#[tauri::command]
pub async fn export_diagnostics(store: State<'_, Store>) -> Result<String, AppError> {
    let st = store.inner().clone();
    // 要读全量日志（最多 35MB）+ 写文件：同步命令跑在主线程，会把界面冻住
    let path = tauri::async_runtime::spawn_blocking(move || export_diagnostics_sync(&st))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))??;
    Ok(path.to_string_lossy().to_string())
}

pub fn export_diagnostics_sync(store: &Store) -> Result<std::path::PathBuf, AppError> {
    let s = store.load_settings();
    let games = store.load_library();
    let on_off = |v: bool| if v { "开" } else { "关" };
    let total_secs: u64 = games.iter().map(|g| g.play_seconds).sum();
    let total_gb: f64 = games.iter().map(|g| g.size_gb).sum();

    let mut out = String::new();
    out.push_str("Stash 诊断报告\n");
    out.push_str(&format!("导出日期（UTC）：{}\n", log::today()));
    out.push_str(&format!("应用版本：{}\n", env!("CARGO_PKG_VERSION")));
    out.push_str(&format!(
        "运行环境：{} {} · Tauri {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        tauri::VERSION
    ));
    out.push_str(&format!("数据目录：{}\n", store.dir.display()));
    out.push_str(&format!("日志目录：{}\n\n", log::logs_dir().display()));

    out.push_str("[设置]\n");
    out.push_str(&format!(
        "主题 {} ｜ 布局 {} ｜ 动效 {} ｜ 帧率模式 {} ｜ 排序 {}\n",
        s.theme,
        s.layout,
        if s.motion == 1 { "柔和" } else { "标准" },
        s.fps_mode,
        s.sort
    ));
    out.push_str(&format!(
        "开机自启 {} ｜ 启动全屏 {} ｜ 手柄映射鼠标 {} ｜ A/B 互换 {} ｜ 锁 60Hz {}\n",
        on_off(s.autostart),
        on_off(s.fullscreen),
        on_off(s.gamepad_mouse),
        on_off(s.ab_swap),
        on_off(s.power60)
    ));
    out.push_str(&format!(
        "元数据联网 {} ｜ 萌娘百科兜底 {} ｜ 系统代理 {}\n\n",
        on_off(s.network.metadata_enabled),
        on_off(s.network.moegirl_fallback),
        if crate::net::system_proxy().is_some() {
            "已启用（已脱敏）"
        } else {
            "未启用（直连）"
        }
    ));

    out.push_str("[库]\n");
    out.push_str(&format!(
        "作品 {} 部 ｜ 收藏 {} ｜ 已匹配元数据 {} ｜ 需转区 {}\n",
        games.len(),
        games.iter().filter(|g| g.favorite).count(),
        games.iter().filter(|g| g.matched).count(),
        games.iter().filter(|g| g.needs_locale).count()
    ));
    out.push_str(&format!(
        "缺封面 {} ｜ 缺缩略图 {} ｜ 累计游玩 {:.1} 小时 ｜ 目录总量 {:.1} GB\n\n",
        games.iter().filter(|g| g.cover.is_none()).count(),
        games.iter().filter(|g| g.thumb.is_none()).count(),
        total_secs as f64 / 3600.0,
        total_gb
    ));

    out.push_str("[日志文件]\n");
    let logs = log::logs_dir();
    match std::fs::read_dir(&logs) {
        Ok(rd) => {
            let mut files: Vec<(String, u64)> = rd
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|e| {
                    (
                        e.file_name().to_string_lossy().to_string(),
                        e.metadata().map(|m| m.len()).unwrap_or(0),
                    )
                })
                .collect();
            files.sort();
            if files.is_empty() {
                out.push_str("（日志目录为空）\n");
            }
            for (name, size) in files {
                out.push_str(&format!("{name}  {:.1} KB\n", size as f64 / 1024.0));
            }
        }
        Err(e) => out.push_str(&format!("（读取日志目录失败：{e}）\n")),
    }

    out.push_str("\n[最近问题]\n");
    let issues = log::recent_issues(40);
    if issues.is_empty() {
        out.push_str("（无 WARN / ERROR 记录）\n");
    }
    for i in issues {
        out.push_str(&format!("{} [{}] {}\n", i.time, i.level, i.text));
    }

    let dir = store.dir.join("diagnostics");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("诊断报告-{}-{}.txt", log::today(), store::now_secs()));
    // 报告是拿去发给别人看的：绝对路径、URL、疑似密钥在落盘前统一抹掉
    std::fs::write(&path, redact_diagnostics(&out))?;
    Ok(path)
}

/// 诊断报告脱敏：保留结论，抹掉本机路径、URL 与 `key=value` 形式的凭据。
pub(crate) fn redact_diagnostics(raw: &str) -> String {
    raw.lines().map(redact_line).collect::<Vec<_>>().join("\n")
}

fn redact_line(line: &str) -> String {
    const MARK: &str = "<已脱敏>";
    let mut out = String::with_capacity(line.len());
    let mut i = 0usize;
    let b = line.as_bytes();
    while i < line.len() {
        let tail = &line[i..];
        let is_url = tail.starts_with("http://") || tail.starts_with("https://");
        // 盘符路径：C:\ 或 C:/
        let is_drive = i + 2 < line.len()
            && b[i].is_ascii_alphabetic()
            && b[i + 1] == b':'
            && (b[i + 2] == b'\\' || b[i + 2] == b'/');
        let is_unix = tail.starts_with("/home/")
            || tail.starts_with("/Users/")
            || tail.starts_with("/root/")
            || tail.starts_with("%APPDATA%");
        if is_url || is_drive || is_unix {
            out.push_str(MARK);
            i = skip_sensitive(line, i);
            continue;
        }
        if let Some(len) = credential_run(tail) {
            out.push_str(MARK);
            i += len;
            continue;
        }
        let ch = tail.chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 从 `start` 起吃到空白或中文标点：路径 / URL 体内不会出现这些字符
fn skip_sensitive(s: &str, start: usize) -> usize {
    for (k, c) in s[start..].char_indices() {
        if c.is_whitespace() || "，。；）】、」".contains(c) {
            return start + k;
        }
    }
    s.len()
}

/// `client_secret=xxx` / `apiKey=xxx` / `token=xxx`：返回整段字节长度
fn credential_run(tail: &str) -> Option<usize> {
    let eq = tail.find('=')?;
    if eq == 0 || eq > 40 {
        return None;
    }
    let name = &tail[..eq];
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let sensitive = ["secret", "token", "apikey", "api_key", "password", "passwd", "key"]
        .iter()
        .any(|k| lower.contains(k));
    if !sensitive {
        return None;
    }
    let mut end = eq + 1;
    for (k, c) in tail[eq + 1..].char_indices() {
        if c.is_whitespace() || c == '&' || c == ',' || c == ';' {
            return Some(eq + 1 + k);
        }
        end = eq + 1 + k + c.len_utf8();
    }
    Some(end)
}

/* ============ 库体检（核心维护，无 AI） ============ */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssue {
    kind: String,
    title: String,
    detail: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    total: usize,
    missing_dirs: usize,
    missing_exes: usize,
    duplicates: usize,
    unknown_engines: usize,
    missing_covers: usize,
    orphan_thumbs: usize,
    orphan_covers: usize,
    tmp_leftovers: usize,
    issues: Vec<HealthIssue>,
}

/// 重复分组：同一主程序（大小写/斜杠归一）视为重复；跨目录同名也算疑似重复，
/// 汉化/生肉这类同名版本交给用户自行判断，不自动合并。
pub fn duplicate_groups(games: &[Game]) -> Vec<Vec<usize>> {
    use std::collections::HashMap;
    let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, g) in games.iter().enumerate() {
        let exe = g.exe.trim().replace('/', "\\").to_lowercase();
        let title = g.title.trim().to_lowercase();
        let key = if exe.is_empty() || !std::path::Path::new(&g.exe).is_file() {
            format!("t:{title}")
        } else {
            format!("e:{exe}")
        };
        by_key.entry(key).or_default().push(i);
    }
    let mut out: Vec<Vec<usize>> = by_key.into_values().filter(|v| v.len() > 1).collect();
    out.sort_by_key(|v| v[0]);
    out
}

/// 缓存文件名归属的 game id；不认识的文件返回 None（绝不误删）。
pub fn cache_owner(name: &str, thumbs: bool) -> Option<String> {
    if thumbs {
        if !name.ends_with(".webp") {
            return None;
        }
        let base = name.trim_end_matches(".webp");
        // 候选条目封面（cand-<subjectId>.webp，见 thumb::candidate_thumb）与背景候选缩略图
        // （bg-<id>-<hash>.webp，见 thumb::bg_thumb_*）都不属于任何作品：
        // 它们由 thumb::prune_candidates / prune_bg 按数量 LRU 自管。这里必须返回 None——
        // 否则体检会把它们算成「孤儿缓存」，还会被「清理无用数据」删掉，下次又得重下。
        if base.starts_with("cand-") || base.starts_with("bg-") {
            return None;
        }
        return Some(base.split('@').next().unwrap_or(base).to_string());
    }
    // `_auto.` 是「智能选封面」的产物：漏掉它的话，这类文件既不计入体检的孤儿封面，
    // 也不会被 clean_orphan_cache 清掉——删掉作品后它就一直躺在 covers/ 里
    // `_bg.` 是详情页背景图（商店横幅 / 用户指定），同理必须能识别归属
    for sep in ["_src.", "_custom.", "_auto.", "_bg."] {
        if let Some((id, _)) = name.split_once(sep) {
            return Some(id.to_string());
        }
    }
    None
}

/// 缩略图 / 封面是「先写 .tmp 再 rename」。清理若正好撞上写入，会把正在写的文件删掉，
/// 这次保存就失败。只收 10 分钟前的 .tmp：既避开写入窗口，也仍能收掉崩溃残留。
const TMP_STALE_SECS: u64 = 600;

fn stale_tmp(path: &std::path::Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|d| d.as_secs() >= TMP_STALE_SECS)
}

pub fn cache_stats(
    dir: &std::path::Path,
    ids: &std::collections::HashSet<String>,
    thumbs: bool,
) -> (usize, usize) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let (mut orphan, mut tmp) = (0usize, 0usize);
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".tmp") {
            if stale_tmp(&e.path()) {
                tmp += 1;
            }
            continue;
        }
        if let Some(id) = cache_owner(&name, thumbs) {
            if !ids.contains(&id) {
                orphan += 1;
            }
        }
    }
    (orphan, tmp)
}

/// 库体检。`async`：要遍历每个游戏的目录 / exe / 缓存目录，大库上秒级。
#[tauri::command]
pub async fn library_health(store: State<'_, Store>) -> Result<HealthReport, AppError> {
    let st = store.inner().clone();
    // 逐个 is_dir / is_file 在移动盘 / 网络盘上会阻塞几十秒：
    // 与 get_library 一致，整段体检挪出 tokio worker
    tauri::async_runtime::spawn_blocking(move || library_health_sync(&st))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn library_health_sync(store: &Store) -> Result<HealthReport, AppError> {
    let games = store.load_library();

    let mut issues: Vec<HealthIssue> = Vec::new();
    let (mut missing_dirs, mut missing_exes, mut missing_covers, mut unknown_engines) =
        (0usize, 0usize, 0usize, 0usize);
    for g in &games {
        if !std::path::Path::new(&g.dir).is_dir() {
            // 整块盘不在（移动盘没插 / 网络盘掉线）：这是「暂时离线」而不是「条目失效」，
            // 不计入缺失数——否则界面提示「N 部已丢失」点确认后 prune 却一部都不删
            if !store::volume_available(std::path::Path::new(&g.dir)) {
                continue;
            }
            missing_dirs += 1;
            issues.push(HealthIssue {
                kind: "missingDir".into(),
                title: g.title.clone(),
                detail: format!("目录不存在：{}", g.dir),
            });
            continue;
        }
        if !std::path::Path::new(&g.exe).is_file() {
            missing_exes += 1;
            issues.push(HealthIssue {
                kind: "missingExe".into(),
                title: g.title.clone(),
                detail: format!("主程序不存在：{}", g.exe),
            });
        }
        if let Some(c) = g.cover.as_deref().filter(|c| !c.trim().is_empty()) {
            if !std::path::Path::new(c).is_file() {
                missing_covers += 1;
                issues.push(HealthIssue {
                    kind: "missingCover".into(),
                    title: g.title.clone(),
                    detail: "封面文件已丢失（可更换封面）".into(),
                });
            }
        }
        if g.engine == crate::models::EngineKind::Unknown {
            unknown_engines += 1;
            issues.push(HealthIssue {
                kind: "unknownEngine".into(),
                title: g.title.clone(),
                detail: "未识别引擎：存档探测与转区提示可能不准确".into(),
            });
        }
    }

    let groups = duplicate_groups(&games);
    let duplicates = groups.len();
    for group in &groups {
        let titles: Vec<String> = group.iter().map(|i| games[*i].title.clone()).collect();
        issues.push(HealthIssue {
            kind: "duplicate".into(),
            title: titles.first().cloned().unwrap_or_default(),
            detail: format!(
                "{} 个条目：{}",
                group.len(),
                titles
                    .iter()
                    .take(6)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" / ")
            ),
        });
    }

    let ids: std::collections::HashSet<String> = games.iter().map(|g| g.id.clone()).collect();
    let (orphan_thumbs, tmp_a) = cache_stats(&store.thumbs_dir(), &ids, true);
    let (orphan_covers, tmp_b) = cache_stats(&store.covers_dir(), &ids, false);

    issues.truncate(200);
    Ok(HealthReport {
        total: games.len(),
        missing_dirs,
        missing_exes,
        duplicates,
        unknown_engines,
        missing_covers,
        orphan_thumbs,
        orphan_covers,
        tmp_leftovers: tmp_a + tmp_b,
        issues,
    })
}

/// 移除目录或主程序已丢失的条目（游玩记录会一并删除，前端必须先确认）。
/// `async`：`is_dir/is_file` 在网络盘 / 已拔出的移动盘上会阻塞几十秒。
#[tauri::command]
pub async fn prune_missing_games(store: State<'_, Store>) -> Result<usize, AppError> {
    let st = store.inner().clone();
    // 逐个 stat 可能阻塞几十秒：不能占着 tokio worker
    tauri::async_runtime::spawn_blocking(move || prune_missing_games_sync(&st))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn prune_missing_games_sync(store: &Store) -> Result<usize, AppError> {
    // 失效判定（逐个 is_dir / is_file）放在锁外：慢盘上可达几十秒，
    // 持锁期间收藏 / 评分这些主线程同步命令会一起卡死
    let dead: std::collections::HashSet<String> = store
        .load_library()
        .into_iter()
        .filter(|g| {
            let dir = std::path::Path::new(&g.dir);
            // 条目不一定是「目录被删」：移动盘没插 / 网络盘掉线时目录同样不存在，
            // 但那是暂时离线，删掉就再也拿不回游玩记录（与 merge_games 的保留规则一致）
            if !store::volume_available(dir) {
                return false;
            }
            !(dir.is_dir() && std::path::Path::new(&g.exe).is_file())
        })
        .map(|g| g.id)
        .collect();
    if dead.is_empty() {
        return Ok(0);
    }
    // 锁内重读一次再删：期间用户可能刚给这些条目改了名 / 取消隐藏
    let _lock = store::lock_library();
    let mut games = store.load_library();
    let before = games.len();
    games.retain(|g| !dead.contains(&g.id));
    let removed = before - games.len();
    if removed > 0 {
        store.save_library(&games)?;
        tracing::info!("health: 移除 {removed} 个失效条目");
    }
    Ok(removed)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanOut {
    pub freed_bytes: u64,
    /// 删掉的孤儿缓存文件数（缩略图 / 封面 / .tmp）
    pub cache_removed: usize,
}

/// 批量清理无用缓存（缩略图 / 封面 / .tmp）。
/// `async`：可能要删除上千个文件。
#[tauri::command]
pub async fn clean_storage(store: State<'_, Store>) -> Result<CleanOut, AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || clean_storage_sync(&st))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn clean_storage_sync(store: &Store) -> Result<CleanOut, AppError> {
    // 只在开始时取一次 id 集合，删除动作不持库锁：
    // 宁可偶尔多删一张（可再生缓存），也不要卡住主线程的写命令
    let ids: std::collections::HashSet<String> =
        store.load_library().iter().map(|g| g.id.clone()).collect();
    let mut out = CleanOut { freed_bytes: 0, cache_removed: 0 };

    for (dir, thumbs) in [(store.thumbs_dir(), true), (store.covers_dir(), false)] {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let hit = if name.ends_with(".tmp") {
                stale_tmp(&e.path())
            } else {
                cache_owner(&name, thumbs)
                    .map(|id| !ids.contains(&id))
                    .unwrap_or(false)
            };
            if hit {
                let size = std::fs::metadata(e.path()).map(|m| m.len()).unwrap_or(0);
                if std::fs::remove_file(e.path()).is_ok() {
                    out.cache_removed += 1;
                    out.freed_bytes = out.freed_bytes.saturating_add(size);
                }
            }
        }
    }

    if out.freed_bytes > 0 {
        tracing::info!(
            "clean_storage: 释放 {} B（缓存 {} 个）",
            out.freed_bytes,
            out.cache_removed
        );
    }
    Ok(out)
}

/* ============ M7 导出 / 导入 ============ */

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupBundle {
    version: u32,
    settings: Settings,
    library: Vec<Game>,
    /// 导出时的提示（例如「已排除凭据」）；旧备份没有这个字段，反序列化为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
}

/// 把备份里的封面 / 缩略图路径收编为「本机缓存目录 + 文件名」。
/// 只看最后一段：任何目录层级（含 `..`、绝对路径、子目录）都不进入结果。
fn adopt_cache_name(dir: &std::path::Path, raw: Option<String>) -> Option<String> {
    let p = raw?;
    let name = std::path::Path::new(&p).file_name()?.to_string_lossy().to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    Some(dir.join(name).to_string_lossy().to_string())
}

/// 导出库 + 设置到一个 JSON（不含封面缓存，体积小、可读）
#[tauri::command]
pub async fn export_data(store: State<'_, Store>, path: String) -> Result<usize, AppError> {
    let st = store.inner().clone();
    // 序列化 + 写盘都是同步 IO：与其它命令一致，别占 tokio worker
    tauri::async_runtime::spawn_blocking(move || export_data_sync(&st, &path))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn export_data_sync(store: &Store, path: &str) -> Result<usize, AppError> {
    // 备份文件会被拷来拷去：搜索 Key 一律不写进去，导入后由用户在设置页重填。
    let mut settings = store.load_settings();
    settings.network.sgdb_key = None;
    let bundle = BackupBundle {
        version: 1,
        settings,
        library: store.load_library(),
        notice: Some("已排除凭据，导入后需重填".to_string()),
    };
    let json = serde_json::to_string_pretty(&bundle)
        .map_err(|e| AppError::new(ErrCode::IoError, format!("序列化失败：{e}")))?;
    std::fs::write(path, json)?;
    tracing::info!("export: {path} ({} games)", bundle.library.len());
    Ok(bundle.library.len())
}

/// 导入前把现有库与设置另存一份，覆盖后可追溯
#[tauri::command]
pub async fn import_data(store: State<'_, Store>, path: String) -> Result<usize, AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || import_data_sync(&st, &path))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn import_data_sync(store: &Store, path: &str) -> Result<usize, AppError> {
    let text = std::fs::read_to_string(path)?;
    let b: BackupBundle = serde_json::from_str(&text)
        .map_err(|e| AppError::new(ErrCode::ConfigInvalid, format!("备份文件无法解析：{e}")))?;
    if b.version != 1 {
        return Err(AppError::new(ErrCode::ConfigInvalid, "备份版本不受支持"));
    }
    // 备份文件可能来自旧版本或被手工改过：id 必须以目录路径重新推导
    //（id 会被拼进 covers / thumbs 的路径，外来值不能直接信任），
    // 同时按 id 去重，避免同一个目录在库里出现两条记录。
    // 但「库里已有同目录条目」必须沿用旧 id：id 是缓存文件名，重算会让
    // 封面 / 缩略图全部失联（与 merge_games 的迁移规则保持一致）。
    let existing: std::collections::HashMap<String, String> = store
        .load_library()
        .into_iter()
        .map(|g| (store::normalize_dir(&g.dir), g.id))
        .collect();
    let library = rebind_import_ids(b.library, &existing)
        .into_iter()
        .map(|mut g| {
            // 备份里的 cover / thumb 可能是别的机器的绝对路径，甚至是 `..\` 这类
            // 越界路径；一律收编成本机缓存目录下的文件名，后续删除才敢直接删。
            g.cover = adopt_cache_name(store.covers_dir().as_path(), g.cover);
            g.thumb = adopt_cache_name(store.thumbs_dir().as_path(), g.thumb);
            g
        })
        .collect::<Vec<_>>();
    let settings = normalize_settings(b.settings);
    let stamp = store::now_secs();
    // 备份失败必须中止导入：否则「覆盖后可追溯」这句承诺是假的，
    // 磁盘满 / 目录只读时用户会在没有任何退路的情况下丢掉原库
    for (src, tag) in [(store.settings_path(), "settings"), (store.library_path(), "library")] {
        if !src.exists() {
            continue;
        }
        let dst = store.dir.join(format!("{tag}.pre-import-{stamp}.json"));
        std::fs::copy(&src, &dst).map_err(|e| {
            AppError::new(ErrCode::IoError, format!("导入前备份 {} 失败：{e}", src.display()))
        })?;
    }
    {
        let _lock = store::lock_settings();
        store.save_settings(&settings)?;
    }
    // 与手动入库共用同一把库锁：导入不能被另一处读到一半的旧数据覆盖
    {
        let _lock = store::lock_library();
        store.save_library(&library)?;
    }
    tracing::info!("import: {path} ({} games)", library.len());
    Ok(library.len())
}

/// 导入时的 id 归属：库里已有同目录条目就沿用旧 id（缓存文件名以 id 命名），
/// 否则按目录重算；同一目录出现两次只保留一条。
pub fn rebind_import_ids(
    imported: Vec<Game>,
    existing: &std::collections::HashMap<String, String>,
) -> Vec<Game> {
    let mut seen = std::collections::HashSet::new();
    imported
        .into_iter()
        .filter_map(|mut g| {
            g.id = existing
                .get(&store::normalize_dir(&g.dir))
                .cloned()
                .unwrap_or_else(|| store::stable_id(&g.dir));
            seen.insert(g.id.clone()).then_some(g)
        })
        .collect()
}

/// 外来设置（备份 / 手改 json）落盘前收敛到受支持的取值，避免 UI 选中项全空。
/// 规则集中在 `Settings::normalized()`，读盘（store）与导入共用同一份。
pub fn normalize_settings(s: Settings) -> Settings {
    s.normalized()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("stash-maintenance-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Store { dir }
    }

    #[test]
    fn import_rebinds_media_to_local_cache_names() {
        let store = temp_store("media");
        let game = Game {
            dir: r"D:\Games\AIR".into(),
            cover: Some(store.dir.join("external").join("cover.jpg").to_string_lossy().into_owned()),
            thumb: Some("../thumb.webp".into()),
            ..Default::default()
        };
        let backup = store.dir.join("backup.json");
        std::fs::write(
            &backup,
            serde_json::to_string(&serde_json::json!({
                "version": 1,
                "settings": Settings::default(),
                "library": [game],
            })).unwrap(),
        ).unwrap();

        import_data_sync(&store, &backup.to_string_lossy()).unwrap();
        let games = store.load_library();
        assert_eq!(games[0].cover.as_deref(), store.covers_dir().join("cover.jpg").to_str());
        assert_eq!(games[0].thumb.as_deref(), store.thumbs_dir().join("thumb.webp").to_str());
        let _ = std::fs::remove_dir_all(&store.dir);
    }

    #[test]
    fn fresh_tmp_is_not_reported_as_garbage() {
        let store = temp_store("tmp");
        let thumbs = store.thumbs_dir();
        std::fs::create_dir_all(&thumbs).unwrap();
        std::fs::write(thumbs.join("thumb-x.jpg.tmp"), b"x").unwrap();
        let ids = std::collections::HashSet::new();
        assert_eq!(cache_stats(&thumbs, &ids, true), (0, 0), "正在写的 .tmp 不能被当垃圾");
        let _ = std::fs::remove_dir_all(&store.dir);
    }

    #[test]
    fn export_excludes_credentials_and_marks_notice() {
        let store = temp_store("credentials");
        let mut settings = Settings::default();
        settings.network.sgdb_key = Some("sgdb-secret".into());
        store.save_settings(&settings).unwrap();
        let backup = store.dir.join("backup.json");

        export_data_sync(&store, &backup.to_string_lossy()).unwrap();
        let text = std::fs::read_to_string(&backup).unwrap();
        assert!(!text.contains("sgdb-secret"), "备份不能包含凭据");
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["notice"], "已排除凭据，导入后需重填");
        let _ = std::fs::remove_dir_all(&store.dir);
    }

    #[test]
    fn backup_without_notice_still_imports() {
        let store = temp_store("old-backup");
        let backup = store.dir.join("old.json");
        std::fs::write(
            &backup,
            serde_json::to_string(&serde_json::json!({
                "version": 1,
                "settings": Settings::default(),
                "library": [],
            })).unwrap(),
        ).unwrap();
        assert_eq!(import_data_sync(&store, &backup.to_string_lossy()).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&store.dir);
    }

    #[test]
    fn diagnostic_redaction_removes_paths_urls_and_keys() {
        let raw = concat!(
            "数据目录：C:\\Users\\alice\\Stash\n",
            "下载 https://user:pass@example.com/sub?token=url-secret 失败\n",
            "client_secret=key-secret apiKey=json-secret 正常文本\n",
            "Unix 路径 /home/alice/private/config.json\n",
        );
        let text = redact_diagnostics(raw);
        for secret in [
            "alice", "example.com", "url-secret", "key-secret", "json-secret", "user:pass",
        ] {
            assert!(!text.contains(secret), "诊断报告仍包含敏感内容 {secret}：{text}");
        }
        assert!(text.contains("正常文本"));
    }

    #[test]
    fn diagnostics_do_not_export_local_paths() {
        let store = temp_store("diagnostics");
        let path = export_diagnostics_sync(&store).unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        assert!(!text.contains(&store.dir.to_string_lossy().to_string()));
        let _ = std::fs::remove_dir_all(&store.dir);
    }
}

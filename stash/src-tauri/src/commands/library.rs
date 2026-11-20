//! 库命令：读取 / 手动添加 / 库根扫描预览与导入。
//!
//! 共同点：读盘或建缩略图（秒级），命令层一律 async + spawn_blocking；
//! 库写操作统一走 `store::lock_library`，设置的读改写走 `store::lock_settings`。

use crate::models::{
    AppError, ErrCode, Game, RootScanOut, ScanCandidate, ScanPick, SteamCandidate,
    SteamImportOut,
};
use crate::store::{self, Store};
use crate::{scanner, thumb};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// 导入串行锁：扫描 + 大量体积统计可能持续几十秒，连点按钮不能并发跑两轮
static SCAN_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn get_library(app: AppHandle, store: State<'_, Store>) -> Result<Vec<Game>, AppError> {
    // 全库 thumb 存在性检查 + 目录 stat 都在磁盘上：库大 / 目录在慢盘时
    // 同步命令会让主线程卡住，这里挪到阻塞线程池
    let st = store.inner().clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // ① 锁内只做快照读取。自愈写盘必须确认来源是主文件：
        //    主文件瞬时读失败（杀软 / 云同步 / 文件被占用）时 load_library 会回落到
        //    .bak，把旧一代写回主文件等于丢一代数据。降级副本只展示、不回写。
        let (mut games, from_main) = {
            let _lock = store::lock_library();
            match st.load_library_from_main() {
                Some(g) => (g, true),
                None => (st.load_library(), false),
            }
        };
        // ② 缓存文件存在性检查放在锁外：封面可能在移动盘 / SMB 上，
        //    stat 超时不能把 set_favorite / END / 退出写盘一起卡住。
        let cache = [st.covers_dir(), st.thumbs_dir()];
        let mut stale_thumb: Vec<(String, String)> = Vec::new();
        let mut stale_cover: Vec<(String, String)> = Vec::new();
        let mut stale_override: Vec<(String, String)> = Vec::new();
        for g in games.iter_mut() {
            // 缩略图与封面都是可再生 / 可重新匹配的缓存。清过缓存目录、杀软清理、
            // 换机器恢复备份之后，库里记着的路径可能已经不存在——只把返回值置空的话，
            // 下次读取还是老样子（卡片停在深色空图上，`spawn_thumbs` 也永远看不到缺失）。
            if let Some(p) = g.thumb.clone() {
                if media_stale(&p, &cache) {
                    g.thumb = None;
                    stale_thumb.push((g.id.clone(), p));
                }
            }
            if let Some(p) = g.cover.clone() {
                if media_stale(&p, &cache) {
                    g.cover = None;
                    stale_cover.push((g.id.clone(), p));
                }
            }
            // 自选封面与 cover 是一对：只清 cover 会留下 cover_override，
            // 之后自动匹配永远不会再写封面（卡片永久空白），必须同步清掉。
            if let Some(p) = g.cover_override.clone() {
                if media_stale(&p, &cache) {
                    g.cover_override = None;
                    stale_override.push((g.id.clone(), p));
                }
            }
        }
        // ③ 来源可信才写回：短锁重新 load，按 id + 原路径精确清理，
        //    不覆盖等待期间别处对其它作品的修改。
        let has_stale =
            !(stale_thumb.is_empty() && stale_cover.is_empty() && stale_override.is_empty());
        if from_main && has_stale {
            let _lock = store::lock_library();
            if let Some(mut latest) = st.load_library_from_main() {
                let mut changed = false;
                for g in latest.iter_mut() {
                    changed |= clear_stale_media(&g.id, &mut g.thumb, &stale_thumb);
                    changed |= clear_stale_media(&g.id, &mut g.cover, &stale_cover);
                    changed |= clear_stale_media(&g.id, &mut g.cover_override, &stale_override);
                }
                if changed {
                    if let Err(e) = st.save_library(&latest) {
                        // 落盘失败不影响本次展示：返回副本里已经清掉了失效路径
                        tracing::warn!("get_library: 清理失效封面 / 缩略图路径失败：{e}");
                    }
                }
                // 返回与磁盘一致的最新快照（其它字段可能在这期间被别处改过）
                games = latest;
            }
        }
        // asset 协议白名单是空的（不再 `**`），每次把当前要显示的封面 / 本地实机图登记进去
        crate::allow_library_assets(&app2, &games);
        // 缓存目录被清空后靠这里补回来：只挑有封面、缺缩略图的条目交给后台生成
        spawn_thumbs(&app2, &st, &games);
        games
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))
}

/// 按 id + 原路径精确清理失效媒体（锁内重新 load 后调用，避免误伤别处的新值）
fn clear_stale_media(id: &str, field: &mut Option<String>, stale: &[(String, String)]) -> bool {
    let Some(cur) = field.as_deref() else { return false };
    if stale.iter().any(|(sid, p)| sid == id && p == cur) {
        *field = None;
        true
    } else {
        false
    }
}

/// 手动添加单部作品：选主程序 exe + 填标题，绕过目录识别门槛直接入库。
#[tauri::command]
pub async fn add_game(
    app: AppHandle,
    store: State<'_, Store>,
    exe: String,
    title: String,
) -> Result<Game, AppError> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::new(ErrCode::ConfigInvalid, "标题不能为空"));
    }
    if title.chars().count() > 120 {
        return Err(AppError::new(ErrCode::ConfigInvalid, "标题最长 120 字"));
    }
    let exe_path = std::path::PathBuf::from(exe.trim());
    let is_exe = exe_path
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("exe"))
        .unwrap_or(false);
    if !is_exe || !exe_path.is_file() {
        return Err(AppError::new(ErrCode::NotFound, "找不到该 exe，或不是 .exe 文件"));
    }
    let dir = exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "无法确定游戏目录"))?;
    // 入库是启动链的入口：在这里拦住「目录外的 exe / 系统脚本宿主」，
    // 否则一次「拖入 cmd.exe」就能把任意命令写进库、之后一点即执行。
    crate::guard_game_exe(&exe_path, &dir)?;
    let dir_s = dir.to_string_lossy().to_string();
    let id = crate::store::stable_id(&dir_s);
    let store2 = store.inner().clone();

    // 目录体积统计可能较慢：和探测一样放到阻塞线程
    let (dir2, exe2, title2) = (dir.clone(), exe_path.clone(), title.clone());
    let detected = tauri::async_runtime::spawn_blocking(move || {
        scanner::detect_manual(&dir2, &exe2, &title2)
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?;

    let game = {
        let _lock = crate::store::lock_library();
        let mut games = store2.load_library();
        let dir_norm = crate::store::normalize_dir(&dir_s);
        if games
            .iter()
            .any(|g| g.id == id || crate::store::normalize_dir(&g.dir) == dir_norm)
        {
            return Err(AppError::new(
                ErrCode::AlreadyInLibrary,
                "该目录已在库中；要改名请用详情页「重命名」",
            ));
        }
        // merge_games 只处理传入的探测结果，正好用来生成一条带默认游玩记录的新 Game。
        // 旧库必须传空：传 `&games` 时它会把「玩过的旧手动条目」一并合并进来，
        // 并按 last_played 降序排在首位 —— 下面取到的就是旧作品，新作品反而没入库，
        // 库里还会留下两条同 id 记录（收藏 / 改名 / 删除都只命中第一条）
        let (mut merged, _) = crate::store::merge_games(&[], vec![detected]);
        let Some(mut g) = merged.drain(..).next() else {
            return Err(AppError::new(ErrCode::NotFound, "入库失败：探测结果为空"));
        };
        g.title_override = Some(title.clone());
        g.title = title.clone();
        g.manual = true;
        games.push(g.clone());
        store2.save_library(&games)?;
        tracing::info!("manual add {id} <- {dir_s}");
        g
    };

    // 手动添加等于「我就要它回来」：清掉忽略表里的同路径条目，
    // 否则设置页会一直挂着一条已经回库的忽略项
    {
        let _lock = crate::store::lock_ignored();
        let key = crate::store::normalize_dir(&game.exe);
        let mut ignored = store2.load_ignored();
        let before = ignored.len();
        ignored.retain(|x| crate::store::normalize_dir(&x.exe) != key);
        if ignored.len() != before {
            if let Err(e) = store2.save_ignored(&ignored) {
                tracing::warn!("清理忽略表失败：{e}");
            }
        }
    }

    // 封面缩略图入库时后台补生成（不阻塞入库返回）
    spawn_thumbs(&app, &store2, std::slice::from_ref(&game));

    Ok(game)
}

/// 缩略图生成失败缓存：key = id + 封面路径 + 封面 mtime。
/// 坏图 / 超大图会永远失败；不记负缓存的话每次 get_library 都会重新解码全库。
/// 源文件替换后 mtime 变化，key 自动失效并重试。
static THUMB_FAILED: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

fn thumb_failed() -> &'static Mutex<std::collections::HashSet<String>> {
    THUMB_FAILED.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn thumb_fail_key(id: &str, cover: &str) -> String {
    use std::time::UNIX_EPOCH;
    let mtime = std::fs::metadata(cover)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{id}|{cover}|{mtime}")
}

/// 为缺缩略图且有封面的条目后台补生成，完成发 `thumbs://done`。
fn spawn_thumbs(app: &AppHandle, store: &Store, games: &[Game]) {
    let failed: std::collections::HashSet<String> = thumb_failed()
        .lock()
        .map(|f| f.clone())
        .unwrap_or_default();
    let pending: Vec<(String, String, String)> = games
        .iter()
        .filter(|g| g.thumb.is_none())
        .filter_map(|g| g.cover.clone().map(|c| (g.id.clone(), c)))
        .map(|(id, cover)| {
            let key = thumb_fail_key(&id, &cover);
            (id, cover, key)
        })
        .filter(|(_, _, key)| !failed.contains(key))
        .collect();
    if pending.is_empty() {
        return;
    }
    let app = app.clone();
    let store = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 先把缩略图全部生成好：解码 + 缩放是重活，绝不能持库锁做
        let mut failed_now: Vec<String> = Vec::new();
        let done: Vec<(String, String)> = pending
            .into_iter()
            .filter_map(|(id, cover, key)| match thumb::ensure(&store, &cover, &id, false) {
                Some(p) => Some((id, p.to_string_lossy().to_string())),
                None => {
                    failed_now.push(key);
                    None
                }
            })
            .collect();
        if !failed_now.is_empty() {
            let mut f = thumb_failed().lock().unwrap_or_else(|e| e.into_inner());
            // 防御性上限：长期运行 + 大量坏图时不让集合无限增长
            if f.len() > 4096 {
                f.clear();
            }
            f.extend(failed_now);
        }
        if done.is_empty() {
            return;
        }
        // 一次 load + 批量改 + 一次 save：导入千部时不再产生千次全量落盘
        let _lock = store::lock_library();
        let mut games = store.load_library();
        let mut any = false;
        for (id, path) in done {
            if let Some(g) = games.iter_mut().find(|g| g.id == id) {
                g.thumb = Some(path);
                any = true;
            }
        }
        if any {
            let _ = store.save_library(&games);
            let _ = app.emit("thumbs://done", ());
        }
    });
}

/// 添加游戏库根目录：持久化配置后立即扫描预览（**不入库**）。
/// 目录已配置时直接重扫，不重复添加。
#[tauri::command]
pub async fn add_library_root(
    store: State<'_, Store>,
    path: String,
) -> Result<Vec<ScanCandidate>, AppError> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err(AppError::new(ErrCode::NotFound, "找不到该文件夹"));
    }
    let root_s = root.to_string_lossy().to_string();
    let st = store.inner().clone();
    {
        let _lock = store::lock_settings();
        let mut s = st.load_settings();
        let norm = store::normalize_dir(&root_s);
        if !s.library_roots.iter().any(|p| store::normalize_dir(p) == norm) {
            s.library_roots.push(root_s.clone());
            s = s.normalized();
            st.save_settings(&s)?;
        }
    }
    tauri::async_runtime::spawn_blocking(move || preview_candidates(&st, &root))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))
}

/// 重新扫描一个已配置的库根，只返回候选清单
#[tauri::command]
pub async fn preview_library_root(
    store: State<'_, Store>,
    path: String,
) -> Result<Vec<ScanCandidate>, AppError> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err(AppError::new(ErrCode::NotFound, "找不到该文件夹"));
    }
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || preview_candidates(&st, &root))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))
}

/// 把预览里勾选的候选完整探测后写入库：只更新勾选项，其他库根 / 手动条目原样保留
#[tauri::command]
pub async fn import_library_root(
    app: AppHandle,
    store: State<'_, Store>,
    path: String,
    picks: Vec<ScanPick>,
) -> Result<RootScanOut, AppError> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err(AppError::new(ErrCode::NotFound, "找不到该文件夹"));
    }
    let st = store.inner().clone();
    let root_s = root.to_string_lossy().to_string();
    if picks.is_empty() {
        return Err(AppError::new(ErrCode::ConfigInvalid, "没有勾选任何作品"));
    }

    let detected = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<_>, AppError> {
        let _scan = SCAN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut detected = Vec::new();
        for p in picks {
            let dir = PathBuf::from(p.dir.trim());
            let exe = PathBuf::from(p.exe.trim());
            // 前端传来的路径必须仍在该库根之下：防止任意路径被写进库
            if !path_under(&root, &dir) || !path_under(&root, &exe) {
                return Err(AppError::new(
                    ErrCode::ConfigInvalid,
                    "候选路径不在该游戏库目录下",
                ));
            }
            // exe 已被人为移走：跳过这一条，不中断整批
            if !exe.is_file() {
                continue;
            }
            let title = if p.title.trim().is_empty() {
                dir.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                p.title.trim().to_string()
            };
            detected.push(scanner::detect_manual(&dir, &exe, &title));
        }
        Ok(detected)
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))??;

    let (games, report) = {
        let _lock = store::lock_library();
        let old = st.load_library();
        let (merged, report) = store::merge_into_library(&old, detected);
        st.save_library(&merged)?;
        (merged, report)
    };
    tracing::info!(
        "import library root {root_s}: added={} updated={} total={}",
        report.added,
        report.updated,
        report.total
    );
    spawn_thumbs(&app, &st, &games);

    Ok(RootScanOut { root: root_s, report })
}

/// 扫描本机 Steam 库（只读，不入库）：供库页签勾选
#[tauri::command]
pub async fn scan_steam(store: State<'_, Store>) -> Result<Vec<SteamCandidate>, AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let games = st.load_library();
        let ignored = st.load_ignored();
        let known: std::collections::HashSet<String> =
            games.iter().map(|g| store::normalize_dir(&g.dir)).collect();
        crate::steam::installed_apps()
            .into_iter()
            // 与库根扫描同口径：被移除的作品不再出现在候选里
            .filter(|app| !store::is_ignored(&ignored, &app.exe.to_string_lossy()))
            .map(|app| {
                let dir = app.dir.to_string_lossy().to_string();
                let (kind, _) = crate::engine::detect(&app.dir);
                SteamCandidate {
                    app_id: app.app_id,
                    name: app.name,
                    in_library: known.contains(&store::normalize_dir(&dir)),
                    exe: app.exe.to_string_lossy().to_string(),
                    engine: kind.label().to_string(),
                    dir,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))
}

/// 按 AppID 导入勾选的 Steam 游戏：后端重新扫描定位，不信任前端传入的路径
#[tauri::command]
pub async fn import_steam(
    app: AppHandle,
    store: State<'_, Store>,
    app_ids: Vec<u32>,
) -> Result<SteamImportOut, AppError> {
    if app_ids.is_empty() {
        return Err(AppError::new(ErrCode::ConfigInvalid, "没有勾选任何作品"));
    }
    let st = store.inner().clone();
    let detected = tauri::async_runtime::spawn_blocking(move || {
        let _scan = SCAN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let wanted: std::collections::HashSet<u32> = app_ids.into_iter().collect();
        crate::steam::installed_apps()
            .into_iter()
            .filter(|a| wanted.contains(&a.app_id))
            .map(|a| scanner::detect_manual(&a.dir, &a.exe, &a.name))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?;

    let (games, report) = {
        let _lock = store::lock_library();
        let old = st.load_library();
        let dirs: std::collections::HashSet<String> = detected
            .iter()
            .map(|d| store::normalize_dir(&d.dir))
            .collect();
        let (mut merged, report) = store::merge_into_library(&old, detected);
        // Steam 游戏不在用户配置的库根下：标成手动条目，避免以后库根变动时被当成孤儿
        for g in merged.iter_mut() {
            if dirs.contains(&store::normalize_dir(&g.dir)) {
                g.manual = true;
            }
        }
        st.save_library(&merged)?;
        (merged, report)
    };
    tracing::info!(
        "import steam: added={} updated={} total={}",
        report.added,
        report.updated,
        report.total
    );
    spawn_thumbs(&app, &st, &games);
    Ok(SteamImportOut { report })
}

/// 只移除库根配置，已入库作品保留（避免误删游玩记录）
#[tauri::command]
pub async fn remove_library_root(store: State<'_, Store>, path: String) -> Result<(), AppError> {
    let norm = store::normalize_dir(path.trim());
    let st = store.inner().clone();
    let _lock = store::lock_settings();
    let mut s = st.load_settings();
    let before = s.library_roots.len();
    s.library_roots.retain(|p| store::normalize_dir(p) != norm);
    if s.library_roots.len() != before {
        st.save_settings(&s)?;
    }
    Ok(())
}

/// 扫描候选：只找目录 / 主 exe / 引擎，不读体积与封面（预览要快）
fn preview_candidates(st: &Store, root: &Path) -> Vec<ScanCandidate> {
    let found = scanner::find_games(root);
    let games = st.load_library();
    let ignored = st.load_ignored();
    let known: std::collections::HashSet<String> =
        games.iter().map(|g| store::normalize_dir(&g.dir)).collect();
    found
        .into_iter()
        // 被「移除出库」记住的作品不再出现在候选里：否则用户删一次、扫一次，永远删不干净
        .filter(|f| !store::is_ignored(&ignored, &f.exe.to_string_lossy()))
        .map(|f| {
            let dir = f.dir.to_string_lossy().to_string();
            let (kind, _) = crate::engine::detect(&f.dir);
            ScanCandidate {
                title: f
                    .dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                in_library: known.contains(&store::normalize_dir(&dir)),
                dir,
                exe: f.exe.to_string_lossy().to_string(),
                engine: kind.label().to_string(),
            }
        })
        .collect()
}

/// p 是否位于 root 之下。
///
/// normalize_dir 只统一分隔符 / 大小写 / 尾斜杠，不解析 `..`，所以
/// `D:\Games\..\Other\x.exe` 仍会以 `d:\games\` 开头、骗过前缀比较。
/// 这里先显式拒绝含父目录组件的路径，再做归一化比较。
pub(crate) fn path_under(root: &Path, p: &Path) -> bool {
    use std::path::Component;
    let has_parent = |path: &Path| path.components().any(|c| c == Component::ParentDir);
    if has_parent(root) || has_parent(p) {
        return false;
    }
    if !normalized_under(root, p) {
        return false;
    }
    // 词法检查挡不住 junction / 符号链接：`root\link -> D:\Outside` 时字符串上
    // 仍在 root 下，真实位置已经逃出去。能解析就按真实路径再比一次；
    // 解析失败（网络盘、目标尚不存在）时退回词法结果，避免误杀。
    let canon_root = root.canonicalize().ok();
    let canon_p = p.canonicalize().ok().or_else(|| {
        p.parent().and_then(|parent| {
            parent
                .canonicalize()
                .ok()
                .map(|parent| parent.join(p.file_name().unwrap_or_default()))
        })
    });
    match (canon_root, canon_p) {
        (Some(r), Some(c)) => normalized_under(&r, &c),
        _ => true,
    }
}

/// 归一化后的前缀比较（大小写 / 分隔符 / 尾斜杠）
fn normalized_under(root: &Path, p: &Path) -> bool {
    let r = store::normalize_dir(&root.to_string_lossy());
    let d = store::normalize_dir(&p.to_string_lossy());
    if d == r {
        return true;
    }
    let prefix = if r.ends_with('\\') { r } else { format!("{r}\\") };
    d.starts_with(&prefix)
}

/// 媒体路径是否已失效（文件确实不在了）。
///
/// - 应用缓存目录（covers / thumbs）里的文件丢了就是丢了：它是可再生缓存，
///   备份里本来也不带图，留着路径只会让卡片停在深色空图上；
/// - 其它路径（游戏目录里的封面 / 截图）要**父目录还在**才算失效——外置盘拔掉时
///   父目录也会一起消失，这时清掉路径会让重新插盘后永远回不来。
fn media_stale(p: &str, cache_roots: &[PathBuf]) -> bool {
    let pb = Path::new(p);
    if pb.is_file() {
        return false;
    }
    let norm = store::normalize_dir(p);
    let in_cache = cache_roots.iter().any(|root| {
        let r = store::normalize_dir(&root.to_string_lossy());
        let prefix = if r.ends_with('\\') { r.clone() } else { format!("{r}\\") };
        norm == r || norm.starts_with(&prefix)
    });
    if in_cache {
        return true;
    }
    pb.parent().map(|d| d.is_dir()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{media_stale, path_under};
    use std::path::Path;

    #[test]
    fn accepts_paths_inside_root() {
        assert!(path_under(Path::new(r"D:\Games"), Path::new(r"D:\Games")));
        assert!(path_under(Path::new(r"D:\Games"), Path::new(r"D:\Games\VN\Game.exe")));
        // 大小写 / 正反斜杠按归一化处理
        assert!(path_under(Path::new(r"D:\Games"), Path::new(r"d:/games/vn/Game.exe")));
        assert!(path_under(Path::new(r"D:\Games\"), Path::new(r"D:\Games\Game.exe")));
    }

    #[test]
    fn rejects_sibling_with_shared_prefix() {
        assert!(!path_under(Path::new(r"D:\Games"), Path::new(r"D:\Games2\Game.exe")));
    }

    #[test]
    fn rejects_parent_dir_escape() {
        // 关键回归：归一化后仍以 d:\games\ 开头，必须靠组件检查拦住
        assert!(!path_under(
            Path::new(r"D:\Games"),
            Path::new(r"D:\Games\..\Other\Game.exe")
        ));
        assert!(!path_under(
            Path::new(r"D:\Games"),
            Path::new(r"D:\Games\VN\..\..\Other\Game.exe")
        ));
        // root 自身带 .. 也不放行
        assert!(!path_under(
            Path::new(r"D:\Games\..\Other"),
            Path::new(r"D:\Other\Game.exe")
        ));
    }

    /// junction / 符号链接逃逸：词法上在 root 下，真实路径在 root 外。
    /// Windows 建符号链接需要管理员或开发者模式，建不了就跳过（CI 常见）。
    #[cfg(windows)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::windows::fs::symlink_dir;
        let base = std::env::temp_dir().join(format!(
            "stash-path-under-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = root.join("link");
        if symlink_dir(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        assert!(!path_under(&root, &link.join("game.exe")));
        assert!(path_under(&root, &root.join("game.exe")));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 封面 / 缩略图自愈：缓存目录里的缺失直接清空路径（可再生），
    /// 游戏目录下的本地图缺失也清空；但父目录整个不在（外接盘离线）必须保留，
    /// 否则盘一断开就把库里记的路径永久抹掉了。
    #[test]
    fn media_stale_distinguishes_offline_drive_from_deleted_cache() {
        let base = std::env::temp_dir().join(format!(
            "stash-media-stale-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let cache = base.join("covers");
        let game_dir = base.join("game");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::create_dir_all(&game_dir).unwrap();
        let roots = vec![cache.clone(), base.join("thumbs")];

        let cache_missing = cache.join("abc.jpg").to_string_lossy().to_string();
        assert!(media_stale(&cache_missing, &roots), "缓存目录里缺失的图必须清掉");

        let local_missing = game_dir.join("cover.png").to_string_lossy().to_string();
        assert!(media_stale(&local_missing, &roots), "父目录在、文件缺失 → 清掉");

        let offline = base
            .join("offline-drive")
            .join("cover.jpg")
            .to_string_lossy()
            .to_string();
        assert!(
            !media_stale(&offline, &roots),
            "父目录也不存在（外接盘离线）→ 保留路径"
        );

        let present = game_dir.join("cover.png");
        std::fs::write(&present, b"x").unwrap();
        assert!(!media_stale(&present.to_string_lossy(), &roots));
        let _ = std::fs::remove_dir_all(&base);
    }
}

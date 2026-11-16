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
    tauri::async_runtime::spawn_blocking(move || {
        let mut games = st.load_library();
        // 缩略图是可再生的缓存文件。清过缓存目录 / 杀软清理 / 迁移过用户目录后，
        // 库里记着的路径可能已经不存在——继续交给前端只会让卡片停在深色底，
        // 这里直接丢掉该字段，前端退回原封面（下次更换封面时会重新生成）。
        for g in games.iter_mut() {
            if let Some(p) = g.thumb.as_deref() {
                if !std::path::Path::new(p).exists() {
                    g.thumb = None;
                }
            }
        }
        // asset 协议白名单是空的（不再 `**`），每次把当前要显示的封面 / 本地实机图登记进去
        crate::allow_library_assets(&app, &games);
        games
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))
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

    // 封面缩略图入库时后台补生成（不阻塞入库返回）
    spawn_thumbs(&app, &store2, std::slice::from_ref(&game));

    Ok(game)
}

/// 为缺缩略图且有封面的条目后台补生成，完成发 `thumbs://done`。
fn spawn_thumbs(app: &AppHandle, store: &Store, games: &[Game]) {
    let pending: Vec<(String, String)> = games
        .iter()
        .filter(|g| g.thumb.is_none())
        .filter_map(|g| g.cover.clone().map(|c| (g.id.clone(), c)))
        .collect();
    if pending.is_empty() {
        return;
    }
    let app = app.clone();
    let store = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 先把缩略图全部生成好：解码 + 缩放是重活，绝不能持库锁做
        let done: Vec<(String, String)> = pending
            .into_iter()
            .filter_map(|(id, cover)| {
                thumb::ensure(&store, &cover, &id, false)
                    .map(|p| (id, p.to_string_lossy().to_string()))
            })
            .collect();
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
        let known: std::collections::HashSet<String> =
            games.iter().map(|g| store::normalize_dir(&g.dir)).collect();
        crate::steam::installed_apps()
            .into_iter()
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
    let known: std::collections::HashSet<String> =
        games.iter().map(|g| store::normalize_dir(&g.dir)).collect();
    found
        .into_iter()
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
fn path_under(root: &Path, p: &Path) -> bool {
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

#[cfg(test)]
mod tests {
    use super::path_under;
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
}

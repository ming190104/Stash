//! 库记录命令：收藏 / 启动参数 / 标题 / 隐藏 / 标签 / 备注 / 评分 / END / 移除。
//!
//! 这些都是 `library.json` 的读—改—写，统一走 `crate::mutate_game`（同一把库写锁），
//! 只改索引不碰游戏目录；只有 `remove_game` 会顺带清掉该作品专属的缓存图，
//! `delete_game_dir` 才会把游戏目录移入回收站（先过 `check_deletable` 护栏）。

use crate::models::{AppError, EndMark, ErrCode, IgnoredGame};
use crate::store::Store;
use std::path::{Path, PathBuf};
use tauri::State;

/// 收藏落盘：`favorite` 属于游玩记录（唯一不可再生数据），改一次写一次盘。
/// 前端只在内存里翻标志，合并入库会由 merge_games 保留，但**只有写盘才能跨重启留存**。
#[tauri::command]
pub async fn set_favorite(store: State<'_, Store>, id: String, favorite: bool) -> Result<(), AppError> {
    let st = store.inner().clone();
    // 全库读 + 解析 + 写盘：库大时是几十毫秒级 IO，必须离开主线程
    tauri::async_runtime::spawn_blocking(move || set_favorite_sync(&st, &id, favorite))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

fn set_favorite_sync(store: &Store, id: &str, favorite: bool) -> Result<(), AppError> {
    let _lock = crate::store::lock_library();
    let mut games = store.load_library();
    let g = games
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中（可能已移除）"))?;
    if g.favorite == favorite {
        return Ok(());
    }
    g.favorite = favorite;
    store.save_library(&games)?;
    tracing::info!("favorite {id} -> {favorite}");
    Ok(())
}

/// 每游戏启动参数（P4 B10）：详情页编辑后立即落盘；空串与空白项在入口处清掉，
/// 免得 argv 里混进一个空参数把老引擎的解析搞崩。
#[tauri::command]
pub async fn set_launch_args(store: State<'_, Store>, id: String, args: Vec<String>) -> Result<(), AppError> {
    let cleaned: Vec<String> = args
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    // 参数会原样拼进启动命令行：没有上限时一次粘贴就能把长度撑爆，
    // 之后每次启动都失败。与备份导入的清洗口径保持一致（32 项 / 1024 字符）。
    let total: usize = cleaned.iter().map(|s| s.chars().count()).sum();
    if cleaned.len() > 32 || total > 1024 {
        return Err(AppError::new(
            ErrCode::ConfigInvalid,
            "启动参数最多 32 项、合计 1024 字符",
        ));
    }
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_launch_args_sync(&st, &id, cleaned))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

fn set_launch_args_sync(store: &Store, id: &str, cleaned: Vec<String>) -> Result<(), AppError> {
    let _lock = crate::store::lock_library();
    let mut games = store.load_library();
    let g = games
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中（可能已移除）"))?;
    if g.launch_args == cleaned {
        return Ok(());
    }
    g.launch_args = cleaned.clone();
    store.save_library(&games)?;
    tracing::info!("launch args {id} -> {cleaned:?}");
    Ok(())
}

/// 从库中移除一部作品：只改 library.json，不删游戏目录；顺带清掉它专属的缓存图
#[tauri::command]
pub async fn remove_game(store: State<'_, Store>, id: String) -> Result<(), AppError> {
    let st = store.inner().clone();
    // 可能连着多张缓存图一起删：与其它命令一致，别占 tokio worker
    tauri::async_runtime::spawn_blocking(move || remove_game_sync(&st, &id))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

fn remove_game_sync(store: &Store, id: &str) -> Result<(), AppError> {
    drop_game_record(store, id, true)
}

/// 删除一部作品的游戏目录（移入系统回收站），成功后移除库记录。
/// 删除是高危动作：先过 [`check_deletable`] 的护栏，再交给系统回收站；
/// 任何一步失败都直接报错，绝不退化成永久删除。
#[tauri::command]
pub async fn delete_game_dir(store: State<'_, Store>, id: String) -> Result<(), AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || delete_game_dir_sync(&st, &id))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

fn delete_game_dir_sync(store: &Store, id: &str) -> Result<(), AppError> {
    crate::check_id(id)?;
    if crate::launcher::is_running(id) {
        return Err(AppError::new(
            ErrCode::AlreadyRunning,
            "游戏正在运行，请先结束游戏再删除目录",
        ));
    }
    let (dir, others, roots) = {
        let games = store.load_library();
        let Some(g) = games.iter().find(|g| g.id == id) else {
            return Err(AppError::new(ErrCode::NotFound, "游戏不在库中"));
        };
        let others: Vec<String> = games
            .iter()
            .filter(|x| x.id != id)
            .map(|x| x.dir.clone())
            .collect();
        (g.dir.clone(), others, store.load_settings().library_roots)
    };
    let target = check_deletable(&dir, &others, &roots, &store.dir)?;
    move_to_recycle_bin(&target)?;
    tracing::info!("game dir moved to recycle bin: {}", target.display());
    // 目录已经没了：只清索引与缓存，不写忽略表（重扫也不可能再发现它）
    if let Err(e) = drop_game_record(store, id, false) {
        tracing::error!("目录已移入回收站，但库记录清理失败 {id}：{}", e.message);
    }
    Ok(())
}

/// 「删除游戏目录」的安全闸：任何一条不满足都拒绝，调用方不得删除任何文件。
///
/// 只接受库内记录的真实目录；账号目录 / 系统目录 / 应用数据目录 / 库根目录，
/// 以及「包含其它已入库作品」的上级目录一律拒绝——避免一次误触清空整个游戏库。
pub(crate) fn check_deletable(
    dir: &str,
    others: &[String],
    roots: &[String],
    app_data: &Path,
) -> Result<PathBuf, AppError> {
    let refuse = |msg: String| AppError::new(ErrCode::ConfigInvalid, msg);
    let raw = dir.trim();
    if raw.is_empty() {
        return Err(refuse("这条记录没有目录信息".into()));
    }
    if raw.starts_with(r"\\") {
        return Err(refuse("网络路径不支持直接删除，请手动处理".into()));
    }
    let canon = std::fs::canonicalize(raw)
        .map_err(|_| AppError::new(ErrCode::NotFound, "游戏目录不存在，可能已被手动删除"))?;
    if !canon.is_dir() {
        return Err(AppError::new(ErrCode::NotFound, "目标不是目录，已取消删除"));
    }
    // 盘符根不允许：那已经不是一个「游戏目录」
    if canon.parent().is_none() || canon.components().count() < 3 {
        return Err(refuse("不能删除盘符根目录".into()));
    }
    // 库里的路径是用户当年选的原始写法，这里统一按真实路径比较：
    // canonicalize 在 Windows 会带 `\\?\` 前缀、解析短文件名与符号链接，
    // 拿原始字符串和目标比较会漏判。不存在的路径退回原文（仍能拦同目录重复记录）。
    fn key_of(p: &str) -> String {
        std::fs::canonicalize(p)
            .map(|c| crate::store::normalize_dir(&c.to_string_lossy()))
            .unwrap_or_else(|_| crate::store::normalize_dir(p))
    }
    let key = crate::store::normalize_dir(&canon.to_string_lossy());

    // 系统目录 / 用户目录 / 应用数据目录：等于它们、或目标包含它们，都拒绝
    let mut protected: Vec<PathBuf> = vec![app_data.to_path_buf()];
    for var in [
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
    ] {
        if let Ok(p) = std::env::var(var) {
            protected.push(PathBuf::from(p));
        }
    }
    for p in protected {
        let Ok(pc) = std::fs::canonicalize(&p) else { continue };
        let pkey = crate::store::normalize_dir(&pc.to_string_lossy());
        if key == pkey || pkey.starts_with(&format!("{key}\\")) {
            return Err(refuse(format!("拒绝删除系统 / 应用目录：{}", canon.display())));
        }
    }

    // 库根目录：等于库根、或目标包含库根，都说明删下去会连累整库
    for r in roots {
        let rkey = key_of(r);
        if rkey.is_empty() {
            continue;
        }
        if rkey == key || rkey.starts_with(&format!("{key}\\")) {
            return Err(refuse(format!(
                "这个目录是游戏库根目录，不能删除：{}",
                canon.display()
            )));
        }
    }

    // 其它已入库作品：同目录（重复记录）或目标包含其它作品，都拒绝
    for o in others {
        let okey = key_of(o);
        if okey.is_empty() {
            continue;
        }
        if okey == key || okey.starts_with(&format!("{key}\\")) {
            return Err(refuse(format!(
                "该目录还包含其它已入库作品，不能整目录删除：{}",
                canon.display()
            )));
        }
    }
    Ok(canon)
}

/// `canonicalize` 产生的是 `\\?\` 前缀的扩展长度路径，而 SHFileOperationW 只接受普通写法。
#[cfg(windows)]
fn shell_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

/// 把目录移入 Windows 回收站（`FOF_ALLOWUNDO`）。
/// 失败时返回错误，由调用方保留现场；不会改用永久删除兜底。
/// 注意：`FOF_ALLOWUNDO` 在未启用回收站的卷（部分 U 盘 / 移动硬盘）上会被系统
/// 直接永久删除——这是回收站 API 的既有行为，前端确认框已写明这一点。
#[cfg(windows)]
fn move_to_recycle_bin(path: &Path) -> Result<(), AppError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    // `canonicalize` 在 Windows 返回 `\\?\C:\...` 形式，而 SHFileOperationW 不认这个前缀
    // （会当作非法路径返回 0x7C）。调用前换回普通写法；UNC 前缀单独还原。
    let plain = shell_path(path);

    // pFrom 必须是「双 NUL 结尾」的宽字符串路径
    let mut from: Vec<u16> = std::ffi::OsStr::new(&plain).encode_wide().collect();
    from.push(0);
    from.push(0);
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI) as u16;
    let rc = unsafe { SHFileOperationW(&mut op) };
    if op.fAnyOperationsAborted != 0 {
        return Err(AppError::new(ErrCode::IoError, "操作已取消，未删除任何文件"));
    }
    if rc != 0 {
        return Err(AppError::new(
            ErrCode::IoError,
            format!("移入回收站失败（代码 {rc}）：可手动删除该目录"),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn move_to_recycle_bin(_path: &Path) -> Result<(), AppError> {
    Err(AppError::new(
        ErrCode::ConfigInvalid,
        "当前平台不支持回收站删除",
    ))
}

/// 从库中移除一条记录，并清掉它专属的缓存图。
/// `remember_ignore = true` 时写忽略表（「从库中移除」）；删除目录时传 false，
/// 只清理可能残留的旧忽略项——目录已经不存在，再记住它没有意义。
fn drop_game_record(store: &Store, id: &str, remember_ignore: bool) -> Result<(), AppError> {
    crate::check_id(id)?;
    let (cover, thumb, still_used, ignored) = {
        let _lock = crate::store::lock_library();
        let mut games = store.load_library();
        let Some(pos) = games.iter().position(|g| g.id == id) else {
            return Err(AppError::new(ErrCode::NotFound, "游戏不在库中"));
        };
        let g = games.remove(pos);
        // 移除前留一份路径：库写完后要把它记进忽略表，否则重扫会原样再导入
        let ignored = IgnoredGame {
            dir: g.dir.clone(),
            exe: g.exe.clone(),
            title: g.title.clone(),
            at: crate::store::now_secs(),
        };
        store.save_library(&games)?;
        // 移除后仍被其它条目引用的封面 / 缩略图：同一张外部封面可能被两条记录共用，
        // 导入时也可能收编成同名缓存——这些文件不能跟着这条记录一起删。
        let still_used: std::collections::HashSet<String> = games
            .iter()
            .flat_map(|g| [g.cover.as_deref(), g.thumb.as_deref()])
            .flatten()
            .map(crate::store::normalize_dir)
            .collect();
        (g.cover, g.thumb, still_used, ignored)
    };
    for p in [cover, thumb].into_iter().flatten() {
        if still_used.contains(&crate::store::normalize_dir(&p)) {
            tracing::debug!("cache file still referenced by other games, keep: {p}");
            continue;
        }
        // 只删应用缓存目录**正下方**的文件：`starts_with` 是纯字面比较，
        // `covers\..\别处` 也能通过；这里消解 `..` 后再比对父目录。
        if let Some(pb) = cache_file(&store.covers_dir(), std::path::Path::new(&p))
            .or_else(|| cache_file(&store.thumbs_dir(), std::path::Path::new(&p)))
        {
            let _ = std::fs::remove_file(pb);
        }
    }
    // 详情页大图缓存不在 cover/thumb 字段里，单独清
    let _ = std::fs::remove_file(store.thumbs_dir().join(format!("{id}@lg.webp")));
    // 详情页背景图（`<id>_bg.*`）同样只以 id 命名、不进任何字段：不在这里带走，
    // 就得等用户手动跑一次「清理无用数据」
    crate::prune_prefixed(&store.covers_dir(), &format!("{id}_bg."), None);

    // 忽略表：移除出库要记住，重扫同一根目录不再把它列出来（解决「删了又回来」）；
    // 删除目录时目录已经没了，只清掉可能残留的旧项。
    {
        let _lock = crate::store::lock_ignored();
        let key = crate::store::normalize_dir(&ignored.exe);
        let mut ignored_list = store.load_ignored();
        let before = ignored_list.len();
        ignored_list.retain(|x| crate::store::normalize_dir(&x.exe) != key);
        if remember_ignore {
            ignored_list.push(ignored);
        }
        if remember_ignore || ignored_list.len() != before {
            if let Err(e) = store.save_ignored(&ignored_list) {
                tracing::warn!("写入忽略表失败（本次移除仍生效）：{e}");
            }
        }
    }

    tracing::info!("game removed from library: {id}");
    Ok(())
}

/// 忽略列表：被「移除出库」记住的作品（重扫不再列出）
#[tauri::command]
pub fn list_ignored(store: State<'_, Store>) -> Vec<IgnoredGame> {
    store.load_ignored()
}

/// 撤销一条忽略：下次扫描会重新列出，但仍需用户勾选确认才会入库
#[tauri::command]
pub async fn unignore_game(store: State<'_, Store>, exe: String) -> Result<(), AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = crate::store::lock_ignored();
        let key = crate::store::normalize_dir(&exe);
        let mut list = st.load_ignored();
        let before = list.len();
        list.retain(|x| crate::store::normalize_dir(&x.exe) != key);
        if list.len() == before {
            return Ok(());
        }
        st.save_ignored(&list)
            .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// 只允许缓存目录正下方的文件；返回消解 `..` 后的真实路径。
/// 文件已被删掉也能判断：比对的是父目录的 canonical 路径。
fn cache_file(
    root: &std::path::Path,
    p: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let name = p.file_name()?;
    let parent = p.parent()?;
    let root = std::fs::canonicalize(root).ok()?;
    let parent = std::fs::canonicalize(parent).ok()?;
    (parent == root).then(|| root.join(name))
}

/// 设置/清除用户标题覆盖（空串 = 恢复元数据原名）
#[tauri::command]
pub async fn set_game_title(store: State<'_, Store>, id: String, title: String) -> Result<(), AppError> {
    let t = title.trim().to_string();
    if t.chars().count() > 120 {
        return Err(AppError::new(ErrCode::ConfigInvalid, "标题最长 120 字"));
    }
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mutate_game(&st, &id, |g| {
            if t.is_empty() {
                g.title_override = None;
                // 只清覆盖不够：merge 会保留库内 title，这里同步回元数据原名
                if let Some(orig) = g.title_original.clone().filter(|s| !s.trim().is_empty()) {
                    g.title = orig;
                }
            } else {
                g.title_override = Some(t.clone());
                g.title = t.clone();
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// 更换启动程序：只接受游戏目录内的 exe，沿用入库时的安全校验
/// （网络路径 / 系统脚本宿主 / 目录外一律拒绝），避免把「换主程序」变成任意命令执行入口。
#[tauri::command]
pub async fn set_game_exe(
    store: State<'_, Store>,
    id: String,
    exe: String,
) -> Result<(), AppError> {
    let path = std::path::PathBuf::from(exe.trim());
    let is_exe = path
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("exe"))
        .unwrap_or(false);
    if !is_exe || !path.is_file() {
        return Err(AppError::new(
            ErrCode::NotFound,
            "找不到该 exe，或不是 .exe 文件",
        ));
    }
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mutate_game(&st, &id, |g| {
            crate::guard_game_exe(&path, std::path::Path::new(&g.dir))?;
            g.exe = path.to_string_lossy().to_string();
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// 转区覆盖：None = 按自动判定；Some(true) = 强制转区；Some(false) = 不转区。
/// 自动判定会误报（汉化版 / 重打包 / 引擎识别偏差），详情页可逐部纠正。
#[tauri::command]
pub async fn set_locale_override(
    store: State<'_, Store>,
    id: String,
    value: Option<bool>,
) -> Result<(), AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mutate_game(&st, &id, |g| {
            g.locale_override = value;
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// 隐藏 / 恢复（默认视图不显示，库管理里可找回）
#[tauri::command]
pub async fn set_hidden(store: State<'_, Store>, id: String, hidden: bool) -> Result<(), AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mutate_game(&st, &id, |g| {
            g.hidden = hidden;
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// H2 自定义标签：去空白、去重、限长限量
#[tauri::command]
pub async fn set_user_tags(store: State<'_, Store>, id: String, tags: Vec<String>) -> Result<(), AppError> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().to_string();
        if t.is_empty() || t.chars().count() > 20 {
            continue;
        }
        if !out.contains(&t) {
            out.push(t);
        }
        if out.len() >= 30 {
            break;
        }
    }
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mutate_game(&st, &id, |g| {
            g.user_tags = out.clone();
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// M6 备注（限 4000 字，避免 library.json 无限膨胀）
#[tauri::command]
pub async fn set_notes(store: State<'_, Store>, id: String, notes: String) -> Result<(), AppError> {
    let cleaned: String = notes.trim().chars().take(4000).collect();
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mutate_game(&st, &id, |g| {
            g.notes = cleaned.clone();
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// M6 评分 0–5 星
#[tauri::command]
pub async fn set_rating(store: State<'_, Store>, id: String, rating: u8) -> Result<(), AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mutate_game(&st, &id, |g| {
            g.rating = rating.min(5);
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// END / 路线清单：前端算好整份列表回写（增删改勾选都走这一条，避免索引漂移）。
/// 上限 50 条——手滑连续点「新增」也不会把 library.json 撑坏。
#[tauri::command]
pub async fn update_endings(store: State<'_, Store>, id: String, endings: Vec<EndMark>) -> Result<(), AppError> {
    if endings.len() > 50 {
        return Err(AppError::new(ErrCode::ConfigInvalid, "END 清单最多 50 条"));
    }
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || update_endings_sync(&st, &id, endings))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

fn update_endings_sync(store: &Store, id: &str, endings: Vec<EndMark>) -> Result<(), AppError> {
    let _lock = crate::store::lock_library();
    let mut games = store.load_library();
    let g = games
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中（可能已移除）"))?;
    let mut clean = Vec::with_capacity(endings.len());
    for (i, e) in endings.into_iter().enumerate() {
        let name = e.name.trim();
        clean.push(EndMark {
            name: if name.is_empty() { format!("END {}", i + 1) } else { name.to_string() },
            done: e.done,
        });
    }
    let count = clean.len();
    g.endings = clean;
    store.save_library(&games)?;
    tracing::info!("endings {id}: {count} 条");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Game;

    #[test]
    fn remove_game_cannot_escape_cache_directories() {
        let dir = std::env::temp_dir().join(format!("stash-remove-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store { dir };
        std::fs::create_dir_all(store.covers_dir()).unwrap();
        std::fs::create_dir_all(store.thumbs_dir()).unwrap();
        let victim = store.dir.join("victim.jpg");
        let inside = store.thumbs_dir().join("inside.webp");
        std::fs::write(&victim, b"keep").unwrap();
        std::fs::write(&inside, b"delete").unwrap();
        let id = "0123456789abcdef";
        store.save_library(&[Game {
            id: id.into(),
            cover: Some(store.covers_dir().join("..").join("victim.jpg").to_string_lossy().into_owned()),
            thumb: Some(inside.to_string_lossy().into_owned()),
            ..Default::default()
        }]).unwrap();

        remove_game_sync(&store, id).unwrap();
        assert!(victim.is_file(), "`..` 不能绕出缓存目录删除文件");
        assert!(!inside.exists(), "缓存目录内的自有文件仍应清理");
        assert!(store.load_library().is_empty());
        let _ = std::fs::remove_dir_all(&store.dir);
    }

    /// 删除目录护栏：正常作品目录放行；库根 / 含其它作品 / 应用数据 / 盘符根一律拒绝
    #[test]
    fn check_deletable_guards_dangerous_paths() {
        let base = std::env::temp_dir().join(format!("stash-del-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let app_data = base.join("appdata");
        let games = base.join("games");
        let air = games.join("AIR");
        let b = games.join("B");
        for p in [&app_data, &air, &b] {
            std::fs::create_dir_all(p).unwrap();
        }
        let s = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let roots = vec![s(&games)];
        let others = vec![s(&b)];

        // 正常作品目录：放行
        let ok = check_deletable(&s(&air), &others, &roots, &app_data).unwrap();
        assert_eq!(ok, std::fs::canonicalize(&air).unwrap());

        // 库根：删下去会连累整库
        assert!(check_deletable(&s(&games), &others, &roots, &app_data).is_err());
        // 包含其它已入库作品
        assert!(check_deletable(&s(&games), &[s(&air), s(&b)], &[], &app_data).is_err());
        // 应用数据目录（等于 / 包含都拒绝）
        assert!(check_deletable(&s(&app_data), &[], &[], &app_data).is_err());
        assert!(check_deletable(&s(&base), &[], &[], &app_data).is_err());
        // 网络路径不做直接删除
        assert!(check_deletable(r"\\server\share\game", &[], &[], &app_data).is_err());
        // 盘符根
        #[cfg(windows)]
        assert!(check_deletable(r"C:\", &[], &[], &app_data).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// SHFileOperationW 不认扩展长度前缀：调用前必须换回普通 / UNC 写法
    #[cfg(windows)]
    #[test]
    fn shell_path_strips_verbatim_prefix() {
        assert_eq!(shell_path(Path::new(r"\\?\C:\Games\AIR")), r"C:\Games\AIR");
        assert_eq!(shell_path(Path::new(r"\\?\UNC\srv\share\AIR")), r"\\srv\share\AIR");
        assert_eq!(shell_path(Path::new(r"D:\Games\AIR")), r"D:\Games\AIR");
    }
}

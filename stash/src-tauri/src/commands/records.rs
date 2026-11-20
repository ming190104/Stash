//! 库记录命令：收藏 / 启动参数 / 标题 / 隐藏 / 标签 / 备注 / 评分 / END / 移除。
//!
//! 这些都是 `library.json` 的读—改—写，统一走 `crate::mutate_game`（同一把库写锁），
//! 只改索引不碰游戏目录；只有 `remove_game` 会顺带清掉该作品专属的缓存图。

use crate::models::{AppError, EndMark, ErrCode, IgnoredGame};
use crate::store::Store;
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

    // 把这次移除记进忽略表：重扫同一根目录不再把它列出来，解决「删了又回来」的死循环。
    // 写忽略表失败不影响移除本身（库已经落盘），最多下次扫描多出一次候选。
    {
        let _lock = crate::store::lock_ignored();
        let key = crate::store::normalize_dir(&ignored.exe);
        let mut ignored_list = store.load_ignored();
        ignored_list.retain(|x| crate::store::normalize_dir(&x.exe) != key);
        ignored_list.push(ignored);
        if let Err(e) = store.save_ignored(&ignored_list) {
            tracing::warn!("写入忽略表失败（本次移除仍生效）：{e}");
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
}

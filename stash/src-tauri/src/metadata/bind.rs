//! 人工绑定 / 取消匹配命令，以及主源缺封面时的补图逻辑。

use crate::models::{AppError, ErrCode, Game, Settings};
use crate::store::{self, Store};
use crate::{egs, kungal, meta2, moegirl, net, scanner, thumb};
use tauri::{AppHandle, Emitter, State};

use super::apply::{
    apply_kungal_fields, apply_local_meta, apply_moegirl_fields, apply_subject_fields, ApplyFields,
};

/// 应用用户选中的候选：Bangumi 走条目绑定；萌娘百科写标题 / 简介 / 年份；EGS 只写评分与时长。
/// `fields` 只写入这些字段；不传 = 全部。见 `ApplyFields::from_list`。
#[tauri::command]
pub async fn apply_candidate(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    source: String,
    key: String,
    fields: Option<Vec<String>>,
) -> Result<(), AppError> {
    let st = store.inner().clone();
    let f = ApplyFields::from_list(fields.as_deref());
    tauri::async_runtime::spawn_blocking(move || match source.as_str() {
        "bangumi" => {
            let sid: u32 = key
                .parse()
                .map_err(|_| AppError::new(ErrCode::ConfigInvalid, "无效的 Bangumi 条目"))?;
            bind_subject_sync(&app, &st, &id, sid, f)
        }
        "moegirl" => bind_moegirl_sync(&st, &id, &key, f),
        "egs" => bind_egs_sync(&st, &id, &key, f),
        "kungal" => bind_kungal_sync(&st, &id, &key, f),
        _ => Err(AppError::new(ErrCode::ConfigInvalid, "未知的数据源")),
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

fn bind_moegirl_sync(store: &Store, id: &str, title: &str, f: ApplyFields) -> Result<(), AppError> {
    crate::check_id(id)?;
    if !store.load_library().iter().any(|g| g.id == id) {
        return Err(AppError::new(ErrCode::NotFound, "游戏不在库中"));
    }
    let s = store.load_settings();
    moegirl::reset_offline();
    let a = moegirl::lookup(&s, title)?
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "萌娘百科页面已不存在"))?;
    // 页面主图有就换官方封面；没有则保留原封面（字段级选择里没勾封面时不下载）
    let (cover, thumb) = match (f.cover, a.cover.as_deref()) {
        (true, Some(url)) => fetch_cover(store, id, Some(url)),
        _ => (None, None),
    };
    let _lock = store::lock_library();
    let mut games = store.load_library();
    {
        let g = games
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
        // 人工选择 = 用户明确确认：允许覆盖手改元数据
        g.meta_manual = false;
        apply_moegirl_fields(g, &a, 100, false, f);
        if let Some(p) = cover {
            g.cover = Some(p);
            g.thumb = thumb;
        }
    }
    store.save_library(&games)?;
    Ok(())
}

fn bind_egs_sync(store: &Store, id: &str, title: &str, f: ApplyFields) -> Result<(), AppError> {
    crate::check_id(id)?;
    let s = store.load_settings();
    egs::reset_offline();
    let stat = egs::lookup(&s, title)?
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "批评空间没有这条数据"))?;
    let _lock = store::lock_library();
    let mut games = store.load_library();
    {
        let g = games
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
        if f.score {
            if let Some(sc) = stat.score {
                g.meta_score = Some(sc);
                g.meta_score_source = Some("egs".to_string());
            }
            if let Some(v) = stat.votes {
                g.meta_score_count = Some(v);
            }
        }
        if f.length {
            if let Some(m) = stat.minutes {
                g.length_minutes = Some(m);
            }
        }
        // 用户确认了这条数据：待确认状态解除
        g.pending = false;
    }
    store.save_library(&games)?;
    Ok(())
}

fn bind_kungal_sync(store: &Store, id: &str, work_id: &str, f: ApplyFields) -> Result<(), AppError> {
    crate::check_id(id)?;
    if !store.load_library().iter().any(|g| g.id == id) {
        return Err(AppError::new(ErrCode::NotFound, "游戏不在库中"));
    }
    let s = store.load_settings();
    kungal::reset_offline();
    let w = kungal::lookup(&s, work_id).map_err(|e| {
        if e.code == ErrCode::NotFound {
            AppError::new(ErrCode::NotFound, "鲲 Galgame 条目已不存在")
        } else {
            e
        }
    })?;
    // 勾了封面才下载；没勾就保留原封面
    let (cover, thumb) = match (f.cover, w.cover.as_deref()) {
        (true, Some(url)) => fetch_cover(store, id, Some(url)),
        _ => (None, None),
    };
    let _lock = store::lock_library();
    let mut games = store.load_library();
    {
        let g = games
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
        // 人工选择 = 用户明确确认：允许覆盖手改元数据
        g.meta_manual = false;
        apply_kungal_fields(g, &w, 100, false, f);
        if let Some(p) = cover {
            g.cover = Some(p);
            g.thumb = thumb;
        }
    }
    store.save_library(&games)?;
    Ok(())
}

pub fn bind_subject_sync(
    app: &AppHandle,
    store: &Store,
    id: &str,
    subject_id: u32,
    f: ApplyFields,
) -> Result<(), AppError> {
    // id 会拼进 covers/<id>_src.*：先过白名单，否则 `..\..\x` 能把网上下载的图片
    // 写到应用数据目录之外；再确认条目存在，避免「下载并落盘之后才报 NotFound」
    crate::check_id(id)?;
    if !store.load_library().iter().any(|g| g.id == id) {
        return Err(AppError::new(ErrCode::NotFound, "游戏不在库中"));
    }
    let s = store.load_settings();
    let sub = net::subject(&s, subject_id)?;
    // 封面下载（网络 + 磁盘）放在锁外；没勾封面就跳过下载
    let (cover, thumb) = if f.cover {
        fetch_cover(store, id, sub.images_large.as_deref())
    } else {
        (None, None)
    };

    let _lock = store::lock_library();
    let mut games = store.load_library();
    {
        let g = games
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
        // 手动改绑同样是用户明确选择：允许覆盖手改元数据
        g.meta_manual = false;
        apply_subject_fields(g, &sub, 100, false, f);
        if let Some(p) = cover {
            g.cover = Some(p);
            g.thumb = thumb;
        }
    }
    store.save_library(&games)?;
    let _ = app.emit("match://done", serde_json::json!({ "id": id, "bound": subject_id }));
    Ok(())
}

/// 取消匹配：清掉 Bangumi 字段，回到本地 meta.json 的兜底信息（标题保留，不还原目录名）。
/// `async`：read_meta 要去游戏目录读文件（游戏常在移动盘 / 网络盘上，慢盘秒级），
/// 不能占主线程。
#[tauri::command]
pub async fn unmatch_game(store: State<'_, Store>, id: String) -> Result<(), AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || unmatch_game_sync(&st, &id))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn unmatch_game_sync(store: &Store, id: &str) -> Result<(), AppError> {
    // meta.json 在游戏目录：先在锁外读完（慢盘可达秒级），再进锁做纯内存改写 + 落盘——
    // 否则库锁一持好几秒，主线程的收藏 / 评分命令会跟着一起卡住
    let meta = {
        let games = store.load_library();
        let g = games
            .iter()
            .find(|g| g.id == id)
            .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
        scanner::read_meta(std::path::Path::new(&g.dir))
    };
    let _lock = store::lock_library();
    let mut games = store.load_library();
    let g = games
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
    apply_local_meta(g, meta);
    store.save_library(&games)?;
    Ok(())
}

/// 主源没给封面时，用 SteamGridDB 补一张（需设置里填 API Key；没有凭据直接原样返回）
pub fn cover_or_sgdb(
    s: &Settings,
    store: &Store,
    g: &Game,
    pair: (Option<String>, Option<String>),
) -> (Option<String>, Option<String>) {
    if pair.0.is_some() || s.network.sgdb_key.as_deref().map(str::trim).is_none() {
        return pair;
    }
    let kw = g
        .title_original
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(&g.title);
    match meta2::sgdb_cover(s, kw) {
        Ok(Some(url)) => fetch_cover(store, &g.id, Some(&url)),
        Ok(None) => pair,
        Err(e) => {
            tracing::debug!("SteamGridDB 跳过《{}》：{}", g.title, e.message);
            pair
        }
    }
}

/// EGS 补充查询：只有启用联网、且这部还没拿过 EGS 数据时才发请求。
/// 站点不可达时 egs 内部会置 OFFLINE，本轮剩余作品直接跳过（不逐个等超时）。
pub fn egs_for(s: &Settings, g: &Game, title: &str) -> Option<egs::EgsStat> {
    if !s.network.metadata_enabled {
        return None;
    }
    // EGS 每部要 2 次请求（搜索 + 作品页），是整轮匹配里最慢的一环；
    // 默认关闭，用户可在设置 · 网络里打开。候选面板的四源查询不受此开关影响。
    if !s.network.egs {
        return None;
    }
    if g.meta_score_source.as_deref() == Some("egs") && g.length_minutes.is_some() {
        return None;
    }
    let kw = if title.trim().is_empty() {
        g.title_original.as_deref().unwrap_or(&g.title)
    } else {
        title
    };
    match egs::lookup(s, kw) {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!("EGS 跳过《{}》：{}", g.title, e.message);
            None
        }
    }
}

/// 「智能选封面」写下的 `<id>_auto.*`：启发式产物，有官方封面时可以被替换
pub fn is_auto_cover(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.contains("_auto."))
        .unwrap_or(false)
}

/// 已绑同一作品且本地封面还在：直接复用，顺带确保缩略图有效。
/// 返回 `None` 表示需要重新下载（没封面 / 文件被删 / 只是启发式挑的封面）。
pub fn reuse_cover(store: &Store, g: &Game) -> Option<(Option<String>, Option<String>)> {
    let cover = g.cover.as_deref()?;
    if !std::path::Path::new(cover).is_file() {
        return None;
    }
    // `_auto.*` 是「智能选封面」的启发式产物（可能挑到目录里的标题图 / 占位图）：
    // 有官方封面可下时应当换掉，不要因为「能复用」就把它一直留着
    if is_auto_cover(cover) {
        return None;
    }
    let thumb = thumb::ensure(store, cover, &g.id, false)
        .map(|t| t.to_string_lossy().to_string())
        .or_else(|| g.thumb.clone());
    Some((Some(cover.to_string()), thumb))
}

/// 封面：下载原图 → 生成轨道档缩略图。失败只记日志，不影响入库。
pub fn fetch_cover(store: &Store, game_id: &str, url: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(url) = url else {
        return (None, None);
    };
    match net::download_cover(&store.load_settings(), store, game_id, url) {
        Ok(path) => {
            // 官方封面到手：「智能选封面」留下的 `_auto.*` 已经没有引用，顺手清掉
            crate::prune_prefixed(&store.covers_dir(), &format!("{game_id}_auto."), None);
            let thumb = thumb::ensure(store, &path, game_id, false)
                .map(|t| t.to_string_lossy().to_string());
            (Some(path), thumb)
        }
        Err(e) => {
            tracing::warn!("cover download failed {game_id}: {}", e.message);
            (None, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 开关关闭时 egs_for 必须在发请求前短路：整轮匹配每部省 2 次请求
    #[test]
    fn egs_for_respects_off_switch() {
        let mut s = Settings::default();
        s.network.metadata_enabled = true;
        s.network.egs = false;
        assert!(egs_for(&s, &Game::default(), "Kanon").is_none());
    }
}

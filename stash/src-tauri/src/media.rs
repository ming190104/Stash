//! 媒体命令：封面（手动 / 智能 / SteamGridDB）、详情页背景、截图与 ISO 挂载。
//!
//! 共同点：都要解码图片或等网络（几秒级），命令层一律 spawn_blocking；
//! 产物统一落在 covers/ 下并按 id 前缀做孤儿清理。
use crate::metadata::{fetch_cover, keywords};
use crate::models::{AppError, ErrCode, Game};
use crate::store::Store;
use crate::{bgimg, coverpick, iso, meta2, net, screen, thumb};
use tauri::{AppHandle, State};

/// 设置/清除用户封面（选择文件后复制进 covers/，避免源文件移动后失效）。
/// `async`：复制 + 生成两档缩略图（解码 + 缩放）是典型的重活，不能占主线程。
#[tauri::command]
pub async fn set_game_cover(store: State<'_, Store>, id: String, path: Option<String>) -> Result<(), AppError> {
    let st = store.inner().clone();
    // 仅声明 async 只是离开主线程，仍会占住 tokio worker（解码 4K 图可达数秒）：
    // 与 smart_cover / capture_screenshot 一致，整段放阻塞线程
    tauri::async_runtime::spawn_blocking(move || set_game_cover_sync(&st, &id, path))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn set_game_cover_sync(store: &Store, id: &str, path: Option<String>) -> Result<(), AppError> {
    crate::check_id(id)?;
    if let Some(src) = path.filter(|p| !p.trim().is_empty()) {
        let src = std::path::PathBuf::from(src);
        if !src.is_file() {
            return Err(AppError::new(ErrCode::NotFound, "封面文件不存在"));
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_else(|| "jpg".into());
        if !["jpg", "jpeg", "png", "webp", "bmp"].contains(&ext.as_str()) {
            return Err(AppError::new(ErrCode::ConfigInvalid, "仅支持 jpg / png / webp / bmp"));
        }
        let dst = store.covers_dir().join(format!("{id}_custom.{ext}"));
        std::fs::copy(&src, &dst)?;
        // Windows 的 fs::copy 会把源文件的修改时间一起复制过来。用户挑的若是很久以前的图，
        // 「源图比缩略图新」的判定就会失效、缩略图不重建——这里显式把时间戳刷成现在
        let _ = std::fs::File::options()
            .write(true)
            .open(&dst)
            .and_then(|f| f.set_modified(std::time::SystemTime::now()));
        crate::prune_custom_covers(&store.covers_dir(), id, Some(dst.as_path()));
        // 手动封面会顶掉之前的「智能选封面」产物，留着就是孤儿
        crate::prune_prefixed(&store.covers_dir(), &format!("{id}_auto."), None);
        let dst_s = dst.to_string_lossy().to_string();
        let thumb = thumb::ensure(store, &dst_s, id, false)
            .map(|t| t.to_string_lossy().to_string());
        crate::mutate_game(store, id, |g| {
            g.cover = Some(dst_s.clone());
            g.cover_override = Some(dst_s.clone());
            g.thumb = thumb.clone();
            Ok(())
        })
    } else {
        crate::mutate_game(store, id, |g| {
            g.cover = None;
            g.cover_override = None;
            g.thumb = None;
            Ok(())
        })?;
        crate::prune_custom_covers(&store.covers_dir(), id, None);
        crate::prune_prefixed(&store.covers_dir(), &format!("{id}_auto."), None);
        Ok(())
    }
}

/// 智能选封面的返回：新封面路径
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartCoverOut {
    cover: String,
}

/// 智能选封面：本地启发式在游戏目录里挑一张最像封面的图，裁掉信箱黑边后写进 covers/。
/// `async`：解码 4K 图 + 重编码 + 两档缩略图，属于典型重活，不能占主线程。
#[tauri::command]
pub async fn smart_cover(store: State<'_, Store>, id: String) -> Result<SmartCoverOut, AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || smart_cover_sync(&st, &id))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn smart_cover_sync(store: &Store, id: &str) -> Result<SmartCoverOut, AppError> {
    crate::check_id(id)?;
    let g = store
        .load_library()
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
    let dir = std::path::PathBuf::from(&g.dir);
    let src = coverpick::pick_cover(&dir)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏目录里没找到可用的封面图"))?;

    // 黑边裁切：能裁就存 PNG（保证无损且扩展名固定），裁不了就原样复制，
    // 避免把一张 8MB 的 JPEG 无意义地重编码成更大的 PNG。
    // 解码前先用文件头判像素数：游戏目录里可能躺着 20000×20000 的海报，
    // 直接 image::open 会把进程撑爆（与 thumb.rs 的 MAX_PIXELS 同一口径）
    let too_big = image::image_dimensions(&src)
        .map(|(w, h)| w as u64 * h as u64 > 80_000_000)
        .unwrap_or(false);
    let dst = match if too_big { None } else { image::open(&src).ok() } {
        Some(img) => match coverpick::crop_bounds(&img) {
            Some((x, y, w, h)) => {
                let out = store.covers_dir().join(format!("{id}_auto.png"));
                img.crop_imm(x, y, w, h)
                    .save_with_format(&out, image::ImageFormat::Png)
                    .map_err(|e| AppError::new(ErrCode::IoError, format!("写入封面失败：{e}")))?;
                Some(out)
            }
            None => None,
        },
        None => None,
    };
    let dst = match dst {
        Some(p) => p,
        None => {
            let ext = src
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_else(|| "jpg".into());
            let out = store.covers_dir().join(format!("{id}_auto.{ext}"));
            std::fs::copy(&src, &out)?;
            out
        }
    };
    let _ = std::fs::File::options()
        .write(true)
        .open(&dst)
        .and_then(|f| f.set_modified(std::time::SystemTime::now()));
    crate::prune_prefixed(&store.covers_dir(), &format!("{id}_auto."), Some(dst.as_path()));
    // 上一张是手动封面时也一并清掉：它已不被 cover_override 引用，留着就是孤儿
    crate::prune_custom_covers(&store.covers_dir(), id, Some(dst.as_path()));
    let dst_s = dst.to_string_lossy().to_string();
    let thumb = thumb::ensure(store, &dst_s, id, false)
        .map(|t| t.to_string_lossy().to_string());
    crate::mutate_game(store, id, |g| {
        g.cover = Some(dst_s.clone());
        g.cover_override = Some(dst_s.clone());
        g.thumb = thumb.clone();
        Ok(())
    })?;
    Ok(SmartCoverOut { cover: dst_s })
}

/// 手动从 SteamGridDB 取一张竖版封面（需设置里填 API Key）。
/// `async`：搜索 + 下载 + 缩略图都在网络 / 解码上，不能占主线程。
#[tauri::command]
pub async fn steamgrid_cover(store: State<'_, Store>, id: String) -> Result<String, AppError> {
    let st = store.inner().clone();
    // 搜索 + 下载原图（3–9s）+ 两档缩略图：整段是阻塞 IO / 解码，
    // 只标 async 会把它塞在 tokio worker 上，期间其它命令（收藏 / 设置）一起变慢
    tauri::async_runtime::spawn_blocking(move || steamgrid_cover_sync(&st, &id))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn steamgrid_cover_sync(store: &Store, id: &str) -> Result<String, AppError> {
    crate::check_id(id)?;
    let settings = store.load_settings();
    if settings
        .network
        .sgdb_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .is_none()
    {
        return Err(AppError::new(ErrCode::ConfigInvalid, "先在设置 · 网络里填 SteamGridDB API Key"));
    }
    let g = store
        .load_library()
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
    let kw = g
        .title_original
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or(&g.title)
        .to_string();
    let url = meta2::sgdb_cover(&settings, &kw)?
        .ok_or_else(|| AppError::new(ErrCode::NotFound, format!("SteamGridDB 没找到《{kw}》的封面")))?;
    let (cover, thumb) = fetch_cover(store, id, Some(&url));
    let cover = cover.ok_or_else(|| AppError::new(ErrCode::NetworkOffline, "封面下载失败"))?;
    crate::mutate_game(store, id, |g| {
        g.cover = Some(cover.clone());
        g.cover_override = Some(cover.clone());
        g.thumb = thumb.clone();
        Ok(())
    })?;
    Ok(cover)
}

/// 详情页背景图的缓存文件：covers/<id>_bg.<ext>
pub fn bg_file(store: &Store, id: &str) -> Option<String> {
    let prefix = format!("{id}_bg.");
    std::fs::read_dir(store.covers_dir())
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&prefix) && !n.ends_with(".tmp"))
                .unwrap_or(false)
        })
        .map(|p| p.to_string_lossy().to_string())
}

/// 详情页背景图：`fetch=false` 只查缓存（一次目录扫描）；`true` 还会去 SteamGridDB 取一张
/// 商店横幅并缓存下来。整屏背景用原作品的画面，比竖版封面裁切放大清楚得多。
#[tauri::command]
pub async fn detail_background(
    store: State<'_, Store>,
    id: String,
    fetch: bool,
) -> Result<Option<String>, AppError> {
    crate::check_id(&id)?;
    let st = store.inner().clone();
    if let Some(p) = bg_file(&st, &id) {
        return Ok(Some(p));
    }
    if !fetch {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || fetch_background(&st, &id))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// 背景候选：网络地址或本地文件
#[derive(Clone)]
pub enum BgSource {
    Url(String),
    File(std::path::PathBuf),
}

/// 一张源图在 16:9 画布上「真正贡献的像素数」——既比清晰度，也比比例合不合适。
/// SGDB 的 3.1:1 横幅按宽度铺满后只有一条 1920×620，而 1280×720 的原生截图
/// 能整块用上；只比「原图总像素」会误判成横幅更清楚。
pub fn eff_area(w: u32, h: u32) -> u64 {
    if w == 0 || h == 0 {
        return 0;
    }
    let ratio = w as f64 / h as f64;
    if ratio >= bgimg::WIDE_RATIO as f64 {
        let band = (bgimg::BG_W as f64 * h as f64 / w as f64).round() as u64;
        bgimg::BG_W as u64 * band
    } else if ratio > 16.0 / 9.0 {
        let cw = (h as f64 * 16.0 / 9.0).round() as u64;
        cw * h as u64
    } else {
        let ch = (w as f64 * 9.0 / 16.0).round() as u64;
        w as u64 * ch
    }
}

/// 挑一张背景图并规格化成 16:9 / 1920×1080。
/// 源按「16:9 画布上的有效像素」竞争：SteamGridDB hero 横幅 /
/// 作品目录里自带的实机图；任何一步失败都只是「没有背景图」，不该打断详情页。
/// （用户在候选墙里手选时走 `use_background_candidate`，不会回到这里）
pub fn fetch_background(store: &Store, id: &str) -> Result<Option<String>, AppError> {
    let covers = store.covers_dir();
    let dst = covers.join(format!("{id}_bg.jpg"));
    // ① 已有背景图：规格不是 1920×1080 就地重做一次（旧版本下的是 720p / 4:3）
    if let Some(p) = bg_file(store, id) {
        if bgimg::is_bg_spec(std::path::Path::new(&p)) {
            return Ok(Some(p));
        }
        if bgimg::write_from_file(std::path::Path::new(&p), &dst).is_ok() {
            crate::prune_prefixed(&covers, &format!("{id}_bg."), Some(dst.as_path()));
            tracing::info!("背景图：{} 已规格化为 1920×1080", id);
            return Ok(Some(dst.to_string_lossy().to_string()));
        }
        return Ok(Some(p)); // 重做失败：先给原图，别让详情页没背景
    }

    let settings = store.load_settings();
    let Some(g) = store.load_library().into_iter().find(|g| g.id == id) else {
        return Ok(None);
    };
    // ② 候选：都是「原作品的图」，按有效面积取最大的一张（同分时优先目录实机图，
    //    那是游戏里的真实画面，横幅艺术图常带 logo 字）
    let mut cands: Vec<(u64, u8, BgSource)> = Vec::new();
    if let Some((url, [w, h])) = sgdb_hero_cand(&settings, &g) {
        cands.push((eff_area(w, h), 1, BgSource::Url(url)));
    }
    if let Some((p, area)) = local_shot_cand(&g, false) {
        cands.push((area, 0, BgSource::File(p)));
    }
    let pick = cands
        .into_iter()
        .max_by_key(|(area, rank, _)| (*area, *rank))
        // 目录里只有 `capture-*` 整屏图（桌面 + 窗口）时才拿它兜底
        .or_else(|| local_shot_cand(&g, true).map(|(p, a)| (a, 0, BgSource::File(p))));
    let Some((_, _, src)) = pick else { return Ok(None) };

    let written = match &src {
        BgSource::Url(url) => match net::fetch_image(&settings, url, "背景图") {
            Ok((bytes, _)) => bgimg::write_from_bytes(&bytes, &dst),
            Err(e) => {
                tracing::debug!("背景图下载失败《{}》：{}", g.title, e.message);
                return Ok(None);
            }
        },
        BgSource::File(p) => bgimg::write_from_file(p, &dst),
    };
    match written {
        Ok(()) => {
            crate::prune_prefixed(&covers, &format!("{id}_bg."), Some(dst.as_path()));
            Ok(Some(dst.to_string_lossy().to_string()))
        }
        Err(e) => {
            tracing::debug!("背景图规格化失败《{}》：{e}", g.title);
            Ok(None)
        }
    }
}

/// SteamGridDB hero 横幅（商店宣传图，3840×1240 起）；无 key / 无结果返回 None
pub fn sgdb_hero_cand(settings: &crate::models::Settings, g: &Game) -> Option<(String, [u32; 2])> {
    if !settings.network.metadata_enabled {
        return None;
    }
    // 每个候选要花 2 次请求（autocomplete + heroes），共用 1 req/s 的串行阀门：
    // keywords() 能给出 6–8 个变体，全试一遍最坏 16 秒才出背景。只试前 4 个——
    // 原名 / 标题 / PE 产品名 / 去装饰变体已覆盖绝大多数命中。
    for kw in keywords(g).into_iter().take(4) {
        match meta2::sgdb_hero(settings, &kw) {
            Ok(Some(v)) => return Some(v),
            Ok(None) => {}
            Err(e) => {
                tracing::debug!("背景图跳过 SteamGridDB《{}》：{}", g.title, e.message);
                return None;
            }
        }
    }
    None
}

/// 作品目录里自带的实机图（`capture-*` 是本应用截的整屏图，默认不参与竞争）
pub fn local_shot_cand(g: &Game, include_capture: bool) -> Option<(std::path::PathBuf, u64)> {
    let is_capture = |p: &String| {
        std::path::Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("capture-"))
            .unwrap_or(false)
    };
    g.shots
        .iter()
        .filter(|p| include_capture || !is_capture(p))
        .filter_map(|p| {
            let (w, h) = image::image_dimensions(p).ok()?;
            Some((std::path::PathBuf::from(p), eff_area(w, h)))
        })
        .max_by_key(|(_, a)| *a)
}

/// 手动指定背景图：同样走「居中裁 16:9 → 1920×1080」这套规格化，
/// 存成 covers/<id>_bg.jpg，和自动背景完全一致（不再原样复制原图）
#[tauri::command]
pub async fn set_game_background(
    store: State<'_, Store>,
    id: String,
    src: String,
) -> Result<String, AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, AppError> {
        crate::check_id(&id)?;
        let src_path = std::path::Path::new(&src);
        let supported = src_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp" | "bmp"))
            .is_some();
        if !supported {
            return Err(AppError::new(
                ErrCode::ConfigInvalid,
                "只支持 JPG / PNG / WebP / BMP",
            ));
        }
        let dir = st.covers_dir();
        std::fs::create_dir_all(&dir)?;
        let dst = dir.join(format!("{id}_bg.jpg"));
        bgimg::write_from_file(src_path, &dst).map_err(|e| {
            AppError::new(
                ErrCode::ConfigInvalid,
                format!("背景图处理失败：{e}"),
            )
        })?;
        crate::prune_prefixed(&dir, &format!("{id}_bg."), Some(dst.as_path()));
        Ok(dst.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// 删掉背景图，详情页回到「实机截图 → 封面」的自动选择
#[tauri::command]
pub fn clear_game_background(store: State<'_, Store>, id: String) -> Result<(), AppError> {
    crate::check_id(&id)?;
    crate::prune_prefixed(&store.covers_dir(), &format!("{id}_bg."), None);
    Ok(())
}

/* ============ 背景候选（可视化选择器） ============ */

/// 一张候选卡片：前端在上方显示 16:9 缩略图、下方显示 `label` 与来源 / 尺寸。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgCandidate {
    /// 应用时回传给 `use_background_candidate` 的键；不含路径 / URL，前端无法借命令读写别的文件
    pub key: String,
    pub label: String,
    /// current / local / sgdb
    pub source: String,
    pub width: u32,
    pub height: u32,
    /// 本地缩略图路径（前端走 asset: 协议）；生成失败时为 None，卡片仍可点选
    pub thumb: Option<String>,
    pub current: bool,
}

type BgPickRegistry = Vec<(String, Vec<(String, BgSource)>)>;

/// 最近一次候选列表的来源表：`use_background_candidate` 只认这里登记过的 key。
/// 只留最近几部，进过详情即可攒下几十个候选，没必要一直占着。
static BG_PICKS: std::sync::Mutex<BgPickRegistry> = std::sync::Mutex::new(Vec::new());
/// 来源表最多保留几部作品
const BG_PICK_GAMES: usize = 8;

/// 背景候选：当前背景 + 目录实机图 + SteamGridDB 横幅，按来源分组。
/// 全部规格化成 16:9 缩略图返回，前端只负责排版与点击，不再关心远端地址。
///
/// `online=false` 只返回本地候选（当前背景 / 目录截图），用于面板首屏立即出卡片；
/// 前端随后再调一次 `online=true` 补齐在线候选——SGDB 搜索走 1 req/s 闸门，
/// 合在一起会让面板空白好几秒。
#[tauri::command]
pub async fn background_candidates(
    store: State<'_, Store>,
    id: String,
    online: bool,
) -> Result<Vec<BgCandidate>, AppError> {
    crate::check_id(&id)?;
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || background_candidates_sync(&st, &id, online))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn background_candidates_sync(
    store: &Store,
    id: &str,
    online: bool,
) -> Result<Vec<BgCandidate>, AppError> {
    let settings = store.load_settings();
    let Some(g) = store.load_library().into_iter().find(|g| g.id == id) else {
        return Err(AppError::new(ErrCode::NotFound, "游戏不在库中"));
    };
    let mut items: Vec<(BgCandidate, BgSource)> = Vec::new();

    // ① 当前背景：明确标出来，点它等于「保持现状」（也方便用户确认自己正在用哪张）
    if let Some(p) = bg_file(store, id) {
        let (w, h) = image::image_dimensions(&p).unwrap_or((0, 0));
        items.push((
            BgCandidate {
                key: "current".into(),
                label: "当前背景".into(),
                source: "current".into(),
                width: w,
                height: h,
                thumb: None,
                current: true,
            },
            BgSource::File(std::path::PathBuf::from(p)),
        ));
    }

    // ② 作品目录里的实机图：真正「这部作品」的画面，按 16:9 有效面积降序取前 6 张
    let mut locals: Vec<(std::path::PathBuf, u64, u32, u32)> = g
        .shots
        .iter()
        .filter_map(|p| {
            let (w, h) = image::image_dimensions(p).ok()?;
            Some((std::path::PathBuf::from(p), eff_area(w, h), w, h))
        })
        .collect();
    locals.sort_by_key(|(_, area, _, _)| std::cmp::Reverse(*area));
    for (i, (p, _, w, h)) in locals.into_iter().take(6).enumerate() {
        items.push((
            BgCandidate {
                key: format!("local-{i}"),
                label: format!("目录截图 {}", i + 1),
                source: "local".into(),
                width: w,
                height: h,
                thumb: None,
                current: false,
            },
            BgSource::File(p),
        ));
    }

    // ③ SGDB 商店横幅：首屏（online=false）与未开在线元数据时整段跳过
    if online && settings.network.metadata_enabled {
        if let Some((url, [w, h])) = sgdb_hero_cand(&settings, &g) {
            items.push((
                BgCandidate {
                    key: "sgdb".into(),
                    label: "商店横幅".into(),
                    source: "sgdb".into(),
                    width: w,
                    height: h,
                    thumb: None,
                    current: false,
                },
                BgSource::Url(url),
            ));
        }
    }

    // 缩略图：本地图直接解码；网图走 CDN（绕开 API 的 1 req/s 闸门）最多 4 张并发。
    // 单张失败只让那张卡片没有预览，不影响候选本身可点选。
    let settings_ref = &settings;
    for chunk in items.chunks_mut(4) {
        std::thread::scope(|scope| {
            for (cand, src) in chunk.iter_mut() {
                scope.spawn(move || {
                    cand.thumb = match src {
                        BgSource::File(p) => thumb::bg_thumb_file(
                            store,
                            id,
                            &p.to_string_lossy(),
                        )
                        .map(|t| t.to_string_lossy().to_string()),
                        BgSource::Url(u) => {
                            if let Some(t) = thumb::bg_thumb_cached(store, id, u) {
                                Some(t.to_string_lossy().to_string())
                            } else {
                                match net::fetch_image_direct(settings_ref, u, "背景候选") {
                                    Ok((bytes, _)) => thumb::bg_thumb_bytes(store, id, u, &bytes)
                                        .map(|t| t.to_string_lossy().to_string()),
                                    Err(e) => {
                                        tracing::debug!("背景候选图跳过《{}》：{}", cand.label, e.message);
                                        None
                                    }
                                }
                            }
                        }
                    };
                });
            }
        });
    }
    thumb::prune_bg(store);

    let picks: Vec<(String, BgSource)> = items
        .iter()
        .map(|(c, s)| (c.key.clone(), s.clone()))
        .collect();
    {
        let mut reg = BG_PICKS.lock().unwrap_or_else(|e| e.into_inner());
        reg.retain(|(k, _)| k != id);
        reg.push((id.to_string(), picks));
        if reg.len() > BG_PICK_GAMES {
            let drop = reg.len() - BG_PICK_GAMES;
            reg.drain(0..drop);
        }
    }
    Ok(items.into_iter().map(|(c, _)| c).collect())
}

/// 应用某张候选：复用「规格化 16:9 / 1920×1080 → covers/<id>_bg.jpg」这套流程，
/// 与自动背景、手动指定图片完全一致（同名覆盖后前端会 touchAsset 换 URL）。
#[tauri::command]
pub async fn use_background_candidate(
    store: State<'_, Store>,
    id: String,
    key: String,
) -> Result<String, AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || use_background_candidate_sync(&st, &id, &key))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn use_background_candidate_sync(
    store: &Store,
    id: &str,
    key: &str,
) -> Result<String, AppError> {
    crate::check_id(id)?;
    if key == "current" {
        if let Some(p) = bg_file(store, id) {
            return Ok(p);
        }
    }
    let src = {
        let reg = BG_PICKS.lock().unwrap_or_else(|e| e.into_inner());
        reg.iter()
            .find(|(k, _)| k == id)
            .and_then(|(_, v)| v.iter().find(|(k, _)| k == key))
            .map(|(_, s)| s.clone())
    };
    // 只认刚才 candidate 列表登记过的键：不把前端传来的任意路径 / 地址当图源
    let src = src.ok_or_else(|| AppError::new(ErrCode::NotFound, "背景候选已过期，请重新打开选择器"))?;
    let dir = store.covers_dir();
    std::fs::create_dir_all(&dir)?;
    let dst = dir.join(format!("{id}_bg.jpg"));
    match src {
        BgSource::Url(url) => {
            let settings = store.load_settings();
            let (bytes, _) = net::fetch_image(&settings, &url, "背景图")?;
            bgimg::write_from_bytes(&bytes, &dst)
        }
        BgSource::File(p) => bgimg::write_from_file(&p, &dst),
    }
    .map_err(|e| AppError::new(ErrCode::ConfigInvalid, format!("背景图处理失败：{e}")))?;
    crate::prune_prefixed(&dir, &format!("{id}_bg."), Some(dst.as_path()));
    Ok(dst.to_string_lossy().to_string())
}

/* ============ M8 截图 ============ */

/// 抓主屏到 `<游戏目录>/shots/`，并登记进库。
/// `async`：抓屏 + 写 PNG + 重扫截图目录都可能耗时，不能占主线程。
#[tauri::command]
pub async fn capture_screenshot(app: AppHandle, store: State<'_, Store>, id: String) -> Result<String, AppError> {
    let st = store.inner().clone();
    // PowerShell 截屏 1~3 秒 + 写 PNG：不能占着 tokio worker
    tauri::async_runtime::spawn_blocking(move || capture_screenshot_sync(&app, &st, &id))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// 抓图并登记（命令层与手柄「截图」键共用：后者在主窗口被游戏盖住时直接调用）。
pub(crate) fn capture_screenshot_sync(
    app: &AppHandle,
    store: &Store,
    id: &str,
) -> Result<String, AppError> {
    crate::check_id(id)?;
    let g = store
        .load_library()
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
    let out = screen::capture(app, &g.dir)?;
    let s = out.to_string_lossy().to_string();
    // shots 目录可能是刚建出来的：asset 白名单是空的，新目录必须现登记
    if let Some(dir) = out.parent() {
        crate::allow_asset(app, &dir.to_string_lossy(), true);
    }
    crate::mutate_game(store, id, |g| {
        if !g.shots.contains(&s) {
            g.shots.push(s.clone());
        }
        // 详情页只有 3 个截图位且取前 3 张：不裁剪的话，新截图排第 4 位永远不可见
        // （scanner::find_shots 也是同样的「最近 3 张」口径）
        keep_recent_shots(&mut g.shots);
        Ok(())
    })?;
    Ok(s)
}

/// 截图条只留最近 3 张，与 scanner::find_shots 保持一致。
pub fn keep_recent_shots(shots: &mut Vec<String>) {
    if shots.len() > 3 {
        let extra = shots.len() - 3;
        shots.drain(0..extra);
    }
}

/// 可删除的截图范围：作品目录下的 `shots / screenshots / screenshot` 直接子文件。
/// 用 canonicalize 比对父目录，`..` 与符号链接都绕不出去（删除是不可逆操作，边界必须硬）。
/// 不要求文件仍然存在：手动删过文件后，库里那条失效记录也要能通过同一入口清掉。
pub fn shot_is_deletable(game_dir: &str, path: &std::path::Path) -> bool {
    let Some(parent) = path.parent().and_then(|d| d.canonicalize().ok()) else {
        return false;
    };
    ["shots", "screenshots", "screenshot"].iter().any(|sub| {
        std::path::Path::new(game_dir)
            .join(sub)
            .canonicalize()
            .map(|d| d == parent)
            .unwrap_or(false)
    })
}

/// 删除一张截图：文件删掉、路径从库里摘掉，返回剩余列表给详情页刷新。
/// 文件已被手动删过（NotFound）不算失败：顺手把失效记录清掉正是这里要解决的事。
/// `async`：canonicalize 与删除都落在游戏目录（移动盘 / 网络盘上可能秒级阻塞），
/// 不能占主线程。
#[tauri::command]
pub async fn delete_shot(
    store: State<'_, Store>,
    id: String,
    path: String,
) -> Result<Vec<String>, AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || delete_shot_sync(&st, &id, &path))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn delete_shot_sync(store: &Store, id: &str, path: &str) -> Result<Vec<String>, AppError> {
    crate::check_id(id)?;
    let games = store.load_library();
    let g = games
        .iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
    if !shot_is_deletable(&g.dir, std::path::Path::new(path)) {
        return Err(AppError::new(
            ErrCode::ConfigInvalid,
            "只能删除作品 shots 目录下的截图",
        ));
    }
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(AppError::new(ErrCode::IoError, format!("删除截图失败：{e}"))),
    }
    crate::mutate_game(store, id, |g| {
        g.shots.retain(|s| s != path);
        Ok(())
    })?;
    Ok(store
        .load_library()
        .into_iter()
        .find(|g| g.id == id)
        .map(|g| g.shots)
        .unwrap_or_default())
}

/// 挂载 ISO / 虚拟光驱（P4 B11）：返回盘符给详情页展示。
/// `async`：要启动 PowerShell 并等它挂载完（1~3 秒），同步命令会卡在主线程让界面假死。
#[tauri::command]
pub async fn mount_iso(path: String) -> Result<String, AppError> {
    // 挂载要等 PowerShell 走完（最长 30 秒）：async 只是离开了主线程，
    // 仍会占住一个 tokio worker，必须整段放到阻塞线程池
    tauri::async_runtime::spawn_blocking(move || iso::mount(&path))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// `async`：同样要等 PowerShell 卸载完成，别占主线程。
#[tauri::command]
pub async fn unmount_iso(path: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || iso::unmount(&path))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef";

    fn temp_store(tag: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("stash-bg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("thumbs")).unwrap();
        std::fs::create_dir_all(dir.join("covers")).unwrap();
        Store { dir }
    }

    fn write_shot(store: &Store, name: &str, w: u32, h: u32) -> String {
        let p = store.dir.join(name);
        let mut img = image::RgbImage::new(w, h);
        for px in img.pixels_mut() {
            *px = image::Rgb([60, 90, 150]);
        }
        img.save(&p).unwrap();
        p.to_string_lossy().to_string()
    }

    fn save_game(store: &Store, shots: Vec<String>) {
        let g = Game {
            id: ID.into(),
            title: "测试作品".into(),
            dir: store.dir.to_string_lossy().to_string(),
            shots,
            ..Default::default()
        };
        store.save_library(&[g]).unwrap();
    }

    /// 候选列表 = 本地截图（按有效面积降序）+ 16:9 缩略图；选中后落成 1080p 背景，
    /// 再次打开时多出一张「当前背景」卡片
    #[test]
    fn candidates_list_local_shots_and_apply_writes_bg() {
        let store = temp_store("cand");
        let small = write_shot(&store, "a-1280.png", 1280, 720);
        let large = write_shot(&store, "b-1920.png", 1920, 1080);
        save_game(&store, vec![small, large]);

        let list = background_candidates_sync(&store, ID, false).unwrap();
        assert_eq!(list.len(), 2, "在线元数据默认关闭：只应返回本地截图");
        assert_eq!(list[0].width, 1920, "大图排在前面");
        assert_eq!(list[0].source, "local");
        assert!(list[0].thumb.as_ref().is_some_and(|t| std::path::Path::new(t).is_file()));
        assert!(!list[0].current);

        let out = use_background_candidate_sync(&store, ID, &list[1].key).unwrap();
        assert!(std::path::Path::new(&out).is_file());
        assert_eq!(
            image::image_dimensions(&out).unwrap(),
            (bgimg::BG_W, bgimg::BG_H),
            "应用候选后必须规格化成 1920×1080"
        );

        let again = background_candidates_sync(&store, ID, false).unwrap();
        assert!(again.iter().any(|c| c.current), "已有背景时要出现「当前背景」卡片");
        // 「当前背景」直接返回现有文件，不重新编码
        assert_eq!(use_background_candidate_sync(&store, ID, "current").unwrap(), out);
        // 未登记的 key 一律拒绝：不能把前端传来的任意值当图源
        assert!(use_background_candidate_sync(&store, ID, "local-9").is_err());
    }

    /// 没有截图也没有缓存时返回空列表（面板显示空态，而不是报错）
    #[test]
    fn candidates_empty_without_local_or_network() {
        let store = temp_store("empty");
        save_game(&store, vec![]);
        assert!(background_candidates_sync(&store, ID, false).unwrap().is_empty());
    }
}


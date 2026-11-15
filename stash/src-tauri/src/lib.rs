//! 模块注册与 IPC 入口（总案 11.2）。
//!
//! 命令实现按主题放在 `commands/` 下，本文件只保留：
//! builder 与 setup 装配、generate_handler 列表、跨模块共用的路径 / 白名单助手、单元测试。
//!
//! P0 命令集（纯离线）：
//! - get_library / add_game（库只能靠手动添加入库，无目录扫描）
//! - launch_game / stop_game / open_dir
//! - get_settings / update_settings
//!
//! 事件：thumbs://done、game://started、game://exited、nav://intent
//! （match_* 系列按 2026-10-20 决策挪 P1，见 README）

pub mod bgimg;
pub mod commands;
pub mod coverpick;
pub mod egs;
pub mod engine;
pub mod input;
pub mod iso;
pub mod kungal;
pub mod launcher;
pub mod log;
pub mod maintenance;
pub mod media;
pub mod meta2;
pub mod metadata;
pub mod models;
pub mod moegirl;
pub mod net;
pub mod pe;
pub mod power;
pub mod scanner;
pub mod screen;
pub mod single;
pub mod steam;
pub mod store;
pub mod tagzh;
pub mod thumb;
pub mod win;
pub mod winkey;

use commands::{fs, game, library, records, settings as settings_cmd, update};
use models::{AppError, ErrCode, Game, PadMap};
use store::Store;
use tauri::{AppHandle, Manager};

/// 进程起点：启动耗时埋点。单实例锁之后才记，避免把抢锁等待算进启动时间。
static BOOT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// 距进程起点多少毫秒（未初始化时按 0）
pub(crate) fn boot_ms() -> f64 {
    BOOT.get()
        .map(|t| t.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// 标识符改名（com.vnshelf.desktop → com.stash.desktop）时，把 WebView2 的用户数据目录
/// 一起搬过去：主题、布局、弱者提示等 localStorage 偏好不因改名丢失。
/// 新目录已存在说明已经迁移过（或用户从没跑过旧版），直接跳过。
fn migrate_webview_dir() {
    let Some(base) = dirs::data_local_dir() else {
        return;
    };
    let old = base.join("com.vnshelf.desktop");
    let new = base.join("com.stash.desktop");
    if new.exists() || !old.exists() {
        return;
    }
    if let Err(e) = std::fs::rename(&old, &new) {
        // 迁移失败只是偏好设置回到默认值，不影响库数据，记一条日志即可
        tracing::warn!("界面缓存目录迁移失败（{e}）：{}", old.display());
    }
}

/// 大屏 PC 适配：1280×720 是按 7 寸 1080p（150% 缩放 = 1280×720 逻辑）定的设计基准，
/// 直接放到桌面显示器上只是屏幕中间一小块。启动时按主显示器逻辑尺寸放大到 16:9，
/// 上限 1920×1080；窗口仍可自由缩放 / 全屏，界面本身由前端 `stageScale` 等比跟随。
fn fit_window_for_display(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let Ok(Some(m)) = w.current_monitor() else {
        return;
    };
    let sf = m.scale_factor();
    if sf <= 0.0 {
        return;
    }
    let lw = m.size().width as f64 / sf;
    let lh = m.size().height as f64 / sf;
    // 掌机 / 1080p@150% / 小笔记本：保持 1280×720 不动
    if lw < 1600.0 || lh < 900.0 {
        return;
    }
    let target_w = (lw * 0.85).min(1920.0);
    // 高度同时受任务栏约束（按可用高度 86% 估），避免窗口底边压到任务栏下
    let target_h = (target_w * 9.0 / 16.0).min(lh * 0.86);
    let _ = w.set_size(tauri::LogicalSize::new(target_w.round(), target_h.round()));
    let _ = w.center();
    tracing::info!(
        "窗口：主显示器 {lw:.0}×{lh:.0}（{sf:.2}x）→ {}×{}",
        target_w.round(),
        target_h.round()
    );
}

pub fn run() {
    // 单实例：第二个进程只负责把已运行的主窗口提到前台，然后直接退出
    if !single::acquire_or_activate() {
        return;
    }
    BOOT.get_or_init(std::time::Instant::now);
    // 改名迁移：必须早于 log::init（日志目录在新目录下，先初始化会把新目录建出来，
    // 整体重命名就不会再发生）
    let moved = store::migrate_legacy_dir();
    log::init();
    if let Some((from, to)) = moved {
        tracing::info!("数据目录已迁移：{} → {}", from.display(), to.display());
    }
    // 标识符改名：WebView2 的界面缓存 / localStorage 跟着换目录，主题与布局偏好不丢
    migrate_webview_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            single::bind(app.handle());
            let store = Store::open();
            let settings = store.load_settings();
            tracing::info!("启动：设置就绪 {:.0} ms", boot_ms());
            // P35：任务栏自动隐藏的崩溃兜底（与 power 同口径）：上次没还原的先还原，
            // 再按设置决定是否随全屏重新切上
            let settings_path = store.settings_path();
            win::set_marker_dir(settings_path.parent().unwrap_or(settings_path.as_path()));
            win::restore_pending();
            // 掌机防误触：守卫要主窗口句柄，无论启动时是否全屏都先记下来
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(hwnd) = w.hwnd() {
                    winkey::set_window(hwnd.0 as isize);
                }
            }
            // P3：开机直进——用户开了全屏就首帧即铺满，避免先闪一下 720p 窗口
            if settings.fullscreen {
                if let Some(w) = app.get_webview_window("main") {
                    // 最大化窗口进全屏会被钉在工作区：先解除最大化
                    let _ = w.unmaximize();
                    let _ = w.set_fullscreen(true);
                    // 掌机防误触：全屏时吞掉 Win 键，避免开始菜单压到游戏库上
                    winkey::set_enabled(true);
                    // P35：全屏时任务栏临时切自动隐藏（真正铺满整屏），失败只留日志
                    // 贴边只用延迟任务：tao 的 set_fullscreen 排队执行时会记录进全屏前
                    // 的窗口矩形，同步贴边会让它把整屏尺寸记成"原尺寸"
                    #[cfg(windows)]
                    if let Ok(hwnd) = w.hwnd() {
                        let h = hwnd.0 as isize;
                        win::fullscreen_taskbar(h, true);
                        win::fit_fullscreen_later(h);
                    }
                }
            } else {
                // 大屏 PC：默认窗口按显示器放大（掌机保持 1280×720）
                fit_window_for_display(app.handle());
            }
            // 省电模式：先把上次（崩溃 / 强杀）没还原的刷新率还原回原模式，
            // 再按设置决定是否重新锁 60Hz，避免屏幕一直停在 60Hz
            power::set_marker_dir(settings_path.parent().unwrap_or(settings_path.as_path()));
            power::restore_pending();
            // P3：省电模式在首帧前切好，避免进桌面后再黑一下
            if settings.power60 {
                if let Err(e) = power::apply(true) {
                    tracing::warn!("power60 启动失败：{}", e.message);
                }
            }
            // 手柄键位：必须在手柄线程起来前写好，否则第一下按键还是旧映射。
            // 老配置没有 padMap 时按 ab_swap 开关生成；新配置直接用键位表。
            let mut pad_map = settings.pad_map.clone();
            if pad_map == PadMap::default() && settings.ab_swap {
                pad_map.accept = "east".into();
                pad_map.back = "south".into();
            }
            input::set_map(pad_map);
            input::set_tuning(settings.pad_tuning);
            app.manage(store);
            // asset 白名单：缓存目录整目录放行（封面/缩略图会持续新增），
            // 游戏目录只在封面与 shots 上单独登记
            {
                let st = app.state::<Store>();
                allow_asset(app.handle(), &st.covers_dir().to_string_lossy(), true);
                allow_asset(app.handle(), &st.thumbs_dir().to_string_lossy(), true);
                allow_library_assets(app.handle(), &st.load_library());
            }
            // 转区工具：安装目录自带 Locale Emulator 时自动指向它（当前路径可用则不动）
            launcher::ensure_bundled_tool(app.handle(), app.state::<Store>().inner());
            // 标签中文化：老数据只写库时翻译不到，这里补一遍（幂等）
            localize_library_tags(app.state::<Store>().inner());
            // 背景图规格化：老版本下的是 720p / 4:3，后台统一成 1920×1080
            {
                let st = app.state::<Store>().inner().clone();
                tauri::async_runtime::spawn_blocking(move || normalize_existing_bg(&st));
            }

            input::spawn(app.handle().clone());
            tracing::info!("启动：窗口与后台任务就绪 {:.0} ms", boot_ms());
            tracing::info!("stash started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 库：读取 / 手动添加 / 库根扫描预览与导入
            library::get_library,
            library::add_game,
            library::add_library_root,
            library::preview_library_root,
            library::import_library_root,
            library::remove_library_root,
            library::scan_steam,
            library::import_steam,
            // 游戏运行与手柄
            game::launch_game,
            game::stop_game,
            game::running_game,
            game::pad_status,
            // 设置 / 系统
            settings_cmd::get_settings,
            settings_cmd::update_settings,
            settings_cmd::set_autostart,
            settings_cmd::autostart_enabled,
            settings_cmd::set_fullscreen,
            settings_cmd::set_power60,
            // 更新检查 / 外部链接
            update::check_update,
            update::open_url,
            // 库记录（library.json 单条读写）
            records::set_favorite,
            records::set_launch_args,
            records::set_game_title,
            records::set_hidden,
            records::set_user_tags,
            records::set_notes,
            records::set_rating,
            records::update_endings,
            records::remove_game,
            // 只读文件浏览
            fs::fs_list,
            // 维护：诊断 / 体检 / 清理 / 导入导出
            maintenance::open_dir,
            maintenance::open_app_dir,
            maintenance::recent_log_issues,
            maintenance::export_diagnostics,
            maintenance::report_timing,
            maintenance::library_health,
            maintenance::prune_missing_games,
            maintenance::clean_storage,
            maintenance::export_data,
            maintenance::import_data,
            // 媒体：封面 / 背景 / ISO
            media::mount_iso,
            media::unmount_iso,
            media::set_game_cover,
            media::smart_cover,
            media::steamgrid_cover,
            media::detail_background,
            media::set_game_background,
            media::clear_game_background,
            media::background_candidates,
            media::use_background_candidate,
            // 元数据
            metadata::test_network,
            metadata::probe_sources,
            metadata::match_all,
            metadata::match_one,
            metadata::match_candidates,
            metadata::match_candidates_all,
            metadata::apply_candidate,
            metadata::bind_subject,
            metadata::unmatch_game,
            metadata::cancel_match,
            metadata::match_running,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // 游戏还开着时用户直接退出 Stash：监控线程会随进程终止，
                // 游玩记录（唯一不可再生数据）的落盘点来不及执行——先补写一遍
                launcher::flush_running_records(&app.state::<Store>());
                // 省电模式改的是系统刷新率，任务栏自动隐藏是系统设置，退出必须双双还原
                power::restore();
                win::restore();
                winkey::set_enabled(false);
                input::stop();
            }
        });
}

/// 启动期迁移的预算：每次启动最多重编码这么多张，剩下的等用户进详情时按需处理。
/// 解码 + Lanczos3 放大是纯 CPU 活，几百部老缓存全量跑一遍会白烧几分钟。
const NORMALIZE_BUDGET: usize = 24;

/// 把已经下过的 `_bg.*` 统一规格成 16:9 / 1920×1080（老版本存的是 720p、甚至 4:3）。
/// 启动时后台跑一次：同名替换，必须赶在用户第一次打开详情前完成，否则浏览器会缓存旧图。
fn normalize_existing_bg(store: &Store) {
    let Ok(rd) = std::fs::read_dir(store.covers_dir()) else {
        return;
    };
    let mut n = 0usize;
    let mut left = 0usize;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.contains("_bg.") || name.ends_with(".tmp") {
            continue;
        }
        let p = e.path();
        if bgimg::is_bg_spec(&p) {
            continue;
        }
        if n >= NORMALIZE_BUDGET {
            left += 1;
            continue;
        }
        let dst = p.with_extension("jpg");
        if bgimg::write_from_file(&p, &dst).is_ok() {
            if dst != p {
                let _ = std::fs::remove_file(&p);
            }
            n += 1;
        }
    }
    if n > 0 || left > 0 {
        tracing::info!("背景图规格化：{n} 张已统一为 1920×1080，{left} 张留待进详情时处理");
    }
}

/// 启动时把库里已有标签过一遍中文化（幂等：没有变化就不落盘）。
/// 只在写库路径上翻译的话，老数据永远是英文 / 日文混排。
fn localize_library_tags(store: &Store) {
    let _lock = store::lock_library();
    let mut games = store.load_library();
    let mut changed = false;
    for g in games.iter_mut() {
        let next = tagzh::localize_all(&g.tags);
        if next != g.tags {
            g.tags = next;
            changed = true;
        }
    }
    if !changed {
        return;
    }
    match store.save_library(&games) {
        Ok(()) => tracing::info!("标签中文化：已更新库内标签"),
        Err(e) => tracing::warn!("标签中文化落盘失败：{e}"),
    }
}

/// asset 协议白名单：`tauri.conf.json` 里的 scope 已收紧为空，凡是前端要显示的本地图片
/// 都必须先登记，否则 `asset.localhost` 直接 403。这里只登记封面、缩略图与实机图目录，
/// 不给整个磁盘开口子。
/// 已登记过的 asset 路径。`Option` 是为了在 `static` 里延迟建表
/// （`HashSet::new()` 在该 MSRV 下不是 const fn）
static ASSET_SEEN: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

pub(crate) fn allow_asset(app: &AppHandle, path: &str, recursive: bool) {
    if path.is_empty() {
        return;
    }
    {
        // 去重：get_library 每次刷新都会调到这里。用 HashSet 而不是 Vec：
        // 换封面 / 智能封面会不断产生新路径，线性查找到后期会拖慢整库刷新
        let mut seen = ASSET_SEEN.lock().unwrap_or_else(|e| e.into_inner());
        let set = seen.get_or_insert_with(std::collections::HashSet::new);
        // 长期运行（大量换封面 / 迁移目录）会只增不减：到上限整体重置一次，
        // 代价只是下一轮刷新多登记几条，换来内存不无限增长
        if set.len() > 4096 {
            set.clear();
        }
        if set.contains(path) {
            return;
        }
    }
    let scope = app.asset_protocol_scope();
    let res = if recursive {
        scope.allow_directory(path, true)
    } else {
        scope.allow_file(path)
    };
    match res {
        // 只有登记成功才记入去重表：登记失败（实机图目录还没建 / scope 写入失败）时
        // 若照样记下，这张图会一直被跳过、永久 403，重启前再也显示不出来
        Ok(()) => {
            ASSET_SEEN
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_or_insert_with(std::collections::HashSet::new)
                .insert(path.to_string());
        }
        Err(e) => tracing::warn!("asset 白名单登记失败 {path}：{e}"),
    }
}

fn allow_library_assets(app: &AppHandle, games: &[Game]) {
    // 封面与缩略图通常在 `covers/` / `thumbs/` 下，setup 时已按目录递归登记，
    // 这里不再逐个文件 allow_file：1000 部库会多出两千条 scope，收益为零。
    // 但演示库 / 手动添加的封面仍留在游戏目录里，这类必须单独放行，否则会被 403。
    let covers = {
        let st = app.state::<Store>();
        st.covers_dir()
    };
    for g in games {
        if let Some(c) = &g.cover {
            if !std::path::Path::new(c).starts_with(&covers) {
                allow_asset(app, c, false);
            }
        }
        // 背景候选的本地实机图在 <游戏目录>/shots 下；目录可能还没建，建了才有意义
        let shots = std::path::Path::new(&g.dir).join("shots");
        if shots.is_dir() {
            allow_asset(app, &shots.to_string_lossy(), true);
        }
    }
}

/// 作品 id 一律是 `stable_id` 产出的 16 位十六进制。
///
/// 多个命令会拿 id 直接拼路径（`covers/<id>_custom.png`、`thumbs/<id>@lg.webp`）。
/// 前端传来的 id 若含 `..\`，拼出来的路径会跑到应用数据目录之外，
/// 一次「换封面」就能往任意位置写文件，所以拼路径之前必须过白名单。
pub(crate) fn check_id(id: &str) -> Result<(), AppError> {
    if id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::new(ErrCode::ConfigInvalid, "非法的作品 id"))
    }
}

/// 读—改—写一部游戏（与收藏 / END / 启动记录共用同一把库写锁）
pub(crate) fn mutate_game<F>(store: &Store, id: &str, f: F) -> Result<(), AppError>
where
    F: FnOnce(&mut Game) -> Result<(), AppError>,
{
    let _lock = store::lock_library();
    let mut games = store.load_library();
    let g = games
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中（可能已移除）"))?;
    f(g)?;
    store.save_library(&games)?;
    Ok(())
}

/// 删除 dir 下以 prefix 开头、但保留 keep 所指文件的孤儿清理入口
/// （封面换扩展名 / 换来源后，旧文件不会被任何字段再引用）。
pub(crate) fn prune_prefixed(dir: &std::path::Path, prefix: &str, keep: Option<&std::path::Path>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let hit = p
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.starts_with(prefix))
            .unwrap_or(false);
        if hit && keep.map(|k| k != p.as_path()).unwrap_or(true) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// 清理同一作品的旧自定义封面，避免 png/jpg 来回切换后留孤儿文件
pub(crate) fn prune_custom_covers(dir: &std::path::Path, id: &str, keep: Option<&std::path::Path>) {
    prune_prefixed(dir, &format!("{id}_custom."), keep);
}

#[cfg(test)]
mod tests {
    use super::*;
    // 这些纯函数随模块搬走了，测试仍在本文件里跑
    use crate::maintenance::{
        cache_owner, clean_storage_sync, prune_missing_games_sync, rebind_import_ids,
    };
    use crate::metadata::{
        apply_moegirl, is_auto_cover, needs_match, singleton_hint, stale_auto_match,
    };
    use std::path::PathBuf;

    /// 取消匹配必须回到目录里的 meta.json，并清掉 meta_manual
    /// （否则以后的自动匹配会以为「用户手改过」，永远不再补简介 / 标签 / 年份）
    #[test]
    fn unmatch_restores_local_meta() {
        let root = std::env::temp_dir().join(format!("stash-unmatch-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let meta = r#"{"developer":"Key","year":2004,"tags":["家族","催泪"],"summary":"本地简介"}"#;
        // 带 BOM：PowerShell 5 写出来的 meta.json 就是这样
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(meta.as_bytes());
        std::fs::write(root.join("meta.json"), &bytes).unwrap();

        let mut g = crate::models::Game {
            dir: root.to_string_lossy().to_string(),
            bangumi_id: Some(13),
            match_score: Some(100),
            pending: true,
            matched: true,
            summary: Some("远程简介".into()),
            tags: vec!["远程标签".into()],
            year: Some(2010),
            developer: Some("远程会社".into()),
            meta_score: Some(89.0),
            meta_score_source: Some("bangumi".into()),
            meta_score_count: Some(1000),
            length_minutes: Some(1200),
            meta_manual: true,
            ..Default::default()
        };
        crate::metadata::restore_local_meta(&mut g);
        assert_eq!(g.summary.as_deref(), Some("本地简介"));
        assert_eq!(g.tags, vec!["家族".to_string(), "催泪".to_string()]);
        assert_eq!(g.year, Some(2004));
        assert_eq!(g.developer.as_deref(), Some("Key"));
        assert_eq!(g.bangumi_id, None);
        assert_eq!(g.match_score, None);
        assert!(!g.pending && !g.matched);
        assert_eq!(g.meta_score, None);
        assert_eq!(g.meta_score_count, None);
        assert_eq!(g.length_minutes, None);
        assert!(
            !g.meta_manual,
            "必须清掉手改标记，否则以后自动匹配不再补字段"
        );

        // 没有 meta.json：字段回到空，而不是继续显示联网内容
        std::fs::remove_file(root.join("meta.json")).unwrap();
        crate::metadata::restore_local_meta(&mut g);
        assert_eq!(g.summary, None);
        assert!(g.tags.is_empty());
        assert_eq!(g.year, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 孤儿缓存识别：只认应用自己的命名，陌生文件一律不碰
    #[test]
    fn cache_owner_only_claims_known_names() {
        assert_eq!(cache_owner("abc123.webp", true).as_deref(), Some("abc123"));
        assert_eq!(
            cache_owner("abc123@lg.webp", true).as_deref(),
            Some("abc123")
        );
        assert_eq!(cache_owner("readme.txt", true), None);
        assert_eq!(
            cache_owner("abc123_src.jpg", false).as_deref(),
            Some("abc123")
        );
        assert_eq!(
            cache_owner("abc123_custom.png", false).as_deref(),
            Some("abc123")
        );
        // 智能选封面的产物也要能认出来：否则删作品后它会永远留在 covers/
        assert_eq!(
            cache_owner("abc123_auto.png", false).as_deref(),
            Some("abc123")
        );
        // 详情页背景图同理
        assert_eq!(
            cache_owner("abc123_bg.jpg", false).as_deref(),
            Some("abc123")
        );
        assert_eq!(cache_owner("abc123.jpg", false), None, "原图不归体检清理");
        // 候选条目封面属于「条目」而不是「作品」：不能算孤儿，也不该被清理删掉
        assert_eq!(cache_owner("cand-14379.webp", true), None);
        assert_eq!(cache_owner("cand-14379.webp", false), None);
        // 背景候选缩略图（bg-<id>-<hash>.webp）同理：由 thumb::prune_bg 自管
        assert_eq!(
            cache_owner("bg-0123456789abcdef-0123456789abcdef.webp", true),
            None
        );
    }

    /// 低分重匹配只清机器写的绑定；人工绑定（100 分）与未绑定都不动
    #[test]
    fn stale_binding_rules() {
        assert!(!stale_auto_match(false, None));
        assert!(!stale_auto_match(false, Some(30)));
        assert!(stale_auto_match(true, None), "无分数视为历史机器结果");
        assert!(stale_auto_match(true, Some(60)));
        assert!(
            !stale_auto_match(true, Some(100)),
            "人工绑定不能被低分重匹配清掉"
        );
    }

    /// 全量匹配的跳过规则：正式绑定与已确认的萌娘百科命中不重搜；待确认 / 强制重匹配要跑
    #[test]
    fn match_skips_bound_and_confirmed_moegirl() {
        let mut g = Game::default();
        assert!(needs_match(&g, false), "未匹配过必须跑");
        assert!(needs_match(&g, true));

        g.bangumi_id = Some(232);
        assert!(!needs_match(&g, false), "已绑 Bangumi 不重搜");
        assert!(needs_match(&g, true), "强制重匹配要跑");

        let mut m = Game {
            match_score: Some(82), // 萌娘百科命中：只有分数、没有条目 id
            ..Default::default()
        };
        assert!(
            !needs_match(&m, false),
            "已确认的萌娘百科命中不重搜（否则每轮重下封面）"
        );
        m.pending = true;
        assert!(needs_match(&m, false), "待确认的仍要重试");
    }

    /// 切到萌娘百科时清掉旧 VNDB / IGDB 遗留的参考评分（9.02 曾存成 902）；
    /// EGS / Bangumi 属于现役来源，评分保留。
    #[test]
    fn apply_moegirl_drops_legacy_score() {
        let a = moegirl::Article {
            title: "白色相簿2".into(),
            score: 90,
            summary: Some("中文简介".into()),
            year: Some(2010),
            cover: None,
        };
        let mut g = Game {
            meta_score: Some(902.0),
            meta_score_source: Some("vndb".into()),
            ..Default::default()
        };
        apply_moegirl(&mut g, &a, 90, false);
        assert_eq!(g.title, "白色相簿2");
        assert_eq!(g.meta_source.as_deref(), Some("moegirl"));
        assert_eq!(g.meta_score, None, "旧来源评分应清空");
        assert_eq!(g.meta_score_source, None);
        assert_eq!(g.summary.as_deref(), Some("中文简介"));
        assert_eq!(g.year, Some(2010));

        let mut e = Game {
            meta_score: Some(95.0),
            meta_score_source: Some("egs".into()),
            ..Default::default()
        };
        apply_moegirl(&mut e, &a, 90, false);
        assert_eq!(e.meta_score, Some(95.0), "EGS 评分属于现役来源，不能清");
        assert_eq!(e.meta_score_source.as_deref(), Some("egs"));
    }

    /// 「智能选封面」留下的 `_auto.*` 不该被当成「可复用封面」：
    /// 否则一次启发式误选（挑到标题图 / 占位图）会一直顶掉官方封面。
    #[test]
    fn auto_cover_is_not_reused() {
        assert!(is_auto_cover(r"C:\x\covers\abc_auto.jpg"));
        assert!(is_auto_cover(r"C:\x\covers\abc_auto.png"));
        assert!(!is_auto_cover(r"C:\x\covers\abc_src.jpg"));
        assert!(!is_auto_cover(r"C:\x\covers\abc_custom.png"));
        assert!(!is_auto_cover("noext"));
    }

    /// 缩写 / 带版本号的目录名（DDLC-1.1.1-pc）字面分很低，
    /// 但 Bangumi 只回一条时应当降级为「待确认」而不是「未匹配」。
    #[test]
    fn singleton_search_falls_back_to_pending() {
        assert_eq!(singleton_hint(1, 17), Some(50));
        assert_eq!(singleton_hint(1, 0), Some(50));
        assert_eq!(singleton_hint(1, 60), None, "字面分已够待确认，不要抬高");
        assert_eq!(singleton_hint(3, 17), None, "多条结果时抬分等于乱绑");
        assert_eq!(net::tier(50), net::MatchTier::Pending);
    }

    /// 导入备份时，库里已有的同目录条目必须沿用旧 id：
    /// 封面 `<id>_src.*` / 缩略图 `<id>.webp` 都以 id 命名，
    /// 按新哈希重算会让这些文件在导入后全部失联。
    #[test]
    fn import_keeps_existing_ids() {
        let d = models::DetectedGame {
            title: "AIR".into(),
            title_original: Some("AIR".into()),
            romaji: None,
            dir: r"D:\Games\AIR".into(),
            exe: r"D:\Games\AIR\game.exe".into(),
            engine: models::EngineKind::Kirikiri,
            engine_label: "吉里吉里".into(),
            engine_evidence: "test".into(),
            cover: None,
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
        };
        let (mut games, _) = store::merge_games(&[], vec![d]);
        // 模拟「旧版本按原始写法算出」的 id：与新哈希无关，但必须被沿用
        games[0].id = "0123456789abcdef".into();
        let existing: std::collections::HashMap<String, String> = games
            .iter()
            .map(|g| (store::normalize_dir(&g.dir), g.id.clone()))
            .collect();

        // 备份里的目录写法不同（斜杠 / 大小写），id 是外来值，且同一目录出现两次
        let mut backup = games.clone();
        backup[0].dir = "d:/games/air".into();
        backup[0].id = "ffffffffffffffff".into();
        let mut dup = backup[0].clone();
        dup.dir = r"D:\Games\AIR\".into();
        backup.push(dup);

        let out = rebind_import_ids(backup, &existing);
        assert_eq!(out.len(), 1, "同一目录出现两次只保留一条");
        assert_eq!(out[0].id, "0123456789abcdef", "必须沿用库里已有的 id");
    }

    /// 「清理失效条目」不能删掉整个离线卷（移动盘没插 / 网络盘掉线）上的作品：
    /// 目录不存在 ≠ 目录被删，删了游玩记录就再也回不来
    #[test]
    fn prune_keeps_games_on_missing_volume() {
        // 借一个不存在的盘符模拟离线卷；该盘存在时跳过（避免在真有 Z: 的机器上误判）
        if std::path::Path::new("Z:/").exists() {
            println!("跳过：本机存在 Z: 盘");
            return;
        }
        let store = temp_store("prune-offline");
        let g = Game {
            id: "0123456789abcdef".into(),
            title: "移动盘作品".into(),
            dir: "Z:/vn-offline/AIR".into(),
            exe: "Z:/vn-offline/AIR/game.exe".into(),
            manual: true,
            ..Default::default()
        };
        store.save_library(&[g]).unwrap();
        let removed = prune_missing_games_sync(&store).unwrap();
        assert_eq!(removed, 0, "盘不在时不能删条目");
        assert_eq!(store.load_library().len(), 1);
    }

    /// 批量清理：只删已移除作品的孤儿缓存，库里仍存在的作品缓存不动。
    #[test]
    fn clean_storage_drops_orphan_cache() {
        let store = temp_store("clean-storage");
        let keep_id = "0123456789abcdef";
        let gone_id = "ffffffffffffffff";
        store
            .save_library(&[Game {
                id: keep_id.into(),
                title: "AIR".into(),
                dir: r"D:\Games\AIR".into(),
                exe: r"D:\Games\AIR\game.exe".into(),
                ..Default::default()
            }])
            .unwrap();

        std::fs::create_dir_all(store.thumbs_dir()).unwrap();
        std::fs::write(store.thumbs_dir().join(format!("{gone_id}.webp")), b"x").unwrap();
        std::fs::write(store.thumbs_dir().join(format!("{keep_id}.webp")), b"y").unwrap();

        let out = clean_storage_sync(&store).unwrap();
        assert_eq!(out.cache_removed, 1);
        assert!(out.freed_bytes >= 1);
        assert!(!store.thumbs_dir().join(format!("{gone_id}.webp")).exists());
        assert!(store.thumbs_dir().join(format!("{keep_id}.webp")).exists());
    }

    /// 临时 Store
    fn temp_store(tag: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("stash-lib-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Store { dir }
    }

    /// 演示库路径（相对 Cargo.toml 的上一级）
    fn demo_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("demo-library")
    }

    /// 演示库按「手动添加」的方式逐部探测：每个子目录取第一个 exe 当主程序。
    /// 以下划线开头的目录（_assets）是素材，不算作品。
    fn demo_detect(demo: &std::path::Path) -> Vec<crate::models::DetectedGame> {
        std::fs::read_dir(demo)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.path().is_dir())
                    .filter(|e| !e.file_name().to_string_lossy().starts_with('_'))
                    .filter_map(|e| {
                        let dir = e.path();
                        let exe = std::fs::read_dir(&dir)
                            .ok()?
                            .flatten()
                            .map(|f| f.path())
                            .find(|p| {
                                p.extension()
                                    .map(|x| x.to_string_lossy().eq_ignore_ascii_case("exe"))
                                    .unwrap_or(false)
                            })?;
                        let title = dir.file_name()?.to_string_lossy().to_string();
                        Some(scanner::detect_manual(&dir, &exe, &title))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 库级集成：真实探测演示库 → 收藏落盘 → 重读仍在。
    #[test]
    fn demo_library_detect_and_favorite_roundtrip() {
        let demo = demo_dir();
        if !demo.is_dir() {
            println!("跳过：未找到演示库 {}", demo.display());
            return;
        }
        let store = temp_store("e2e");

        // ① 真实探测
        let detected = demo_detect(&demo);
        assert!(
            detected.len() >= 10,
            "演示库应探测到 ≥10 部，实际 {}",
            detected.len()
        );

        // ①b 本地 meta.json 必须真正读进来（BOM 回归：曾因 UTF-8 BOM 全部解析失败）
        let with_dev = detected.iter().filter(|d| d.developer.is_some()).count();
        let with_tags = detected.iter().filter(|d| !d.tags.is_empty()).count();
        let with_year = detected.iter().filter(|d| d.year.is_some()).count();
        assert_eq!(with_dev, detected.len(), "每部演示游戏都应读到 developer");
        assert_eq!(with_tags, detected.len(), "每部演示游戏都应读到 tags");
        assert_eq!(with_year, detected.len(), "每部演示游戏都应读到 year");

        // ② 入库
        let (games, report) = store::merge_games(&[], detected);
        assert_eq!(report.added, games.len());
        store.save_library(&games).unwrap();
        let loaded = store.load_library();
        assert_eq!(loaded.len(), games.len());

        // ③ 收藏落盘：set_favorite 的等价逻辑（命令层只是包了一层 State）
        let target = loaded[0].id.clone();
        {
            let mut g = store.load_library();
            let rec = g.iter_mut().find(|x| x.id == target).unwrap();
            rec.favorite = true;
            store.save_library(&g).unwrap();
        }
        let reread = store.load_library();
        assert!(
            reread.iter().find(|x| x.id == target).unwrap().favorite,
            "收藏必须在重启（重读 library.json）后仍然存在"
        );
        // .bak 兜底也应可读
        assert!(store.library_bak_path().exists(), "写盘应滚动生成 .bak");

        // ④ 重新探测后合并仍保留收藏（merge_games 的契约）
        let detected2 = demo_detect(&demo);
        let (merged, _) = store::merge_games(&reread, detected2);
        assert!(
            merged.iter().find(|x| x.id == target).unwrap().favorite,
            "重新探测合并后收藏不能丢"
        );
    }
}

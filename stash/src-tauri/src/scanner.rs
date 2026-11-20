//! 手动添加 exe / 扫描库根时的目录信息采集（引擎识别、封面、本地实机图、meta.json、体积）。
//!
//! 手动添加按指定目录 + exe 组装一条记录；库根扫描先用 `find_games` 轻量发现
//! 候选（只找目录与主 exe），用户确认后再调 `detect_manual` 做完整探测。

use crate::engine;
use crate::models::DetectedGame;
use crate::pe;
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// 库根扫描发现的候选游戏（尚未入库；只含目录与主程序，不读体积 / 封面）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundGame {
    pub dir: PathBuf,
    pub exe: PathBuf,
}

/// 单次扫描的候选上限：病态目录（几万个同级文件夹）不能拖死界面
const MAX_CANDIDATES: usize = 500;

/// 辅助程序关键字：含这些片段的 exe 不当作游戏主程序
const AUX_EXE: &[&str] = &[
    "unins",
    "setup",
    "install",
    "config",
    "crash",
    "updater",
    "vcredist",
    "dxsetup",
    "patch",
    "unitycrashhandler",
];

/// 扫描库根：列出下一级子目录中的候选游戏。
///
/// - 跳过 `_` / `.` 开头的目录（如演示库的 `_assets`）；
/// - 每个子目录先看本层 exe，没有再看下一层子目录（`作品名/game/xxx.exe`）；
/// - 同名目录里同时有汉化版与日文版时优先汉化版（`*_ch.exe` / `*_chs.exe`），
///   否则取体积最大的；辅助程序（卸载 / 安装 / 配置 / 崩溃上报）排除。
pub fn find_games(root: &Path) -> Vec<FoundGame> {
    let mut out = Vec::new();
    // 读不动目录（权限 / IO / 盘掉线）不能伪装成「0 个候选」：用户会以为库是空的
    let rd = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) => {
            tracing::warn!("扫描目录失败 {}：{e}", root.display());
            return out;
        }
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| !ignored_dir(p))
        .collect();
    dirs.sort();
    for dir in dirs {
        let exe = pick_main_exe(&dir).or_else(|| second_level_exe(&dir));
        let Some(exe) = exe else { continue };
        out.push(FoundGame { dir, exe });
        if out.len() >= MAX_CANDIDATES {
            break;
        }
    }
    out
}

fn ignored_dir(p: &Path) -> bool {
    p.file_name()
        .map(|n| {
            let n = n.to_string_lossy();
            n.starts_with('_') || n.starts_with('.')
        })
        .unwrap_or(false)
}

fn is_aux_exe(lower_name: &str) -> bool {
    AUX_EXE.iter().any(|k| lower_name.contains(k))
}

/// 汉化版主程序：stem 以 `ch` / `chs` 结尾，且前面是分隔符或没有前缀。
///
/// 只做后缀判断会把 `patch.exe` / `launch.exe` / `speech.exe` 也当成汉化版，
/// 因此要求 `ch`/`chs` 前面不是字母数字（`game_chs` / `game-CHS` / `game chs` / `chs`）。
pub(crate) fn is_chs_stem(stem_lower: &str) -> bool {
    let head = if let Some(h) = stem_lower.strip_suffix("chs") {
        h
    } else if let Some(h) = stem_lower.strip_suffix("ch") {
        h
    } else {
        return false;
    };
    head.is_empty() || !head.chars().next_back().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false)
}

/// 目录本层的 exe：排除辅助程序后，汉化版优先，其次取体积最大者
pub(crate) fn pick_main_exe(dir: &Path) -> Option<PathBuf> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            tracing::warn!("读取目录失败 {}：{e}", dir.display());
            return None;
        }
    };
    let mut best: Option<(u64, PathBuf)> = None;
    let mut best_chs: Option<(u64, PathBuf)> = None;
    for e in rd.flatten() {
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = e.path();
        let Some(stem) = p.file_stem() else { continue };
        let lower = p
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !lower.ends_with(".exe") || is_aux_exe(&lower) {
            continue;
        }
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
            best = Some((size, p.clone()));
        }
        // 汉化版单独记一条：体积更小的汉化 exe 也要压过体积更大的日文原版
        if is_chs_stem(&stem.to_string_lossy().to_lowercase())
            && best_chs.as_ref().map(|(s, _)| size > *s).unwrap_or(true)
        {
            best_chs = Some((size, p));
        }
    }
    best_chs.or(best).map(|(_, p)| p)
}

/// 二级兜底：作品目录本身没有 exe 时，下探一层子目录找主程序
pub(crate) fn second_level_exe(dir: &Path) -> Option<PathBuf> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            tracing::warn!("读取目录失败 {}：{e}", dir.display());
            return None;
        }
    };
    let mut subs: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| !ignored_dir(p))
        .collect();
    subs.sort();
    let mut best: Option<(u64, PathBuf)> = None;
    let mut best_chs: Option<(u64, PathBuf)> = None;
    for sub in subs {
        let Some(exe) = pick_main_exe(&sub) else { continue };
        let size = std::fs::metadata(&exe).map(|m| m.len()).unwrap_or(0);
        if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
            best = Some((size, exe.clone()));
        }
        let stem = exe
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if is_chs_stem(&stem) && best_chs.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
            best_chs = Some((size, exe));
        }
    }
    best_chs.or(best).map(|(_, p)| p)
}

/// 作品目录的主程序：先看本层，再下探一层（Steam 常见的 `bin/` 布局）
pub(crate) fn find_main_exe(dir: &Path) -> Option<PathBuf> {
    pick_main_exe(dir).or_else(|| second_level_exe(dir))
}

/// 游戏目录内的本地元数据（可选）。纯离线的元数据来源：目录名当标题之外，
/// 允许玩家在游戏目录放 meta.json 补齐原名 / 会社 / 标签 / 简介。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct LocalMeta {
    pub(crate) title_original: Option<String>,
    pub(crate) romaji: Option<String>,
    pub(crate) developer: Option<String>,
    pub(crate) year: Option<u32>,
    pub(crate) tags: Vec<String>,
    /// 搜索别名（英文名 / 简称 / 常见错译），只喂搜索不展示
    pub(crate) aliases: Vec<String>,
    /// 每游戏启动参数（原样追加到命令行）
    pub(crate) launch_args: Vec<String>,
    pub(crate) summary: Option<String>,
}

/// meta.json 的读取上限。本机文件也要防「网络盘上的 GB 级文件」整份进内存。
const MAX_META_BYTES: u64 = 1024 * 1024;

pub(crate) fn read_meta(dir: &Path) -> LocalMeta {
    use std::io::Read;
    let file = match std::fs::File::open(dir.join("meta.json")) {
        Ok(f) => f,
        Err(_) => return LocalMeta::default(),
    };
    let mut s = String::new();
    if file.take(MAX_META_BYTES).read_to_string(&mut s).is_err() {
        return LocalMeta::default();
    }
    // UTF-8 BOM：PowerShell 5 的 `Set-Content -Encoding UTF8` 会写入它，
    // serde_json 见到 BOM 直接报错 → 整份本地元数据被静默丢弃（标签/会社/年份全空）。
    match serde_json::from_str(s.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(e) => {
            // 坏文件不再静默：用户手改错一个逗号时，至少要能在日志里看到原因
            tracing::warn!("meta.json 解析失败 {}：{e}", dir.join("meta.json").display());
            LocalMeta::default()
        }
    }
}

/// 手动添加：按用户指定的 exe + 标题组装一条记录。
/// 引擎、封面、meta.json、体积按目录现状读取；同一个目录 + exe 得到同一个 id。
pub fn detect_manual(dir: &Path, exe: &Path, title: &str) -> DetectedGame {
    let (engine_kind, evidence) = engine::detect(dir);
    let pe_info = pe::read(exe);
    let meta = read_meta(dir);
    let size = dir_size_limited(dir, 6000);
    let matched = meta.title_original.is_some() || meta.developer.is_some();

    DetectedGame {
        title: title.trim().to_string(),
        title_original: meta.title_original.filter(|s| !s.is_empty()),
        romaji: meta.romaji.filter(|s| !s.is_empty()),
        dir: dir.to_string_lossy().to_string(),
        exe: exe.to_string_lossy().to_string(),
        engine: engine_kind,
        engine_label: engine_kind.label().to_string(),
        engine_evidence: evidence,
        cover: find_cover(dir),
        shots: find_shots(dir),
        pe_product: pe_info.as_ref().and_then(|p| p.product.clone()),
        pe_company: pe_info.as_ref().and_then(|p| p.company.clone()),
        developer: meta
            .developer
            .filter(|s| !s.is_empty())
            .or(pe_info.as_ref().and_then(|p| p.company.clone())),
        size_gb: (size as f64 / 1024.0 / 1024.0 / 1024.0 * 100.0).round() / 100.0,
        matched,
        launch_args: meta.launch_args,
        summary: meta.summary.filter(|s| !s.is_empty()),
        tags: meta.tags,
        aliases: meta.aliases,
        year: meta.year,
    }
}

/// 在游戏目录找封面图。
fn find_cover(dir: &Path) -> Option<String> {
    const PREFER: &[&str] = &[
        "cover", "package", "jacket", "box", "poster", "title", "main", "logo", "icon",
    ];
    const IMG_EXT: &[&str] = &["jpg", "jpeg", "png", "bmp", "webp"];
    const SUBDIRS: &[&str] = &["", "img", "image", "images", "pic", "data", "graphic"];

    let mut best: Option<(i32, u64, String)> = None;

    for sub in SUBDIRS {
        let target = if sub.is_empty() {
            dir.to_path_buf()
        } else {
            dir.join(sub)
        };
        let Ok(rd) = std::fs::read_dir(&target) else {
            continue;
        };
        for entry in rd.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            let Some(ext) = lower.rsplit('.').next() else {
                continue;
            };
            if !IMG_EXT.contains(&ext) {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            // 太小的多半是图标或 UI 素材
            if size < 15_000 {
                continue;
            }
            let mut score = 10i32;
            for (i, key) in PREFER.iter().enumerate() {
                if lower.contains(key) {
                    score = 100 - i as i32 * 5;
                    break;
                }
            }
            if sub.is_empty() {
                score += 5;
            }
            // 同分时取更大的文件：read_dir 的返回顺序由文件系统决定，
            // 只比 score 会让「同名图里选哪张」不可复现
            if best
                .as_ref()
                .map(|(s, sz, _)| (score, size) > (*s, *sz))
                .unwrap_or(true)
            {
                best = Some((score, size, entry.path().to_string_lossy().to_string()));
            }
        }
    }

    best.map(|(_, _, p)| p)
}

/// 收集游戏目录下的实机图（背景候选与本地背景用）：shots/ 或 screenshot/ 子目录，
/// 按文件名排序，最多 3 张。
fn find_shots(dir: &Path) -> Vec<String> {
    const SHOT_DIRS: &[&str] = &["shots", "screenshots", "screenshot"];
    const IMG_EXT: &[&str] = &["jpg", "jpeg", "png", "webp"];

    for sub in SHOT_DIRS {
        let target = dir.join(sub);
        let Ok(rd) = std::fs::read_dir(&target) else { continue };
        let mut files: Vec<String> = Vec::new();
        for entry in rd.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            let Some(ext) = lower.rsplit('.').next() else { continue };
            if IMG_EXT.contains(&ext) {
                files.push(entry.path().to_string_lossy().to_string());
            }
        }
        if files.is_empty() {
            continue;
        }
        files.sort();
        // capture-<毫秒时间戳> 的字典序就是时间序：只保留最新三张作为背景素材，
        // 避免旧图长期占用候选位。
        if files.len() > 3 {
            files.drain(..files.len() - 3);
        }
        return files;
    }
    Vec::new()
}

/// 目录 CG 的筛选规则（拆出来便于单测）：横向构图、至少 720p、不是 UI 素材。
fn cg_shot_ok(name: &str, w: u32, h: u32, bytes: u64) -> bool {
    const SKIP: &[&str] = &["icon", "thumb", "logo", "button", "cursor", "mask"];
    let ratio = w as f32 / h.max(1) as f32;
    bytes >= 200_000
        && w >= 1280
        && h >= 720
        && (1.5..=2.4).contains(&ratio)
        && !SKIP.iter().any(|k| name.contains(k))
}

/// 目录里可当详情背景的 CG 大图：`shots/` 没有图时的兜底。
///
/// 只扫少量常见素材目录（根目录 + bg / cg / event 等），并要求横向、至少 720p、
/// 体积不过小——否则包里的图标、UI 素材、竖版封面都会被当成背景。
/// 只读图片头取尺寸，不整张解码；每个目录最多看 400 个条目。
pub(crate) fn find_cg_image(dir: &Path) -> Option<(PathBuf, u64, u32, u32)> {
    const CG_DIRS: &[&str] = &[
        "", "bg", "cg", "event", "ev", "graphic", "graphics", "image", "images", "pic", "picture",
    ];
    const IMG_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];
    const MAX_PER_DIR: usize = 400;

    let mut best: Option<(PathBuf, u64, u32, u32)> = None;
    for sub in CG_DIRS {
        let target = if sub.is_empty() {
            dir.to_path_buf()
        } else {
            dir.join(sub)
        };
        let Ok(rd) = std::fs::read_dir(&target) else {
            continue;
        };
        for entry in rd.flatten().take(MAX_PER_DIR) {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            let Some(ext) = name.rsplit('.').next() else {
                continue;
            };
            if !IMG_EXT.contains(&ext) {
                continue;
            }
            let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let p = entry.path();
            let Ok((w, h)) = image::image_dimensions(&p) else {
                continue;
            };
            if !cg_shot_ok(&name, w, h, bytes) {
                continue;
            }
            let area = crate::media::eff_area(w, h);
            if best.as_ref().map(|(_, a, _, _)| area > *a).unwrap_or(true) {
                best = Some((p, area, w, h));
            }
        }
    }
    best
}

/// 限制文件数量的目录体积统计，避免超大目录拖死读取。
fn dir_size_limited(dir: &Path, max_files: usize) -> u64 {
    let mut total: u64 = 0;
    let mut n = 0usize;
    for entry in walkdir::WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .flatten()
    {
        if n >= max_files {
            break;
        }
        if entry.file_type().is_file() {
            if let Ok(md) = entry.metadata() {
                total += md.len();
                n += 1;
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 库根扫描：只认作品子目录里的主 exe，跳过 `_` 目录 / 辅助程序 / 无 exe 目录
    #[test]
    fn find_games_skips_aux_and_hidden_dirs() {
        let root = std::env::temp_dir().join(format!("stash-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let a = root.join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("game.exe"), vec![0u8; 1024]).unwrap();

        // 二级兜底：作品目录本身没有 exe，主程序在 game/ 子目录
        let b_inner = root.join("b").join("game");
        std::fs::create_dir_all(&b_inner).unwrap();
        std::fs::write(b_inner.join("sub.exe"), vec![0u8; 2048]).unwrap();

        // 没有 exe 的目录不应出现
        std::fs::create_dir_all(root.join("c")).unwrap();
        std::fs::write(root.join("c").join("readme.txt"), b"x").unwrap();

        // `_` 开头的目录整体跳过
        let hidden = root.join("_assets");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(hidden.join("x.exe"), vec![0u8; 512]).unwrap();

        // 卸载程序体积更大，也不能当主程序
        let d = root.join("d");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("unins000.exe"), vec![0u8; 9000]).unwrap();
        std::fs::write(d.join("game.exe"), vec![0u8; 4096]).unwrap();

        // 多个 exe 取体积最大的
        let e = root.join("e");
        std::fs::create_dir_all(&e).unwrap();
        std::fs::write(e.join("small.exe"), vec![0u8; 1024]).unwrap();
        std::fs::write(e.join("big.exe"), vec![0u8; 5000]).unwrap();

        let got = find_games(&root);
        let names: Vec<String> = got
            .iter()
            .map(|f| f.dir.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a", "b", "d", "e"]);
        assert!(got
            .iter()
            .find(|f| f.dir.ends_with("d"))
            .unwrap()
            .exe
            .ends_with("game.exe"));
        assert!(got
            .iter()
            .find(|f| f.dir.ends_with("e"))
            .unwrap()
            .exe
            .ends_with("big.exe"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 汉化版优先：`*_ch(s).exe` 即使比日文原版小，也作为主程序入库；
    /// 以 ch 结尾的普通单词（speech.exe / patch.exe）不能误判
    #[test]
    fn chs_exe_wins_over_larger_original() {
        let root = std::env::temp_dir().join(format!("stash-chs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let a = root.join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("game.exe"), vec![0u8; 8192]).unwrap();
        std::fs::write(a.join("game_chs.exe"), vec![0u8; 1024]).unwrap();

        // 另一种常见写法：分隔符不同 / 大写
        let b = root.join("b");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("main.exe"), vec![0u8; 8192]).unwrap();
        std::fs::write(b.join("main-CH.EXE"), vec![0u8; 1024]).unwrap();

        // speech.exe 只是以 ch 结尾的英文词，不能当成汉化版
        let c = root.join("c");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join("speech.exe"), vec![0u8; 1024]).unwrap();
        std::fs::write(c.join("game.exe"), vec![0u8; 8192]).unwrap();

        let got = find_games(&root);
        let exe_of = |name: &str| {
            got.iter()
                .find(|f| f.dir.ends_with(name))
                .unwrap()
                .exe
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string()
        };
        assert_eq!(exe_of("a"), "game_chs.exe");
        assert_eq!(exe_of("b"), "main-CH.EXE");
        assert_eq!(exe_of("c"), "game.exe", "speech.exe 不是汉化版");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 二级兜底同样按汉化版优先：两个子目录各有一版时选 chs 那版
    #[test]
    fn chs_exe_wins_in_second_level() {
        let root = std::env::temp_dir().join(format!("stash-chs2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("work");
        std::fs::create_dir_all(dir.join("jp")).unwrap();
        std::fs::create_dir_all(dir.join("cn")).unwrap();
        std::fs::write(dir.join("jp/game.exe"), vec![0u8; 8192]).unwrap();
        std::fs::write(dir.join("cn/game_chs.exe"), vec![0u8; 1024]).unwrap();

        let got = find_games(&root);
        assert_eq!(got.len(), 1);
        assert!(got[0].exe.ends_with("game_chs.exe"), "{:?}", got[0].exe);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 回归：PowerShell 5 写出的 meta.json 带 UTF-8 BOM，不能让整份本地元数据失效
    #[test]
    fn meta_json_with_bom_is_parsed() {
        let dir = std::env::temp_dir().join(format!("stash-bom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let body = "{\n \"titleOriginal\": \"CLANNAD\",\n \"developer\": \"Key\",\n \"year\": 2004,\n \"tags\": [\"催泪\", \"家族\"]\n}";
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(body.as_bytes());
        std::fs::write(dir.join("meta.json"), bytes).unwrap();

        let m = read_meta(&dir);
        assert_eq!(m.title_original.as_deref(), Some("CLANNAD"));
        assert_eq!(m.developer.as_deref(), Some("Key"));
        assert_eq!(m.year, Some(2004));
        assert_eq!(m.tags, vec!["催泪", "家族"]);
    }

    /// meta.json 超过 1MB 时不整份读入：截断后解析失败，回落到默认值
    #[test]
    fn huge_meta_json_is_not_read_whole() {
        let dir = std::env::temp_dir().join(format!("stash-huge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut body = String::from("{\"titleOriginal\":\"X\",\"tags\":[\"");
        body.push_str(&"a".repeat(1024 * 1024));
        body.push_str("\"]}");
        std::fs::write(dir.join("meta.json"), body.as_bytes()).unwrap();

        let m = read_meta(&dir);
        assert!(m.tags.is_empty(), "超限文件应整份丢弃，而不是解析半截");
    }

    /// 本地实机图只保留最新三张：capture-<ts> 字典序即时间序，旧图不再占用背景候选位
    #[test]
    fn find_shots_keeps_newest_three() {
        let dir = std::env::temp_dir().join(format!("stash-shots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shots = dir.join("shots");
        std::fs::create_dir_all(&shots).unwrap();
        for i in 1..=5 {
            std::fs::write(shots.join(format!("capture-{i}.png")), b"x").unwrap();
        }
        let got: Vec<String> = find_shots(&dir)
            .into_iter()
            .map(|p| {
                Path::new(&p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert_eq!(got, vec!["capture-3.png", "capture-4.png", "capture-5.png"], "升序且只保留最新三张");

        // 不足三张时原样返回
        for i in 3..=5 {
            let _ = std::fs::remove_file(shots.join(format!("capture-{i}.png")));
        }
        assert_eq!(find_shots(&dir).len(), 2, "不足三张不应被裁剪");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 目录 CG 兜底只收横向大图：竖版封面、UI 小图、低分辨率素材都不能当背景
    #[test]
    fn cg_shot_filter_skips_ui_and_portraits() {
        assert!(cg_shot_ok("ev_01.png", 1920, 1080, 900_000), "16:9 大图可用");
        assert!(cg_shot_ok("bg_02.jpg", 1600, 1000, 500_000), "16:10 也算横向");
        assert!(!cg_shot_ok("ev_01.png", 1024, 768, 900_000), "不足 720p");
        assert!(!cg_shot_ok("cover.png", 800, 1200, 900_000), "竖版封面");
        assert!(!cg_shot_ok("ev_icon.png", 1920, 1080, 900_000), "UI 素材");
        assert!(!cg_shot_ok("ev_01.png", 3000, 800, 900_000), "超宽横幅不参与");
        assert!(!cg_shot_ok("ev_01.png", 1920, 1080, 120_000), "小文件不参与");
    }
}

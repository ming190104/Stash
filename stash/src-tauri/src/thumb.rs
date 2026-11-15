//! 缩略图管线（总案 7.4 / UI 规范 #26 两档）：
//! 轨道档 255×340（入库后台预生成）+ 详情档 300×400（按需生成）。
//! WebP q80 有损（libwebp 绑定）；cover 裁切（先缩放覆盖再中心裁）保证 3:4 不变形。
//! （image 0.25 自带 webp 编码仅 lossless，故用 webp crate 做有损档，见总案 14.1）

use crate::store::Store;
use image::{DynamicImage, GenericImageView};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

pub const RAIL: (u32, u32) = (255, 340);
pub const DETAIL: (u32, u32) = (300, 400);
/// 候选条目封面（元数据匹配的「选择条目」列表）：3:4 小图，够看清是哪部作品
pub const CANDIDATE: (u32, u32) = (120, 160);
/// 背景候选（16:9 卡片墙）：320×180 在 4 列卡片里足以看清画面
pub const BG_CAND: (u32, u32) = (320, 180);
/// 候选封面缓存上限（按文件数）：一张约 5 KB，300 张 ≈ 1.5 MB；超了按 mtime 淘汰最旧的
const CANDIDATE_CACHE_MAX: usize = 300;
/// 背景候选缩略图上限（按文件数）：一张约 10 KB，240 张 ≈ 2.4 MB
const BG_CACHE_MAX: usize = 240;

/// 详情档缩略图缓存上限：超过后按最久未使用（mtime）淘汰。
/// 只清 `@lg.webp`——轨道档是全量预生成的，删了下次启动要重算，得不偿失。
const DETAIL_CACHE_MAX_BYTES: u64 = 128 * 1024 * 1024;

/// 解压炸弹兜底：80MP（≈320MB RGB）以上一律不当封面，宁可不显示也不把进程撑崩
const MAX_PIXELS: u64 = 80_000_000;

/// 临时文件唯一后缀：同一进程内并发生成同一张图时，两个线程不能用同一个 .tmp
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok()?.modified().ok()
}

/// 缓存是否仍然对应当前源图：产物比源图旧就说明封面换过（用户换封面 / 重新匹配下载了新图），
/// 必须重生成——否则轨道永远停在旧封面上。
fn fresh(out: &Path, cover: &str) -> bool {
    match (mtime(out), mtime(Path::new(cover))) {
        (Some(o), Some(s)) => s <= o,
        _ => false,
    }
}

/// 轨道档是否需要重生成：产物不存在，或源图比产物新（用户换封面 / 重新匹配下载新图）。
/// 预生成队列用它判定——只看 `thumb.is_none()` 的话，封面换了但字段还在，
/// `fresh()` 永远不会被调用，轨道就会一直停在旧封面上。
pub fn stale(store: &Store, cover: &str, id: &str) -> bool {
    let out = store.thumbs_dir().join(format!("{id}.webp"));
    !(out.exists() && fresh(&out, cover))
}

/// 确保缩略图存在并返回其路径。cover 缺失 / 解码失败返回 None（前端走占位美术）。
pub fn ensure(store: &Store, cover: &str, id: &str, large: bool) -> Option<PathBuf> {
    let (tw, th) = if large { DETAIL } else { RAIL };
    let name = if large { format!("{id}@lg.webp") } else { format!("{id}.webp") };
    let out = store.thumbs_dir().join(name);
    if out.exists() && fresh(&out, cover) {
        // 详情档按 mtime 做 LRU 淘汰：命中时刷新时间戳，否则常用的图反而先被回收
        if large {
            let _ = std::fs::File::options()
                .write(true)
                .open(&out)
                .and_then(|f| f.set_modified(SystemTime::now()));
        }
        return Some(out);
    }

    let src: DynamicImage = load_image(cover)?;
    let fitted = cover_crop(src, tw, th);

    // libwebp 有损编码 q80
    let encoder = webp::Encoder::from_image(&fitted).ok()?;
    let mem = encoder.encode(80.0);
    // 先写临时文件再改名：写到一半失败/进程被杀时不会留下损坏的 webp，
    // 否则下次源图没变时会命中这个坏文件且永不重建
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = out.with_extension(format!("{}.{seq}.tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, &*mem) {
        // 写一半失败（磁盘满 / 被占用）必须把 .tmp 带走，否则它会永久留在 thumbs/
        let _ = std::fs::remove_file(&tmp);
        tracing::warn!("thumb 写入失败 {}: {e}", out.display());
        return None;
    }
    if std::fs::rename(&tmp, &out).is_err() {
        let _ = std::fs::remove_file(&tmp);
        // 并发场景（入库预生成 + 详情页按需生成）：另一处已经把同一张写好了，
        // 内容等价，直接用现有文件，别让前端闪回占位图
        if out.exists() && fresh(&out, cover) {
            return Some(out);
        }
        return None;
    }
    Some(out)
}

/// 候选条目封面：把 Bangumi 搜索结果里的封面写成 `thumbs/cand-<subjectId>.webp`。
///
/// 前端不能直连 `lain.bgm.tv`：CSP 的 `img-src` 只放行 `asset:`，外域图片必须由后端下载。
/// 所以由后端下载 + 裁成 3:4 小图，前端用 asset() 显示。已存在的直接复用——
/// 同一部作品反复打开候选列表不会重复下载。
pub fn candidate_thumb(store: &Store, subject_id: u32, bytes: &[u8]) -> Option<PathBuf> {
    let out = store.thumbs_dir().join(format!("cand-{subject_id}.webp"));
    if out.exists() {
        return Some(out);
    }
    write_candidate(out, bytes)
}

/// 萌娘百科候选封面：来源没有数值 id，用页面标题的稳定哈希做文件名。
/// 与 Bangumi 候选共用 `cand-` 前缀与 LRU 淘汰。
pub fn candidate_thumb_keyed(store: &Store, key: &str, bytes: &[u8]) -> Option<PathBuf> {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    let out = store.thumbs_dir().join(format!("cand-moe-{hash:016x}.webp"));
    if out.exists() {
        return Some(out);
    }
    write_candidate(out, bytes)
}

/// 鲲 Galgame 候选封面：作品 id 是站点数字 id，直接进文件名。
/// 与其它候选封面共用 `cand-` 前缀与 LRU 淘汰。
pub fn candidate_thumb_kungal(store: &Store, work_id: &str, bytes: &[u8]) -> Option<PathBuf> {
    let out = store.thumbs_dir().join(format!("cand-kungal-{work_id}.webp"));
    if out.exists() {
        return Some(out);
    }
    write_candidate(out, bytes)
}

/// 候选封面落盘：裁成 3:4 小图 + WebP，经临时文件原子替换。
fn write_candidate(out: PathBuf, bytes: &[u8]) -> Option<PathBuf> {
    let img = decode_bytes(bytes)?;
    let fitted = cover_crop(img, CANDIDATE.0, CANDIDATE.1);
    let encoder = webp::Encoder::from_image(&fitted).ok()?;
    let mem = encoder.encode(80.0);
    // 与 ensure() 同一套临时文件写法：并发 / 中途失败都不留半张图
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = out.with_extension(format!("{}.{seq}.tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, &*mem) {
        let _ = std::fs::remove_file(&tmp);
        tracing::warn!("候选封面写入失败 {}: {e}", out.display());
        return None;
    }
    if std::fs::rename(&tmp, &out).is_err() {
        let _ = std::fs::remove_file(&tmp);
        // 另一处（另一个候选请求）已经写好同一张：内容等价，直接用
        if out.exists() {
            return Some(out);
        }
        return None;
    }
    Some(out)
}

/// 背景候选缩略图：把「当前背景 / 目录截图 / 商店横幅」统一裁成 16:9 小图，
/// 前端卡片墙只用 asset() 显示本地文件（CSP 不放行图片域名，也不该让界面直连 CDN）。
///
/// 文件名用来源的短哈希，而不是原路径 / URL：URL 里的 `/ ? =` 不能进文件名，
/// 同一张图反复打开选择器时也必须稳定命中同一份缓存。
fn bg_name(id: &str, key: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("bg-{id}-{h:016x}.webp")
}

/// 已缓存的背景候选缩略图（网图在下载前先查它，避免重复走网络）
pub fn bg_thumb_cached(store: &Store, id: &str, key: &str) -> Option<PathBuf> {
    let out = store.thumbs_dir().join(bg_name(id, key));
    out.exists().then_some(out)
}

/// 本地图（当前背景 / 目录截图）→ 16:9 缩略图。
/// 源图比产物新就重建：`covers/<id>_bg.jpg` 是**同名覆盖**，不比对 mtime 会一直显示旧背景。
pub fn bg_thumb_file(store: &Store, id: &str, src: &str) -> Option<PathBuf> {
    let out = store.thumbs_dir().join(bg_name(id, src));
    if out.exists() && fresh(&out, src) {
        return Some(out);
    }
    let img = load_image(src)?;
    write_bg(&out, img)
}

/// 网图（SGDB 横幅）→ 16:9 缩略图；地址不变即命中缓存
pub fn bg_thumb_bytes(store: &Store, id: &str, key: &str, bytes: &[u8]) -> Option<PathBuf> {
    let out = store.thumbs_dir().join(bg_name(id, key));
    if out.exists() {
        return Some(out);
    }
    let img = decode_bytes(bytes)?;
    write_bg(&out, img)
}

fn write_bg(out: &Path, img: DynamicImage) -> Option<PathBuf> {
    let fitted = cover_crop(img, BG_CAND.0, BG_CAND.1);
    let encoder = webp::Encoder::from_image(&fitted).ok()?;
    let mem = encoder.encode(78.0);
    // 与 ensure() / candidate_thumb() 同一套临时文件写法：并发或中途失败都不留半张图
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = out.with_extension(format!("{}.{seq}.tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, &*mem) {
        let _ = std::fs::remove_file(&tmp);
        tracing::warn!("背景候选缩略图写入失败 {}: {e}", out.display());
        return None;
    }
    if std::fs::rename(&tmp, out).is_err() {
        let _ = std::fs::remove_file(&tmp);
        if out.exists() {
            return Some(out.to_path_buf());
        }
        return None;
    }
    Some(out.to_path_buf())
}

/// 背景候选缩略图淘汰：按 mtime 从旧到新删，回到上限内。
/// 与候选封面一样，这些图不属于任何作品，由这里自管；
/// 体检 /「清理无用数据」通过 `maintenance::cache_owner` 跳过 `bg-` 前缀。
pub fn prune_bg(store: &Store) {
    let Ok(rd) = std::fs::read_dir(store.thumbs_dir()) else {
        return;
    };
    let mut items: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("bg-") || !name.ends_with(".webp") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        items.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), entry.path()));
    }
    if items.len() <= BG_CACHE_MAX {
        return;
    }
    items.sort_by_key(|(mtime, _)| *mtime);
    let excess = items.len() - BG_CACHE_MAX;
    let mut removed = 0usize;
    for (_, path) in items.into_iter().take(excess) {
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    tracing::info!("thumb prune: 背景候选缓存回收 {removed} 张");
}

/// 候选封面缓存淘汰：按 mtime 从旧到新删，回到上限内。
/// 这些图不属于任何作品（文件名 `cand-<subjectId>.webp`），由这里自管；
/// 体检 /「清理无用数据」通过 `maintenance::cache_owner` 明确跳过它们，不参与孤儿判定。
pub fn prune_candidates(store: &Store) {
    let Ok(rd) = std::fs::read_dir(store.thumbs_dir()) else {
        return;
    };
    let mut items: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("cand-") || !name.ends_with(".webp") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        items.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), entry.path()));
    }
    if items.len() <= CANDIDATE_CACHE_MAX {
        return;
    }
    items.sort_by_key(|(mtime, _)| *mtime);
    let excess = items.len() - CANDIDATE_CACHE_MAX;
    let mut removed = 0usize;
    for (_, path) in items.into_iter().take(excess) {
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    tracing::info!("thumb prune: 候选封面缓存回收 {removed} 张");
}

/// 详情档缓存淘汰：超过上限就按 mtime 从旧到新删，直到落回上限内。
/// 被删的只是可再生的缩略图，下次打开详情页会重新生成。
pub fn prune_detail(store: &Store) {
    let Ok(rd) = std::fs::read_dir(store.thumbs_dir()) else {
        return;
    };
    let mut items: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for entry in rd.flatten() {
        if !entry.file_name().to_string_lossy().ends_with("@lg.webp") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let len = meta.len();
        total += len;
        items.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), len, entry.path()));
    }
    if total <= DETAIL_CACHE_MAX_BYTES {
        return;
    }
    items.sort_by_key(|(mtime, _, _)| *mtime);
    let mut removed = 0usize;
    for (_, len, path) in items {
        if total <= DETAIL_CACHE_MAX_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
            removed += 1;
        }
    }
    tracing::info!("thumb prune: 详情档缓存回收 {removed} 张");
}

/// 从内存字节解码（网络下载的候选封面走这条）：先读头部维度再解码。
/// `load_from_memory` 会直接把整张图解出来，等判到 80MP 时内存已经被撑爆了。
fn decode_bytes(bytes: &[u8]) -> Option<DynamicImage> {
    use image::ImageDecoder;
    let decoder = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let (w, h) = decoder.dimensions();
    if w as u64 * h as u64 > MAX_PIXELS {
        return None;
    }
    DynamicImage::from_decoder(decoder).ok()
}

/// 解码封面并按 EXIF Orientation 摆正：`image::open()` 只读原始像素，
/// 手机拍摄 / 扫描件常带 90° 方向标记，不处理会把竖版封面转倒，
/// 中心裁切的方向也会跟着错。
fn load_image(path: &str) -> Option<DynamicImage> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let (w, h) = decoder.dimensions();
    if w as u64 * h as u64 > MAX_PIXELS {
        return None;
    }
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).ok()?;
    img.apply_orientation(orientation);
    Some(img)
}

/// cover 裁切：先按目标比例居中裁出最大区域，再缩到目标尺寸。
/// 旧写法「放大到覆盖目标再居中裁」在极端长宽比下会造出几千万像素的中间图
/// （如 20000×100 的横幅 → 中间图 68000×340），内存尖峰足以把进程打崩。
fn cover_crop(img: DynamicImage, tw: u32, th: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return img;
    }
    let target = tw as f64 / th as f64;
    let (cw, ch) = if w as f64 / h as f64 > target {
        (((h as f64 * target).round() as u32).clamp(1, w), h)
    } else {
        (w, ((w as f64 / target).round() as u32).clamp(1, h))
    };
    img.crop_imm((w - cw) / 2, (h - ch) / 2, cw, ch)
        .resize_exact(tw, th, image::imageops::FilterType::Lanczos3)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("stash-thumb-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("thumbs")).unwrap();
        Store { dir }
    }

    fn write_cover(path: &Path, rgb: [u8; 3]) {
        let mut img = image::RgbImage::new(120, 160);
        for p in img.pixels_mut() {
            *p = image::Rgb(rgb);
        }
        img.save(path).unwrap();
    }

    /// 预生成队列的过期判定：产物缺失、或源图比产物新，都必须重建
    #[test]
    fn stale_flags_missing_and_old_thumb() {
        let s = temp_store("stale-flag");
        let cover = s.dir.join("cover.png");
        write_cover(&cover, [30, 60, 200]);
        let cover_s = cover.to_string_lossy().to_string();
        assert!(stale(&s, &cover_s, "g2"), "产物不存在时必须重建");
        ensure(&s, &cover_s, "g2", false).unwrap();
        assert!(!stale(&s, &cover_s, "g2"), "刚生成且与源图同步时不应重建");
        let f = std::fs::File::options().write(true).open(&cover).unwrap();
        f.set_modified(SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        drop(f);
        assert!(stale(&s, &cover_s, "g2"), "源图更新后必须重建");
    }

    /// 换封面 / 重新匹配下载新图后，缩略图必须重建（否则轨道永远显示旧封面）
    #[test]
    fn cover_change_invalidates_thumb() {
        let s = temp_store("stale");
        let cover = s.dir.join("cover.png");
        write_cover(&cover, [220, 40, 40]);
        let cover_s = cover.to_string_lossy().to_string();

        let t = ensure(&s, &cover_s, "g1", false).unwrap();
        let first = std::fs::read(&t).unwrap();

        write_cover(&cover, [20, 200, 60]);
        // 时间戳推到产物之后，模拟「新封面比旧缩略图新」
        let f = std::fs::File::options().write(true).open(&cover).unwrap();
        f.set_modified(SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        drop(f);

        let t2 = ensure(&s, &cover_s, "g1", false).unwrap();
        assert_eq!(t, t2, "路径不变，内容必须更新");
        assert_ne!(first, std::fs::read(&t).unwrap(), "缩略图必须重建");
        // 临时文件不能残留
        let stray: Vec<_> = std::fs::read_dir(s.thumbs_dir())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "不应残留临时文件：{stray:?}");
    }

    /// 候选条目封面：字节解码 → 3:4 裁切 → cand-<id>.webp；第二次调用直接复用，不再解码
    #[test]
    fn candidate_thumb_is_cropped_and_cached() {
        let s = temp_store("cand");
        // 用一张 200×200 的方图（裁成 3:4 后应变成 120×160）
        let src = s.dir.join("src.png");
        let mut img = image::RgbImage::new(200, 200);
        for p in img.pixels_mut() {
            *p = image::Rgb([90, 140, 200]);
        }
        img.save(&src).unwrap();
        let bytes = std::fs::read(&src).unwrap();

        let p = candidate_thumb(&s, 4321, &bytes).expect("应生成候选封面");
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "cand-4321.webp");
        let decoded = image::open(&p).unwrap();
        assert_eq!(decoded.dimensions(), CANDIDATE, "必须裁成 3:4 小图");

        // 传入坏字节也必须复用已有缓存（不会覆盖成空图）
        let again = candidate_thumb(&s, 4321, b"not an image").expect("已缓存应直接复用");
        assert_eq!(again, p);
        assert_eq!(image::open(&again).unwrap().dimensions(), CANDIDATE);
    }

    /// 背景候选缩略图：本地图裁成 16:9；源图同名覆盖后必须重建
    #[test]
    fn bg_thumb_file_is_16x9_and_rebuilds_on_change() {
        let s = temp_store("bg");
        let src = s.dir.join("shot.png");
        write_cover(&src, [40, 90, 160]); // 120×160 竖图 → 中心裁成 16:9
        let src_s = src.to_string_lossy().to_string();
        let p = bg_thumb_file(&s, "g1", &src_s).expect("应生成背景候选缩略图");
        assert_eq!(image::open(&p).unwrap().dimensions(), BG_CAND);
        let first = std::fs::read(&p).unwrap();

        // 同名覆盖 + 时间戳更新（与 covers/<id>_bg.jpg 的真实行为一致）：必须重建
        let mut img = image::RgbImage::new(120, 160);
        for px in img.pixels_mut() {
            *px = image::Rgb([200, 30, 30]);
        }
        img.save(&src).unwrap();
        let f = std::fs::File::options().write(true).open(&src).unwrap();
        f.set_modified(SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        drop(f);
        let again = bg_thumb_file(&s, "g1", &src_s).unwrap();
        assert_eq!(again, p, "同一来源的缩略图路径必须稳定");
        assert_ne!(first, std::fs::read(&again).unwrap(), "缩略图必须重建");
        // 临时文件不能残留
        let stray: Vec<_> = std::fs::read_dir(s.thumbs_dir())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "不应残留临时文件：{stray:?}");
    }

    /// 网图候选：同一地址只解码一次，不同地址互不串图
    #[test]
    fn bg_thumb_bytes_caches_by_source_key() {
        let s = temp_store("bg-bytes");
        let src = s.dir.join("src.png");
        write_cover(&src, [10, 200, 120]);
        let bytes = std::fs::read(&src).unwrap();
        let p = bg_thumb_bytes(&s, "g2", "https://x/a.jpg", &bytes).expect("应生成缩略图");
        assert_eq!(image::open(&p).unwrap().dimensions(), BG_CAND);
        let again = bg_thumb_bytes(&s, "g2", "https://x/a.jpg", b"not an image").expect("已缓存应直接复用");
        assert_eq!(again, p);
        assert!(bg_thumb_cached(&s, "g2", "https://x/a.jpg").is_some());
        assert!(bg_thumb_cached(&s, "g2", "https://x/b.jpg").is_none());
    }

    /// 背景候选缓存按数量 LRU：只回收 bg- 前缀，作品缩略图与候选封面都不碰
    #[test]
    fn prune_bg_keeps_newest_only() {
        let s = temp_store("bg-prune");
        let dir = s.thumbs_dir();
        let total = BG_CACHE_MAX + 4;
        for i in 0..total {
            let p = dir.join(format!("bg-g-{i}.webp"));
            std::fs::write(&p, b"x").unwrap();
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(i as u64)).unwrap();
        }
        std::fs::write(dir.join("cand-1.webp"), b"x").unwrap();
        std::fs::write(dir.join("0123456789abcdef.webp"), b"x").unwrap();

        prune_bg(&s);

        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left.iter().filter(|n| n.starts_with("bg-")).count(), BG_CACHE_MAX);
        assert!(left.contains(&"cand-1.webp".to_string()));
        assert!(left.contains(&"0123456789abcdef.webp".to_string()));
        assert!(left.contains(&format!("bg-g-{}.webp", total - 1)));
    }

    /// 候选封面缓存按数量 LRU：超上限删最旧的，作品自己的缩略图一张都不许碰
    #[test]
    fn prune_candidates_keeps_newest_and_spares_game_thumbs() {
        let s = temp_store("cand-prune");
        let dir = s.thumbs_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let total = CANDIDATE_CACHE_MAX + 5;
        for i in 0..total {
            let p = dir.join(format!("cand-{i}.webp"));
            std::fs::write(&p, b"x").unwrap();
            // 序号越大越新，淘汰后应保留最后 CANDIDATE_CACHE_MAX 个
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(i as u64)).unwrap();
        }
        // 作品缩略图：前缀不同，绝不能被候选淘汰逻辑带走
        let keep = dir.join("0123456789abcdef.webp");
        std::fs::write(&keep, b"x").unwrap();

        prune_candidates(&s);

        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left.iter().filter(|n| n.starts_with("cand-")).count(), CANDIDATE_CACHE_MAX);
        assert!(left.contains(&"0123456789abcdef.webp".to_string()), "作品缩略图必须保留");
        for i in 0..5 {
            assert!(!left.contains(&format!("cand-{i}.webp")), "最旧的 5 张应被淘汰");
        }
        assert!(left.contains(&format!("cand-{}.webp", total - 1)), "最新的必须保留");
    }
}

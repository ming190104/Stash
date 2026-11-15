//! 本地封面选型：在游戏目录里挑一张最像封面的图，并裁掉四周信箱黑边。
//!
//! 全部为确定性启发式（尺寸 / 长宽比 / 边框留黑），不出网、不加载任何模型。

use std::path::{Path, PathBuf};

const IMG_EXT: [&str; 5] = ["jpg", "jpeg", "png", "webp", "bmp"];
/// 候选文件上限：大目录（含 CG 包）里不该为选一张封面遍历几万个文件
const MAX_FILES: usize = 400;

fn is_img(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMG_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 收集候选图：游戏根目录 + 一层子目录（`cover` / `image` / `img` / `cg` 命名的优先）；
/// 只收命名像封面的（cover/package/box/logo/title）与根目录里的图，避免把整包 CG 当候选。
pub fn candidates(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let hint = |n: &str| {
        let n = n.to_ascii_lowercase();
        ["cover", "package", "box", "jacket", "title", "logo", "封面"]
            .iter()
            .any(|k| n.contains(k))
    };
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if out.len() >= MAX_FILES {
                break;
            }
            let p = e.path();
            if p.is_file() && is_img(&p) {
                out.push(p);
            } else if p.is_dir() {
                let sub_hint = hint(&e.file_name().to_string_lossy());
                if let Ok(sub) = std::fs::read_dir(&p) {
                    for s in sub.flatten().take(80) {
                        if out.len() >= MAX_FILES {
                            break;
                        }
                        let sp = s.path();
                        if !sp.is_file() || !is_img(&sp) {
                            continue;
                        }
                        let nm = s.file_name().to_string_lossy().to_string();
                        if sub_hint || hint(&nm) {
                            out.push(sp);
                        }
                    }
                }
            }
        }
    }
    out
}

/// 只读图片头里的 EXIF Orientation（不解码像素）：格式不支持 / 读不到时返回 None
fn exif_orientation(p: &Path) -> Option<image::metadata::Orientation> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(p).ok()?.with_guessed_format().ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    decoder.orientation().ok()
}

/// 单张图的启发式得分：2:3 竖版最高，其次是高分辨率竖图；超宽图（截图 / 横幅）扣分
fn score_file(p: &Path) -> i32 {
    let Ok((mut w, mut h)) = image::image_dimensions(p) else {
        return i32::MIN / 2;
    };
    // 手机拍摄 / 扫描件可能带 EXIF 90° 标记：只读头信息判断方向（不整图解码），
    // 否则竖版封面会被当成「超宽横幅」扣 90 分，正确封面反而落选
    if let Some(o) = exif_orientation(p) {
        if matches!(
            o,
            image::metadata::Orientation::Rotate90
                | image::metadata::Orientation::Rotate270
                | image::metadata::Orientation::Rotate90FlipH
                | image::metadata::Orientation::Rotate270FlipH
        ) {
            std::mem::swap(&mut w, &mut h);
        }
    }
    if w < 220 || h < 220 {
        return i32::MIN / 2;
    }
    let ratio = w as f32 / h as f32;
    let shape = match ratio {
        r if (0.62..=0.72).contains(&r) => 100,
        r if (0.55..=0.80).contains(&r) => 70,
        r if r < 0.55 => 30,
        r if (0.80..=1.05).contains(&r) => 10,
        r if (1.05..=1.60).contains(&r) => -40,
        _ => -90, // 超宽：多半是游戏截图 / 宣传横幅
    };
    // 分辨率按面积的对数计分（4K 与 1000px 拉不开太大差距，够用即可）
    let px = (w as f64 * h as f64).sqrt();
    let res = ((px / 300.0).ln().max(0.0) * 18.0) as i32;
    let name = p
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let bonus = if ["cover", "package", "box", "jacket"].iter().any(|k| name.contains(k)) {
        25
    } else {
        0
    };
    shape + res + bonus
}

/// 选一张最像封面的图；没有候选返回 None。
/// 每个候选只打分一次：`score_file` 要读图片头 + EXIF，候选上限 400 张时重复调用很明显。
pub fn pick_cover(dir: &Path) -> Option<PathBuf> {
    candidates(dir)
        .into_iter()
        .map(|p| {
            let score = score_file(&p);
            (p, score)
        })
        .max_by_key(|(_, score)| *score)
        .filter(|(_, score)| *score > i32::MIN / 4)
        .map(|(p, _)| p)
}

/// 检测四周纯黑 / 纯白的信箱边框，返回裁切框 (x, y, w, h)。
/// 只裁「确实占了 12% 以上面积」的边，避免把夜景 / 黑底海报裁坏。
pub fn crop_bounds(img: &image::DynamicImage) -> Option<(u32, u32, u32, u32)> {
    let (w, h) = (img.width(), img.height());
    // 用 u64 相乘：图片头可以声明 100000×100000，u32 相乘在 debug 下会 panic、
    // 在 release 下回绕成小值，让这条「超大图不处理」的防线失效
    if w < 64 || h < 64 || (w as u64) * (h as u64) > 4096 * 4096 {
        return None;
    }
    let rgb = img.to_rgb8();
    // 行 / 列均值亮度（< 20 视为边框）
    let row_dark = |y: u32| {
        let mut sum = 0u64;
        for x in (0..w).step_by(4) {
            let p = rgb.get_pixel(x, y);
            sum += (p[0] as u64 + p[1] as u64 + p[2] as u64) / 3;
        }
        (sum as f32 / (w as f32 / 4.0).ceil()) < 20.0
    };
    let col_dark = |x: u32| {
        let mut sum = 0u64;
        for y in (0..h).step_by(4) {
            let p = rgb.get_pixel(x, y);
            sum += (p[0] as u64 + p[1] as u64 + p[2] as u64) / 3;
        }
        (sum as f32 / (h as f32 / 4.0).ceil()) < 20.0
    };
    let (mut top, mut bottom, mut left, mut right) = (0u32, h, 0u32, w);
    while top < h / 4 && row_dark(top) {
        top += 1;
    }
    while bottom > h * 3 / 4 && row_dark(bottom - 1) {
        bottom -= 1;
    }
    while left < w / 4 && col_dark(left) {
        left += 1;
    }
    while right > w * 3 / 4 && col_dark(right - 1) {
        right -= 1;
    }
    let (nw, nh) = (right.saturating_sub(left), bottom.saturating_sub(top));
    if nw < 64 || nh < 64 {
        return None;
    }
    let kept = (nw as f64 * nh as f64) / (w as f64 * h as f64);
    if !(0.60..=0.94).contains(&kept) {
        return None;
    }
    Some((left, top, nw, nh))
}

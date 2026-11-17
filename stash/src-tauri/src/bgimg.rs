//! 详情页背景图规格化：任意来源 → 16:9 / 1920×1080 / 轻锐化。
//!
//! 详情页用 `background-size: cover` 铺满：源图比例不对时浏览器只能硬裁 + 双线性放大，
//! 1280×720 的官方截图铺到 1080p 屏上就是一层糊。这里一次性处理成 16:9 1080p，
//! 前端拿到的是「正好铺满」的图，不用再缩放。

/// 目标尺寸：与主流 1080p 屏幕 1:1
pub const BG_W: u32 = 1920;
/// 目标尺寸：16:9
pub const BG_H: u32 = 1080;

/// 超过这个宽高比就按「横幅」处理（SteamGridDB hero 常见 1920×620 / 3840×1240 ≈ 3.1:1）。
/// 21:9 壁纸（2.37:1）仍走中心裁切——游戏画面主体一般居中，裁两侧没问题；
/// 而 3:1 的商店横幅主体常偏在一侧，硬裁会把人裁掉。
pub const WIDE_RATIO: f32 = 2.6;

/// 是否已经是规格内的背景图（避免每次进详情都重新编码）
pub fn is_bg_spec(path: &std::path::Path) -> bool {
    image::image_dimensions(path)
        .map(|(w, h)| w == BG_W && h == BG_H)
        .unwrap_or(false)
}

/// 居中裁成 16:9 → Lanczos3 缩放到 1920×1080 → 3×3 轻锐化。
/// 裁切是「从中间取最大 16:9 区域」，不做拉伸，所以不会变形。
/// 超宽横幅（≥ `WIDE_RATIO`）改走 `compose_wide`，不裁画面。
pub fn prepare(src: &image::DynamicImage) -> image::RgbImage {
    let (w, h) = (src.width(), src.height());
    let target = BG_W as f32 / BG_H as f32;
    let ratio = w as f32 / h.max(1) as f32;
    if ratio >= WIDE_RATIO {
        return compose_wide(src);
    }
    let cropped = if ratio > target {
        // 太宽：裁两侧
        let nw = ((h as f32 * target).round() as u32).clamp(1, w);
        src.crop_imm((w - nw) / 2, 0, nw, h)
    } else if ratio < target {
        // 太高：裁上下
        let nh = ((w as f32 / target).round() as u32).clamp(1, h);
        src.crop_imm(0, (h - nh) / 2, w, nh)
    } else {
        src.clone()
    };
    let resized = cropped
        .resize_exact(BG_W, BG_H, image::imageops::FilterType::Lanczos3)
        .to_rgb8();
    sharpen(&resized)
}

/// 超宽横幅：按宽度铺满、原比例缩放后居中摆在 16:9 画布上，
/// 上下留白用同一张图重度模糊 + 压暗补齐 —— 画面一点不丢，也不会有生硬黑边。
fn compose_wide(src: &image::DynamicImage) -> image::RgbImage {
    let (w, h) = (src.width(), src.height());
    // 底：整图压到画布大小再模糊，压暗到 45% 以免抢前景
    let blur = image::imageops::blur(
        &src.resize_exact(BG_W, BG_H, image::imageops::FilterType::Triangle)
            .to_rgb8(),
        32.0,
    );
    let mut canvas = image::RgbImage::from_fn(BG_W, BG_H, |x, y| {
        let p = blur.get_pixel(x, y);
        image::Rgb([
            (p[0] as f32 * 0.45) as u8,
            (p[1] as f32 * 0.45) as u8,
            (p[2] as f32 * 0.45) as u8,
        ])
    });
    // 前景：按宽度铺满，保持原比例（3:1 的横幅在 1080p 画布上高 620 左右）
    let fh = ((BG_W as f32) * h as f32 / w.max(1) as f32)
        .round()
        .clamp(1.0, BG_H as f32) as u32;
    let fg = sharpen(
        &src.resize_exact(BG_W, fh, image::imageops::FilterType::Lanczos3)
            .to_rgb8(),
    );
    image::imageops::overlay(&mut canvas, &fg, 0, ((BG_H - fh) / 2) as i64);
    canvas
}

/// 放大后边缘会发虚，这一步把观感拉回来（系数很轻，不会出白边）
fn sharpen(img: &image::RgbImage) -> image::RgbImage {
    image::imageops::filter3x3(img, &[0.0, -0.5, 0.0, -0.5, 3.0, -0.5, 0.0, -0.5, 0.0])
}

/// 解码后像素数上限：80MP ≈ 320MB RGB。24MB 的压缩图理论上能解出上 GB 位图，
/// 超过这个量级一定是异常来源（或解压炸弹），直接拒绝而不是把内存打满。
const MAX_PIXELS: u64 = 80_000_000;

/// 网络下载的字节 → 规格化 → 存 JPEG（q90）
pub fn write_from_bytes(bytes: &[u8], dst: &std::path::Path) -> Result<(), String> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes));
    let reader = reader.with_guessed_format().map_err(|e| e.to_string())?;
    let decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = image::ImageDecoder::dimensions(&decoder);
    if w as u64 * h as u64 > MAX_PIXELS {
        return Err(format!("图片尺寸过大（{w}×{h}），已放弃处理"));
    }
    let img = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    write_prepared(prepare(&img), dst)
}

/// 本地文件 → 规格化 → 存 JPEG（q90）
pub fn write_from_file(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    // 只读文件头拿尺寸，先挡掉解压炸弹再真正解码
    let (w, h) = image::image_dimensions(src).map_err(|e| e.to_string())?;
    if w as u64 * h as u64 > MAX_PIXELS {
        return Err(format!("图片尺寸过大（{w}×{h}），已放弃处理"));
    }
    let img = image::open(src).map_err(|e| e.to_string())?;
    write_prepared(prepare(&img), dst)
}

/// 临时文件名序号：只用 pid 命名时，同一进程内并发写同一个 dst 会互相截断，
/// rename 后可能落下一份半截图。序号保证每次写的临时文件互不相同。
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn write_prepared(buf: image::RgbImage, dst: &std::path::Path) -> Result<(), String> {
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // 先写临时文件再改名：写到一半失败不会留下损坏的缓存
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "bg.jpg".into());
    let tmp = dst.with_file_name(format!("{name}.{}-{seq}.tmp", std::process::id()));
    let fail = |e: String| {
        let _ = std::fs::remove_file(&tmp);
        e
    };
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| fail(e.to_string()))?;
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 90)
            .encode_image(&buf)
            .map_err(|e| fail(e.to_string()))?;
    }
    std::fs::rename(&tmp, dst).map_err(|e| fail(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32) -> image::DynamicImage {
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(w, h, image::Rgb([90, 120, 160])))
    }

    #[test]
    fn portrait_source_is_cropped_to_16x9() {
        let out = prepare(&solid(600, 800));
        assert_eq!((out.width(), out.height()), (BG_W, BG_H));
    }

    #[test]
    fn ultra_wide_source_is_cropped_to_16x9() {
        // 21:9 之类的超宽图同样只裁两侧，不拉伸
        let out = prepare(&solid(2560, 1080));
        assert_eq!((out.width(), out.height()), (BG_W, BG_H));
    }

    #[test]
    fn four_three_source_is_cropped_top_bottom() {
        let out = prepare(&solid(1280, 960));
        assert_eq!((out.width(), out.height()), (BG_W, BG_H));
    }

    #[test]
    fn steam_banner_keeps_whole_width() {
        // 3.1:1 的商店横幅（1920×620 / 3840×1240）：左右两半染色，
        // 验证改成「横幅」处理后两侧都没被裁掉，上下是模糊填充而不是黑边
        let mut img = image::RgbImage::from_pixel(3100, 1000, image::Rgb([200, 30, 30]));
        for (x, _, p) in img.enumerate_pixels_mut() {
            if x >= 1550 {
                *p = image::Rgb([30, 30, 200]);
            }
        }
        let out = prepare(&image::DynamicImage::ImageRgb8(img));
        assert_eq!((out.width(), out.height()), (BG_W, BG_H));
        let left = out.get_pixel(4, BG_H / 2);
        let right = out.get_pixel(BG_W - 5, BG_H / 2);
        assert!(left[0] > left[2], "左侧应保留横幅左半（红）");
        assert!(right[2] > right[0], "右侧应保留横幅右半（蓝）");
        let top = out.get_pixel(BG_W / 2, 2);
        let sum = top[0] as u32 + top[1] as u32 + top[2] as u32;
        assert!(sum > 30, "上下应是同图的模糊填充，不是黑边（{sum}）");
    }

    #[test]
    fn writes_jpeg_and_reports_spec() {
        let dir = std::env::temp_dir().join(format!("vn_bg_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let src = dir.join("src.png");
        solid(800, 600).save(&src).unwrap();
        let dst = dir.join("out.jpg");
        write_from_file(&src, &dst).unwrap();
        assert!(is_bg_spec(&dst));
        assert!(!is_bg_spec(&src));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

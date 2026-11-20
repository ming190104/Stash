//! 图片下载与落盘：封面原图、候选 / 背景图，含大小上限与先写临时文件再改名。

use crate::models::{AppError, ErrCode, Settings};
use crate::store::Store;

use super::client::{check_remote_url, download_client, wait_turn, Gate};

/// 取一张网图：返回 (字节, 扩展名)。`what` 只用于错误文案。
/// 走 1 req/s 串行闸门（封面 / 背景这类单张下载）。
pub(crate) fn fetch_image(
    settings: &Settings,
    url: &str,
    what: &str,
) -> Result<(Vec<u8>, String), AppError> {
    fetch_image_inner(settings, url, what, true)
}

/// 取一张网图，**不共用 API 的 1 req/s 闸门**。
/// 只给候选列表这类「一次要 4–5 张小图、且图片在 CDN 上」的场景用：
/// 图片服务器与 API 不是同一套限流，串行等待会让打开候选慢好几秒。
pub(crate) fn fetch_image_direct(
    settings: &Settings,
    url: &str,
    what: &str,
) -> Result<(Vec<u8>, String), AppError> {
    fetch_image_inner(settings, url, what, false)
}

fn fetch_image_inner(
    settings: &Settings,
    url: &str,
    what: &str,
    throttled: bool,
) -> Result<(Vec<u8>, String), AppError> {
    // 图片地址来自远端元数据：不限协议 / 主机的话，恶意条目能让客户端去访问内网
    // （SSRF 面），也能用 file:// 之类读本地文件。放在最前面，避免任何请求发出。
    check_remote_url(url, "图片")?;
    let c = download_client(settings)?;
    let _turn = if throttled { Some(wait_turn(Gate::Image)) } else { None };
    let resp = c
        .get(url)
        .send()
        .map_err(|e| AppError::new(ErrCode::NetworkOffline, e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AppError::new(
            ErrCode::NetworkOffline,
            format!("{what}下载失败（HTTP {}）", resp.status().as_u16()),
        ));
    }
    // 原图正常只有几百 KB：超过 24MB 基本是地址配错 / 被劫持的响应，
    // 直接放弃，避免把内存打满。Content-Length 只是快路径——chunked 响应没有长度，
    // 所以下面按字节流截断读取，超限即中止（旧写法 `.bytes()` 会把整段读进内存）。
    const MAX_IMAGE_BYTES: u64 = 24 * 1024 * 1024;
    if let Some(len) = resp.content_length() {
        if len > MAX_IMAGE_BYTES {
            return Err(AppError::new(
                ErrCode::NetworkOffline,
                format!("{what}文件过大，已放弃下载"),
            ));
        }
    }
    let mut bytes = Vec::new();
    {
        use std::io::Read;
        let mut limited = resp.take(MAX_IMAGE_BYTES + 1);
        limited
            .read_to_end(&mut bytes)
            .map_err(|e| AppError::new(ErrCode::NetworkOffline, e.to_string()))?;
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(AppError::new(
            ErrCode::NetworkOffline,
            format!("{what}文件过大，已放弃下载"),
        ));
    }
    // 扩展名只认图片格式：先去掉 query / fragment（`x.png?token=…` 会把整段当成扩展名），
    // URL 末段没有点号时 `rsplit_once('.')` 也会把整段当扩展名，
    // 落下 `<id>_src.image` 这种缩略图解不出来的文件
    let ext = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .rsplit('/')
        .next()
        .and_then(|s| s.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()))
        .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp" | "bmp"))
        .unwrap_or_else(|| "jpg".into());
    Ok((bytes, ext))
}

/// 图片落盘的临时文件序号：只用 pid 时，同一作品并发两次换封面（连点 / 匹配与手动同时跑）
/// 会撞同一个 `.tmp`，后一次 rename 直接报 IO 错
static IMG_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 落盘到 covers/<id><suffix>.<ext>：先写临时文件再改名，成功后才清同前缀旧图
fn save_image(
    store: &Store,
    game_id: &str,
    suffix: &str,
    bytes: &[u8],
    ext: &str,
) -> Result<String, AppError> {
    let dir = store.covers_dir();
    let path = dir.join(format!("{game_id}{suffix}.{ext}"));
    let seq = IMG_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(
        "{game_id}{suffix}.{ext}.{}.{seq}.tmp",
        std::process::id()
    ));
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    // 扩展名随 URL 变化：同一作品换到另一张图时旧的 <id><suffix>.* 会变成孤儿
    crate::prune_prefixed(&dir, &format!("{game_id}{suffix}."), Some(path.as_path()));
    Ok(path.to_string_lossy().to_string())
}

/// 下载封面原图到 covers/<id>_src.<ext>，返回本地路径（两档 WebP 由 thumb::ensure 生成）。
/// 封面在图片 CDN 上、与 API 不是同一套限流：走 `fetch_image_direct`，
/// 否则批量匹配时每张封面（实测 3–9s）都会把 Bangumi / 萌娘百科的请求堵在闸门外。
pub fn download_cover(
    settings: &Settings,
    store: &Store,
    game_id: &str,
    url: &str,
) -> Result<String, AppError> {
    let (bytes, ext) = fetch_image_direct(settings, url, "封面")?;
    save_image(store, game_id, "_src", &bytes, &ext)
}

#[cfg(test)]
mod tests {
    use super::check_remote_url;

    #[test]
    fn rejects_local_and_private_urls() {
        for url in [
            "file:///C:/Windows/win.ini",
            "ftp://example.com/a.png",
            "http://127.0.0.1/a.png",
            "http://[::1]/a.png",
            "http://[::ffff:127.0.0.1]/a.png",
            "http://[::ffff:192.168.1.2]/a.png",
            "http://localhost/a.png",
            "http://foo.localhost/a.png",
            "http://router.local/a.png",
            "http://192.168.1.2/a.png",
            "http://10.0.0.5/a.png",
            "http://169.254.1.1/a.png",
            "http://0.0.0.0/a.png",
        ] {
            assert!(check_remote_url(url, "图片").is_err(), "必须拒绝：{url}");
        }
    }

    #[test]
    fn allows_public_https_urls() {
        for url in [
            "https://lain.bgm.tv/pic/cover/l/ab/cd/123.jpg",
            "http://img.example.com/a.png",
            "https://8.8.8.8/a.png",
        ] {
            assert!(check_remote_url(url, "图片").is_ok(), "必须允许：{url}");
        }
    }
}

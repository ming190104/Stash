//! 更新检查（设置 · 关于）与外部链接打开。
//!
//! 前端 CSP 的 connect-src 只放行 ipc，网页里 fetch GitHub 会被直接拦掉，
//! 所以版本查询必须由 Rust 侧发。只做「查最新 Release → 提示 → 浏览器下载」，
//! 不做静默下载 / 自替换：没有签名与发布管线，自动安装的风险高于收益。

use crate::models::{AppError, ErrCode};
use crate::net;
use crate::store::Store;
use serde::Serialize;
use tauri::State;

/// 发布仓库（owner/repo）
const REPO: &str = "zhao1171921108-cyber/Stash";
const API: &str = "https://api.github.com";
/// 仓库还没有 Release / 接口异常时的兜底落点
const RELEASES: &str = "https://github.com/zhao1171921108-cyber/Stash/releases";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 当前程序版本（CARGO_PKG_VERSION，与安装包一致）
    current: String,
    /// 最新 Release 的 tag（去掉前缀 v）
    latest: String,
    /// 下载页：只接受 github.com 的 https 链接，其余回落仓库 releases
    url: String,
    newer: bool,
}

#[derive(serde::Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    html_url: String,
}

/// 版本号比较：忽略前缀 v，只比前三段数字。
/// 必须按数值比（1.0.10 > 1.0.9），字符串比较会把 10 判成比 9 小。
fn is_newer(latest: &str, current: &str) -> bool {
    fn parts(v: &str) -> [u64; 3] {
        let mut out = [0; 3];
        for (i, seg) in v
            .trim()
            .trim_start_matches(['v', 'V'])
            .split(['.', '-', '+'])
            .take(3)
            .enumerate()
        {
            let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
            out[i] = digits.parse().unwrap_or(0);
        }
        out
    }
    parts(latest) > parts(current)
}

#[tauri::command]
pub async fn check_update(store: State<'_, Store>) -> Result<UpdateInfo, AppError> {
    // 走与元数据同一套客户端：UA / 系统代理 / 超时一致，用户填的代理也能用上
    let settings = store.load_settings();
    tauri::async_runtime::spawn_blocking(move || {
        let resp = net::client(&settings)?
            .get(format!("{API}/repos/{REPO}/releases/latest"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|e| net::network_err(e, "更新检查"))?;
        let status = resp.status();
        // 404 = 仓库还没有发布过 Release：不是错误操作，明确告诉用户而不是报「已是最新」
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(AppError::new(ErrCode::NotFound, "仓库还没有发布 Release 版本"));
        }
        if !status.is_success() {
            // 403 是最常见的失败：未登录接口有 60 次/小时限流，国内网络也常被网关直接挡
            let (code, msg) = if status == reqwest::StatusCode::FORBIDDEN {
                (
                    ErrCode::RateLimited,
                    "GitHub 接口拒绝访问（HTTP 403）：可能触发限流或被网络拦截".to_string(),
                )
            } else {
                (
                    ErrCode::ServerError,
                    format!("更新检查失败：GitHub 返回 HTTP {}", status.as_u16()),
                )
            };
            return Err(AppError::new(code, msg));
        }
        let rel: Release = net::read_json_limited(resp, "更新检查")?;
        let current = env!("CARGO_PKG_VERSION").to_string();
        let tag = rel.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
        let newer = !tag.is_empty() && is_newer(&tag, &current);
        let url = if rel.html_url.starts_with("https://github.com/") {
            rel.html_url
        } else {
            RELEASES.to_string()
        };
        Ok(UpdateInfo {
            // tag 缺失时按当前版本显示，前端只会看到「已是最新」
            latest: if tag.is_empty() { current.clone() } else { tag },
            current,
            url,
            newer,
        })
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, format!("更新检查任务异常：{e}")))?
}

/// 用系统默认浏览器打开链接。只放行 http(s)：避免前端拼出 file:// 或 javascript:
/// 让系统执行本地文件。rundll32 直连协议处理器，不经过 shell，省掉引号 / 转义问题。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), AppError> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err(AppError::new(
            ErrCode::ConfigInvalid,
            "只允许打开 http / https 链接",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 与 explorer 同口径：固定系统目录，避免 PATH 被塞同名程序劫持
        let exe = std::env::var("SystemRoot")
            .map(|r| format!(r"{r}\System32\rundll32.exe"))
            .unwrap_or_else(|_| r"C:\Windows\System32\rundll32.exe".to_string());
        std::process::Command::new(exe)
            .arg("url.dll,FileProtocolHandler")
            .arg(u)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| AppError::new(ErrCode::IoError, format!("打开链接失败：{e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("1.0.2", "1.0.1"));
        assert!(is_newer("1.1.0", "1.0.9"));
        assert!(is_newer("2.0.0", "1.9.9"));
        // 两位 / 三位数字必须按数值比，不能落到字符串比较
        assert!(is_newer("1.0.10", "1.0.9"));
        assert!(!is_newer("1.0.9", "1.0.10"));
        assert!(!is_newer("1.0.1", "1.0.1"));
        assert!(!is_newer("1.0.0", "1.0.1"));
    }

    #[test]
    fn tolerates_prefix_and_suffix() {
        assert!(is_newer("v1.2.0", "1.0.1"));
        assert!(is_newer(" 1.2.0 ", "1.0.1"));
        // 预发布后缀只取数字段：1.1.0-beta 视为 1.1.0
        assert!(is_newer("v1.1.0-beta.2", "1.0.1"));
        assert!(!is_newer("", "1.0.1"));
        assert!(!is_newer("not-a-version", "1.0.1"));
    }
}

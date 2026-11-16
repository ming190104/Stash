//! 外部链接打开（关于 · 检查更新的兜底出口）。
//!
//! 查版本 / 下载 / 安装都交给 `tauri-plugin-updater`：它按配置里的 endpoint 拉
//! `latest.json`，用内置公钥校验 ed25519 签名后静默安装。插件检查失败（国内网络
//! 拦截、仓库还没发 Release）时，前端用这里打开 Releases 页让用户手动下载。

use crate::models::{AppError, ErrCode};

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

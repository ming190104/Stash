//! M8 截图：抓主屏到 `<游戏目录>/shots/capture-<ts>.png`。
//!
//! 用 PowerShell + System.Drawing 的 CopyFromScreen，零新增 Rust 依赖。
//! 独占全屏（DirectX）下可能只能抓到黑帧，这是系统限制；窗口化/无边框全屏正常。

use crate::models::{AppError, ErrCode};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};

/// 悬浮窗该落在哪块屏：跟随鼠标所在的显示器，取不到再退主窗口、最后退主显示器。
/// 只用 `primary_monitor` 的话，外接屏 / 掌机外接底座上会把窗开到另一块屏去。
pub fn monitor_box(app: &AppHandle) -> (f64, f64, f64, f64) {
    let m = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|w| w.current_monitor().ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    match m {
        Some(m) => {
            let s = m.scale_factor();
            (
                m.size().width as f64 / s,
                m.size().height as f64 / s,
                m.position().x as f64 / s,
                m.position().y as f64 / s,
            )
        }
        // 拿不到任何显示器信息：按 1280×720 基准兜底
        None => (1280.0, 720.0, 0.0, 0.0),
    }
}

/// 只用系统自带 PowerShell 的绝对路径。找不到就返回 None——
/// 退回裸名 "powershell" 会走 PATH，落地目录里塞同名 exe 就能劫持（同 iso.rs 的结论）。
fn powershell() -> Option<PathBuf> {
    std::env::var_os("SystemRoot")
        .map(|r| PathBuf::from(r).join("System32/WindowsPowerShell/v1.0/powershell.exe"))
        .filter(|p| p.is_file())
}

/// 截图落在哪块屏：优先鼠标所在显示器（游戏全屏时鼠标就在游戏里），
/// 退回主窗口所在屏，最后退回主屏。返回**物理像素**矩形（CopyFromScreen 用的就是物理像素）。
/// 只抓主屏的话，掌机接外接屏 / 游戏开在副屏时会拍到另一块屏。
pub fn capture_rect(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    let m = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|w| w.current_monitor().ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let s = m.size();
    let p = m.position();
    if s.width == 0 || s.height == 0 {
        return None;
    }
    Some((p.x, p.y, s.width as i32, s.height as i32))
}

pub fn capture(app: &AppHandle, game_dir: &str) -> Result<PathBuf, AppError> {
    let shots = PathBuf::from(game_dir).join("shots");
    std::fs::create_dir_all(&shots)?;
    // 毫秒时间戳：连点 / 连拍不会互相覆盖
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = shots.join(format!("capture-{ts}.png"));
    let escaped = out.to_string_lossy().replace('\'', "''");
    let script = match capture_rect(app) {
        Some((x, y, w, h)) => format!(
            "Add-Type -AssemblyName System.Drawing;\
             $b=[System.Drawing.Rectangle]::new({x},{y},{w},{h});\
             $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;\
             $g=[System.Drawing.Graphics]::FromImage($bmp);\
             $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);\
             $bmp.Save('{escaped}',[System.Drawing.Imaging.ImageFormat]::Png);\
             $g.Dispose();$bmp.Dispose()"
        ),
        // 拿不到显示器信息时退回主屏（旧行为）
        None => format!(
            "Add-Type -AssemblyName System.Drawing,System.Windows.Forms;\
             $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;\
             $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;\
             $g=[System.Drawing.Graphics]::FromImage($bmp);\
             $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);\
             $bmp.Save('{escaped}',[System.Drawing.Imaging.ImageFormat]::Png);\
             $g.Dispose();$bmp.Dispose()"
        ),
    };
    let ps = powershell()
        .ok_or_else(|| AppError::new(ErrCode::IoError, "找不到系统 PowerShell（SystemRoot 异常），无法截图"))?;
    let mut c = std::process::Command::new(ps);
    c.args(["-NoProfile", "-NonInteractive", "-STA", "-Command"]).arg(script);
    c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = c
        .spawn()
        .map_err(|e| AppError::new(ErrCode::IoError, format!("调用截图脚本失败：{e}")))?;
    // 脚本正常 <1s；卡住时不能把 IPC 线程一直占着
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(60)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&out);
                return Err(AppError::new(ErrCode::IoError, "截图脚本超时"));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&out);
                return Err(AppError::new(ErrCode::IoError, format!("等待截图脚本失败：{e}")));
            }
        }
    };
    if !status.success() || !out.is_file() {
        let _ = std::fs::remove_file(&out);
        return Err(AppError::new(
            ErrCode::IoError,
            "截图失败（独占全屏下可能只能抓到黑帧）",
        ));
    }
    tracing::info!("screenshot: {}", out.display());
    Ok(out)
}

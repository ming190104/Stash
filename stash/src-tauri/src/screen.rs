//! 显示器几何信息：为悬浮窗选择鼠标所在的屏幕。

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

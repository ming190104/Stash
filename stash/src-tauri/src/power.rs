//! P3 深度省电：把系统刷新率切到 60Hz。
//!
//! 只改「当前分辨率 + 色深」已经存在的 60Hz 模式，不自己拼 DEVMODE；
//! 退出应用时还原到开启前的刷新率。切换瞬间会黑屏 1–2 秒，所以设置页默认关。

use crate::models::{AppError, ErrCode};

#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::Mutex;
#[cfg(windows)]
use windows_sys::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsW, EnumDisplaySettingsW, CDS_FULLSCREEN, DEVMODEW,
    DISP_CHANGE_SUCCESSFUL, ENUM_CURRENT_SETTINGS,
};

/// 开启前的完整显示模式（宽 / 高 / 色深 / 刷新率）；None = 尚未记录（没开过省电）
#[cfg(windows)]
static ORIG: Mutex<Option<(u32, u32, u32, u32)>> = Mutex::new(None);

/// 「已锁 60Hz」标记文件。正常退出走 RunEvent::Exit 还原后删掉；
/// 崩溃 / 任务管理器强杀时那段代码跑不到，下次启动凭它在建窗口前还原。
#[cfg(windows)]
static MARKER: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 告诉省电模块「已锁定」标记写在哪（应用数据目录）
#[cfg(windows)]
pub fn set_marker_dir(dir: &Path) {
    *MARKER.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.join("power-restore.json"));
}

#[cfg(not(windows))]
pub fn set_marker_dir(_dir: &std::path::Path) {}

/// 当前配置的标记文件路径；未配置（测试环境 / 非 Windows）返回 None
#[cfg(windows)]
fn marker_path() -> Option<PathBuf> {
    MARKER.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 把「原显示模式」写到指定路径。
///
/// 返回 Err 时调用方**不应**切换显示模式：否则一旦写盘失败（磁盘满、目录只读），
/// 切换后就再也没人知道原来的刷新率，崩溃 / 强杀会把用户永久锁在 60Hz。
pub(crate) fn write_marker_to(
    p: &std::path::Path,
    mode: (u32, u32, u32, u32),
) -> Result<(), AppError> {
    let (w, h, bits, hz) = mode;
    let json = format!("{{\"w\":{w},\"h\":{h},\"bits\":{bits},\"hz\":{hz}}}");
    std::fs::write(p, json).map_err(|e| {
        AppError::new(ErrCode::IoError, format!("写入刷新率还原标记失败：{e}"))
    })
}

#[cfg(windows)]
fn clear_marker() {
    let Some(p) = MARKER.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
        return;
    };
    let _ = std::fs::remove_file(p);
}

/// 上次是崩溃 / 强杀退出时，把刷新率还原（在建窗口之前调用）。
pub fn restore_pending() {
    #[cfg(windows)]
    {
        let Some(p) = MARKER.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(&p) else {
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            tracing::warn!("power: 还原标记损坏，丢弃");
            clear_marker();
            return;
        };
        let num = |k: &str| v.get(k).and_then(|x| x.as_u64()).map(|x| x as u32);
        let (Some(w), Some(h), Some(bits), Some(hz)) = (num("w"), num("h"), num("bits"), num("hz"))
        else {
            clear_marker();
            return;
        };
        if current_hz() == hz {
            // 已经是原模式（上次其实还原成功了）：只清标记
            clear_marker();
            return;
        }
        match find_mode(w, h, bits, hz) {
            Some(mode) => match change(&mode) {
                Ok(()) => {
                    tracing::info!("power: 上次未正常退出，已还原到 {w}x{h}@{hz}Hz");
                    clear_marker();
                }
                Err(e) => tracing::warn!("power: 启动还原失败：{}", e.message),
            },
            None => {
                tracing::warn!("power: 启动还原失败：原模式 {w}x{h}@{hz}Hz 已不存在");
                clear_marker();
            }
        }
    }
}

#[cfg(windows)]
fn current_mode() -> Option<DEVMODEW> {
    unsafe {
        let mut dm: DEVMODEW = std::mem::zeroed();
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut dm) == 0 {
            return None;
        }
        Some(dm)
    }
}

#[cfg(windows)]
fn current_hz() -> u32 {
    current_mode().map(|m| m.dmDisplayFrequency).unwrap_or(0)
}

/// 在全部模式里找「指定分辨率 + 色深 + 刷新率」；找不到返回 None（绝不硬切）
#[cfg(windows)]
fn find_mode(w: u32, h: u32, bits: u32, hz: u32) -> Option<DEVMODEW> {
    unsafe {
        let mut i = 0u32;
        loop {
            let mut dm: DEVMODEW = std::mem::zeroed();
            dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
            if EnumDisplaySettingsW(std::ptr::null(), i, &mut dm) == 0 {
                return None;
            }
            if dm.dmPelsWidth == w
                && dm.dmPelsHeight == h
                && dm.dmBitsPerPel == bits
                && dm.dmDisplayFrequency == hz
            {
                return Some(dm);
            }
            i += 1;
        }
    }
}

#[cfg(windows)]
fn change(mode: &DEVMODEW) -> Result<(), AppError> {
    let rc = unsafe { ChangeDisplaySettingsW(mode, CDS_FULLSCREEN) };
    if rc != DISP_CHANGE_SUCCESSFUL {
        return Err(AppError::new(ErrCode::IoError, format!("切换显示模式失败（错误码 {rc}）")));
    }
    Ok(())
}

/// 开/关 60Hz 省电，返回切换后的实际刷新率。
pub fn apply(enabled: bool) -> Result<u32, AppError> {
    #[cfg(windows)]
    {
        if enabled {
            let cur = current_mode().ok_or_else(|| {
                AppError::new(ErrCode::IoError, "读取当前显示模式失败")
            })?;
            // 先确认当前分辨率确实有 60Hz 模式，再落盘、再切：没有就直接报错，
            // 不会留下一条「原模式」记录让退出时白切一次屏
            let mode = find_mode(cur.dmPelsWidth, cur.dmPelsHeight, cur.dmBitsPerPel, 60)
                .ok_or_else(|| {
                    AppError::new(ErrCode::ConfigInvalid, "当前分辨率没有 60Hz 模式")
                })?;
            // 记录完整分辨率：只记刷新率的话，插拔底座/改分辨率后就还原不回去。
            // 只在**第一次**锁定时记录：重复 apply(true) 时 cur 已经是 60Hz，
            // 再写一次就会把「原刷新率」覆盖成 60——崩溃后重启会认为已经还原、
            // 删掉标记，用户被永久锁在 60Hz。
            let first_time = ORIG.lock().unwrap_or_else(|e| e.into_inner()).is_none();
            let snapshot = (
                cur.dmPelsWidth,
                cur.dmPelsHeight,
                cur.dmBitsPerPel,
                cur.dmDisplayFrequency,
            );
            if first_time {
                // 先落盘再切换：写盘失败（磁盘满 / 目录只读）就绝不切，
                // 否则切完之后没人知道原刷新率，强杀就永久锁在 60Hz。
                if let Some(p) = marker_path() {
                    write_marker_to(&p, snapshot)?;
                }
            }
            change(&mode)?;
            {
                let mut orig = ORIG.lock().unwrap_or_else(|e| e.into_inner());
                if orig.is_none() {
                    *orig = Some(snapshot);
                }
            }
            tracing::info!("power: display locked to 60Hz");
            Ok(60)
        } else {
            restore(); // 只有真正锁过 60Hz 才会切回去并打日志
            Ok(current_hz())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err(AppError::new(ErrCode::ConfigInvalid, "刷新率切换仅支持 Windows"))
    }
}

/// 退出时还原完整模式（分辨率 + 色深 + 刷新率）。没开过省电就什么都不做。
pub fn restore() {
    #[cfg(windows)]
    {
        let orig = {
            let mut g = ORIG.lock().unwrap_or_else(|e| e.into_inner());
            g.take()
        };
        let Some((w, h, bits, hz)) = orig else {
            return;
        };
        let Some(mode) = find_mode(w, h, bits, hz) else {
            // 原模式已被移除（驱动更新/显示器更换）：保留记录，等下次再试，绝不乱切
            tracing::warn!("power: restore failed: 原模式 {w}x{h}@{hz}Hz 不存在");
            *ORIG.lock().unwrap_or_else(|e| e.into_inner()) = orig;
            return;
        };
        match change(&mode) {
            Ok(()) => {
                tracing::info!("power: display restored to {w}x{h}@{hz}Hz");
                clear_marker();
            }
            Err(e) => {
                tracing::warn!("power: restore failed: {}", e.message);
                *ORIG.lock().unwrap_or_else(|e| e.into_inner()) = orig;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_persistence_reports_failure() {
        let root = std::env::temp_dir().join(format!("stash-power-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let marker = root.join("power-restore.json");
        write_marker_to(&marker, (1920, 1080, 32, 144)).unwrap();
        assert!(std::fs::read_to_string(&marker).unwrap().contains("144"));
        let blocked = root.join("blocked");
        std::fs::create_dir_all(&blocked).unwrap();
        assert!(write_marker_to(&blocked, (1920, 1080, 32, 144)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

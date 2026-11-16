//! 跨模块共用的 Win32 原生调用（P35：全屏时隐藏任务栏）。
//!
//! Win11 的新任务栏常驻 TOPMOST：无边框全屏窗口既不被系统识别为真全屏，
//! Shell 官方的 `ITaskbarList2::MarkFullscreenWindow` 也已实测无效
//! （2026-10-28 探针验证：前台 + 铺满整屏 + 标记成功，任务栏矩形与工作区
//! 纹丝不动）。改用 `SHAppBarMessage(ABM_SETSTATE)`：进入全屏时把任务栏
//! 临时切成「自动隐藏」（真正滑出屏幕，全屏铺满整屏），退出全屏 / 退出应用
//! 时还原成用户原本的状态；用户本来就开了自动隐藏则完全不碰。
//!
//! 崩溃 / 强杀兜底与 power.rs 同一套路：切换成功即写 `taskbar-restore.json`
//! 标记，正常退出删掉；下次启动发现标记还在就先还原，不让任务栏被永久
//! 留在自动隐藏状态。

#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::Mutex;
#[cfg(windows)]
use windows_sys::Win32::Foundation::HWND;
#[cfg(windows)]
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{
    SHAppBarMessage, ABM_GETSTATE, ABM_SETSTATE, ABS_AUTOHIDE, APPBARDATA,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetWindowLongW, GetWindowPlacement, GetWindowRect, SetWindowPos, ShowWindow,
    GWL_STYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_RESTORE,
    SW_SHOW, SW_SHOWMAXIMIZED, WINDOWPLACEMENT, WS_CAPTION,
};

/// 切换前的任务栏状态与当时的主窗口句柄；None = 本次没有切过
#[cfg(windows)]
static ORIG: Mutex<Option<(usize, isize)>> = Mutex::new(None);

/// 全屏贴边的延迟任务是否还该执行（退出全屏时置 false）
#[cfg(windows)]
static FIT_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 「已切自动隐藏」标记文件（与 power-restore.json 同目录）
#[cfg(windows)]
static MARKER: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 告诉任务栏模块「已切换」标记写在哪（应用数据目录）
pub fn set_marker_dir(dir: &Path) {
    #[cfg(windows)]
    {
        *MARKER.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.join("taskbar-restore.json"));
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
    }
}

#[cfg(windows)]
fn marker_path() -> Option<PathBuf> {
    MARKER.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(windows)]
fn write_marker(state: usize) {
    if let Some(p) = marker_path() {
        if let Err(e) = std::fs::write(&p, format!("{{\"state\":{state}}}")) {
            tracing::warn!("全屏：写任务栏还原标记失败：{e}");
        }
    }
}

#[cfg(windows)]
fn clear_marker() {
    if let Some(p) = marker_path() {
        let _ = std::fs::remove_file(p);
    }
}

/// 读当前任务栏状态（ABM_GETSTATE；读不到返回 usize::MAX）
#[cfg(windows)]
fn get_state() -> usize {
    unsafe {
        let mut abd: APPBARDATA = std::mem::zeroed();
        abd.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
        SHAppBarMessage(ABM_GETSTATE, &mut abd)
    }
}

/// 把任务栏状态整体设为 state（ABS_ 位组合）
#[cfg(windows)]
fn set_state(hwnd: isize, state: usize) {
    unsafe {
        let mut abd: APPBARDATA = std::mem::zeroed();
        abd.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
        abd.hWnd = hwnd as *mut core::ffi::c_void;
        abd.lParam = state as isize;
        SHAppBarMessage(ABM_SETSTATE, &mut abd);
    }
}

/// 进入全屏时该不该（重新）写还原标记。
///
/// 只有第一次进入才写：此时 `state` 是用户真正的原始状态。重复进入时
/// 任务栏已经被切成 ABS_AUTOHIDE，再写一次就把「原始状态」覆盖成自动隐藏，
/// 崩溃 / 强杀后下次启动会「还原」成隐藏——用户的任务栏被永久藏起来。
#[cfg(windows)]
fn marker_for_enter(orig: &Option<(usize, isize)>, state: usize) -> Option<usize> {
    if orig.is_some() {
        None
    } else {
        Some(state)
    }
}

/// 进入 / 退出全屏时同步任务栏状态。
///
/// 进入：用户没开自动隐藏才切换（他自己的设置绝不被覆盖）；
/// 退出：只有本次真切过才还原（restore 幂等，没切过就是空操作）。
#[cfg(windows)]
pub fn fullscreen_taskbar(hwnd: isize, on: bool) {
    if on {
        let cur = get_state();
        // 用户本来就开着自动隐藏：全屏天然铺满，不碰系统设置，退出也不用还原。
        // 这种情况不写标记：崩溃兜底靠 restore_pending 里的 show_shell_tray，
        // 写标记反而会在重复进入时把原始状态覆盖掉。
        if cur & ABS_AUTOHIDE as usize != 0 {
            return;
        }
        let mut orig = ORIG.lock().unwrap_or_else(|e| e.into_inner());
        // 启动预置 + 设置页开关可能连续进来两次：只记第一次的原状态
        if let Some(mark) = marker_for_enter(&orig, cur) {
            // 先落盘再改系统状态：中途崩溃也能凭标记还原
            write_marker(mark);
            set_state(hwnd, ABS_AUTOHIDE as usize);
            *orig = Some((cur, hwnd));
            tracing::info!("全屏：任务栏已临时切为自动隐藏（原状态 {cur}）");
        }
    } else {
        restore();
    }
}

#[cfg(not(windows))]
pub fn fullscreen_taskbar(_hwnd: isize, _on: bool) {}

/// 把窗口硬贴到显示器物理边界（`rcMonitor`，含任务栏占用的那条）。
///
/// 掌机实测（1920×1080 / 150% / 任务栏停靠右侧）：`set_fullscreen` 之后任务栏
/// 切成自动隐藏，Explorer 重算工作区时会把窗口按旧工作区摆回 1848×1080，
/// 右侧留下一条任务栏宽的缝。这里按整块显示器再 SetWindowPos 一次。
#[cfg(windows)]
pub fn fit_fullscreen(hwnd: isize) {
    unsafe {
        let h = hwnd as HWND;

        // 已经退出全屏（窗口恢复标题栏）就别再撑大：延迟贴边任务可能正好落在退出之后，
        // 会把 tao 刚还原的 1296×729 又推回整屏，用户就会觉得「退出全屏没反应」
        if GetWindowLongW(h, GWL_STYLE) as u32 & WS_CAPTION != 0 {
            tracing::info!("全屏：窗口已恢复装饰，跳过贴边");
            return;
        }

        // 最大化过的窗口会被 Windows 钉死在工作区，SetWindowPos 直接被忽略：先还原
        let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        let _ = GetWindowPlacement(h, &mut wp);
        let was_max = wp.showCmd == SW_SHOWMAXIMIZED as u32;
        if was_max {
            let _ = ShowWindow(h, SW_RESTORE);
        }

        let mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            tracing::warn!("全屏：读显示器矩形失败");
            return;
        }
        let r = mi.rcMonitor;
        let mon_w = r.right - r.left;
        let mon_h = r.bottom - r.top;
        let mut before: windows_sys::Win32::Foundation::RECT = std::mem::zeroed();
        let _ = GetWindowRect(h, &mut before);
        let _ = SetWindowPos(
            h,
            HWND_TOP,
            r.left,
            r.top,
            mon_w,
            mon_h,
            SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
        // 任务栏还占着工作区（自动隐藏没生效 / 还没滑走）：直接把它藏起来，
        // 否则它是 TOPMOST，会压住全屏窗口右侧那一条。
        // 只在延迟贴边任务仍然有效时藏：restore() 之后 FIT_ON 已置 false，
        // 此时再藏任务栏会把用户刚还原的任务栏又弄消失（且没有标记可恢复）。
        let work_w = mi.rcWork.right - mi.rcWork.left;
        let work_h = mi.rcWork.bottom - mi.rcWork.top;
        if (work_w < mon_w || work_h < mon_h)
            && FIT_ON.load(std::sync::atomic::Ordering::SeqCst)
        {
            hide_shell_tray();
            // 极小概率：检查与隐藏之间用户退出了全屏，这里再补一次显示
            if !FIT_ON.load(std::sync::atomic::Ordering::SeqCst) {
                show_shell_tray();
            }
        }
        tracing::info!(
            "全屏：窗口 {}×{} → 显示器 {}×{}（工作区 {}×{}，max={}）",
            before.right - before.left,
            before.bottom - before.top,
            mon_w,
            mon_h,
            work_w,
            work_h,
            was_max
        );
    }
}

/// 直接把任务栏窗口藏掉（不改用户的自动隐藏设置；退出全屏时再显示回来）
#[cfg(windows)]
fn hide_shell_tray() {
    unsafe {
        let name: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
        let h = FindWindowW(name.as_ptr(), std::ptr::null());
        if !h.is_null() {
            let _ = ShowWindow(h, SW_HIDE);
        }
    }
}

#[cfg(windows)]
fn show_shell_tray() {
    unsafe {
        let name: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
        let h = FindWindowW(name.as_ptr(), std::ptr::null());
        if !h.is_null() {
            let _ = ShowWindow(h, SW_SHOW);
        }
    }
}

#[cfg(not(windows))]
pub fn fit_fullscreen(_hwnd: isize) {}

/// 任务栏切换 / Explorer 重算工作区有延迟：稍后补两次，盖住那个时机。
pub fn fit_fullscreen_later(hwnd: isize) {
    #[cfg(windows)]
    {
        FIT_ON.store(true, std::sync::atomic::Ordering::SeqCst);
        std::thread::spawn(move || {
            for ms in [400u64, 1200] {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                // 这期间用户可能已经退出全屏：别再把它撑大
                if !FIT_ON.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                fit_fullscreen(hwnd);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = hwnd;
}

/// 退出全屏时取消还没执行的延迟贴边。
pub fn cancel_fit_fullscreen() {
    #[cfg(windows)]
    FIT_ON.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// 把窗口夹进当前显示器的工作区（`rcWork`，已扣掉任务栏）。
///
/// 退出全屏时 tao 还原的是进入前的矩形，掌机上实测 1232×726 比工作区 1232×720
/// 高 6px，窗口底边压到任务栏下面。这里按工作区再夹一次，位置和尺寸一起收敛。
#[cfg(windows)]
pub fn clamp_to_work(hwnd: isize) {
    unsafe {
        let h = hwnd as HWND;

        // 最大化窗口由系统钉在工作区，SetWindowPos 会被忽略，直接跳过
        let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        let _ = GetWindowPlacement(h, &mut wp);
        if wp.showCmd == SW_SHOWMAXIMIZED as u32 {
            return;
        }

        let mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return;
        }
        let r = mi.rcWork;
        let (work_w, work_h) = (r.right - r.left, r.bottom - r.top);

        let mut wr: windows_sys::Win32::Foundation::RECT = std::mem::zeroed();
        if GetWindowRect(h, &mut wr) == 0 {
            return;
        }
        let (cur_w, cur_h) = (wr.right - wr.left, wr.bottom - wr.top);
        let w = cur_w.min(work_w);
        let hh = cur_h.min(work_h);
        // 窗口几乎铺满工作区：小屏掌机从全屏退出时，tao 还原的是配置里的 1280×720，
        // 比 1024×600 的工作区还大，夹完仍是一整屏，看起来像「没退出全屏」。
        // 这种情况缩成 16:9 窗口并居中；正常桌面上还原矩形本来就小，不受影响。
        let filled = w * 100 >= work_w * 98 && hh * 100 >= work_h * 98;
        let (w, hh, x, y) = if filled {
            let tw = ((work_w as f64 * 0.86) as i32)
                .min(((work_h as f64 * 0.86) * 16.0 / 9.0) as i32);
            let th = (tw as f64 * 9.0 / 16.0).round() as i32;
            (tw, th, r.left + (work_w - tw) / 2, r.top + (work_h - th) / 2)
        } else {
            let x = wr.left.clamp(r.left, (r.right - w).max(r.left));
            let y = wr.top.clamp(r.top, (r.bottom - hh).max(r.top));
            (w, hh, x, y)
        };
        if (x, y, w, hh) == (wr.left, wr.top, cur_w, cur_h) {
            return;
        }
        let _ = SetWindowPos(h, HWND_TOP, x, y, w, hh, SWP_NOACTIVATE | SWP_NOZORDER);
        tracing::info!(
            "退出全屏：窗口 {}×{}@({},{}) → {}×{}@({},{})（工作区 {}×{}）",
            cur_w,
            cur_h,
            wr.left,
            wr.top,
            w,
            hh,
            x,
            y,
            work_w,
            work_h
        );
    }
}

#[cfg(not(windows))]
pub fn clamp_to_work(_hwnd: isize) {}

/// 退出全屏后延迟夹取：tao 还原矩形 / Explorer 重算工作区都是排队执行的，
/// 立刻 SetWindowPos 会被后到的还原覆盖。
pub fn clamp_to_work_later(hwnd: isize) {
    #[cfg(windows)]
    {
        std::thread::spawn(move || {
            for ms in [160u64, 520] {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                // 期间用户又进了全屏：不要把它夹小
                if FIT_ON.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                clamp_to_work(hwnd);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = hwnd;
}

/// 还原任务栏状态（退出全屏 / 应用退出时调用；没切过就是空操作）
pub fn restore() {
    #[cfg(windows)]
    {
        // 先取消还没执行的延迟贴边任务：否则它可能在本函数之后醒来，把任务栏又藏掉
        FIT_ON.store(false, std::sync::atomic::Ordering::SeqCst);
        let orig = ORIG.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((state, hwnd)) = orig {
            set_state(hwnd, state);
            tracing::info!("全屏：任务栏已还原（状态 {state}）");
        }
        // 全屏期间可能被直接藏掉：退出时一律显示回来（没藏过就是空操作）
        show_shell_tray();
        clear_marker();
    }
}

/// 上次崩溃 / 强杀没还原时，启动先还原任务栏（在建窗口前调用，与 power 同口径）。
pub fn restore_pending() {
    #[cfg(windows)]
    {
        let Some(p) = marker_path() else { return };
        let Ok(text) = std::fs::read_to_string(&p) else { return };
        // 上次全屏可能把任务栏直接藏了：启动先显示回来（没藏过是空操作）
        show_shell_tray();
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            tracing::warn!("全屏：任务栏还原标记损坏，丢弃");
            clear_marker();
            return;
        };
        let Some(state) = v.get("state").and_then(|x| x.as_u64()) else {
            clear_marker();
            return;
        };
        let state = state as usize;
        if get_state() == state {
            // 任务栏已经在原状态（上次其实还原成功了）：只清标记
            clear_marker();
            return;
        }
        set_state(0, state);
        clear_marker();
        tracing::info!("全屏：上次未正常退出，已把任务栏还原为状态 {state}");
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn repeated_fullscreen_does_not_replace_restore_marker() {
        let original = Some((0usize, 42isize));
        assert_eq!(marker_for_enter(&None, 0), Some(0));
        assert_eq!(marker_for_enter(&original, ABS_AUTOHIDE as usize), None);
    }
}

//! 单实例锁（Windows 命名互斥量 + 激活事件）。
//!
//! 第二个实例启动时只做一件事：给已运行实例发激活信号（主窗口还原到前台），然后退出。
//! 这样不会出现两个进程同时写 library.json、互相覆盖设置。

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// 激活信号在 bind 之前就到达：先记下，等 AppHandle 注入后立刻补一次，
    /// 否则这次双击会被无声吞掉（表现同样是「双击图标没反应」）
    static PENDING: AtomicBool = AtomicBool::new(false);

    fn activate(app: &AppHandle) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// true = 本进程是唯一实例；false = 已有实例（已通知它显示窗口，调用方应退出）
    pub fn acquire_or_activate() -> bool {
        let mutex_name = wide("Local\\Stash-Single-Instance");
        let event_name = wide("Local\\Stash-Activate");
        unsafe {
            // CreateMutexW 只在「命名互斥量已存在」时写 ERROR_ALREADY_EXISTS，新建成功时
            // 并不清零。先显式清零，避免进程里上一次 API 的残留错误被误判成「已有实例」
            SetLastError(0);
            let mutex = CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr());
            if mutex.is_null() {
                // 锁创建失败不该把用户挡在门外：按正常启动继续
                tracing::warn!("单实例锁创建失败，按正常启动继续");
                return true;
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                // 首个实例是「先建锁、后建事件」：在它还没建好事件的几百毫秒里启动第二个，
                // 打开事件会失败，激活信号就丢了（表现为双击图标毫无反应）。
                // 这里给它 1 秒时间把事件建出来。
                let mut ev = std::ptr::null_mut();
                for _ in 0..40 {
                    ev = OpenEventW(EVENT_MODIFY_STATE, 0, event_name.as_ptr());
                    if !ev.is_null() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                if ev.is_null() {
                    tracing::warn!("已有实例在运行，但取不到激活事件（对方可能刚启动）");
                } else {
                    SetEvent(ev);
                    CloseHandle(ev);
                }
                return false;
            }
            // 首个实例：建激活事件并常驻监听；互斥量句柄故意不关（进程退出时由系统回收）
            let ev = CreateEventW(std::ptr::null(), 0, 0, event_name.as_ptr());
            if ev.is_null() {
                return true;
            }
            let raw = ev as isize;
            std::thread::spawn(move || {
                let ev = raw as windows_sys::Win32::Foundation::HANDLE;
                loop {
                    if WaitForSingleObject(ev, u32::MAX) != 0 {
                        break;
                    }
                    if let Some(app) = APP.get() {
                        activate(app);
                    } else {
                        PENDING.store(true, Ordering::Relaxed);
                    }
                }
            });
            true
        }
    }

    /// setup 阶段注入 AppHandle：监听线程收到激活信号后用它把主窗口提到前台
    pub fn bind(app: &AppHandle) {
        let _ = APP.set(app.clone());
        // 监听线程在 bind 之前收到的信号：这里补一次激活
        if PENDING.swap(false, Ordering::Relaxed) {
            activate(app);
        }
    }
}

#[cfg(windows)]
pub use imp::{acquire_or_activate, bind};

#[cfg(not(windows))]
pub fn acquire_or_activate() -> bool {
    true
}

#[cfg(not(windows))]
pub fn bind(_app: &tauri::AppHandle) {}

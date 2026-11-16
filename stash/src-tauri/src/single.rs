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
        CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, HANDLE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForMultipleObjects,
        EVENT_MODIFY_STATE,
    };

    /// Local 命名空间只在当前会话唯一：RDP + 控制台双会话会各跑一份、同时写库。
    /// 两个命名空间都建，任一报「已存在」就判定为第二实例。
    const LOCAL_MUTEX: &str = "Local\\Stash-Single-Instance";
    const GLOBAL_MUTEX: &str = "Global\\Stash-Single-Instance";
    const LOCAL_EVENT: &str = "Local\\Stash-Activate";
    const GLOBAL_EVENT: &str = "Global\\Stash-Activate";

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

    /// 建命名互斥量，返回 (句柄, 是否已存在)。
    /// CreateMutexW 只在「已存在」时写 ERROR_ALREADY_EXISTS，新建成功时并不清零，
    /// 所以每次调用前显式 SetLastError(0)，避免上一次 API 的残留错误被误判。
    unsafe fn create_mutex(name: &str) -> (HANDLE, bool) {
        let w = wide(name);
        SetLastError(0);
        let h = CreateMutexW(std::ptr::null(), 0, w.as_ptr());
        let exists = !h.is_null() && GetLastError() == ERROR_ALREADY_EXISTS;
        (h, exists)
    }

    /// 通知已运行实例把窗口提到前台：两个命名空间都试（首发实例可能只建成了其中一个）
    fn notify_existing(local_event: &str, global_event: &str) {
        for name in [global_event, local_event] {
            let w = wide(name);
            unsafe {
                let mut ev = std::ptr::null_mut();
                // 首个实例是「先建锁、后建事件」：给它 1 秒把事件建出来
                for _ in 0..40 {
                    ev = OpenEventW(EVENT_MODIFY_STATE, 0, w.as_ptr());
                    if !ev.is_null() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                if !ev.is_null() {
                    SetEvent(ev);
                    CloseHandle(ev);
                    return;
                }
            }
        }
        tracing::warn!("已有实例在运行，但取不到激活事件（对方可能刚启动）");
    }

    /// true = 本进程是唯一实例；false = 已有实例（已通知它显示窗口，调用方应退出）
    pub fn acquire_or_activate() -> bool {
        acquire(LOCAL_MUTEX, GLOBAL_MUTEX, LOCAL_EVENT, GLOBAL_EVENT)
    }

    /// 带名字的单实例判定（名字参数化：测试用独立命名，避免和真实运行的实例撞名）
    fn acquire(local_mutex: &str, global_mutex: &str, local_event: &str, global_event: &str) -> bool {
        unsafe {
            let (local, local_exists) = create_mutex(local_mutex);
            let (global, global_exists) = create_mutex(global_mutex);
            if local_exists || global_exists {
                notify_existing(local_event, global_event);
                return false;
            }
            if local.is_null() && global.is_null() {
                // 锁创建失败不该把用户挡在门外，但要明确写出风险
                tracing::warn!(
                    "单实例锁创建失败（Global / Local 均不可用），按正常启动继续：可能有两个实例同时写库"
                );
                return true;
            }
            // 首个实例：两个命名空间都建激活事件，监听所有建成的；
            // 互斥量句柄故意不关（进程退出时由系统回收）
            let mut handles: Vec<isize> = Vec::new();
            for name in [global_event, local_event] {
                let w = wide(name);
                let ev = CreateEventW(std::ptr::null(), 0, 0, w.as_ptr());
                if !ev.is_null() {
                    // *mut c_void 不是 Send，传裸地址给监听线程再还原
                    handles.push(ev as isize);
                }
            }
            if handles.is_empty() {
                return true;
            }
            std::thread::spawn(move || {
                let handles: Vec<HANDLE> = handles.iter().map(|h| *h as HANDLE).collect();
                loop {
                    let r = WaitForMultipleObjects(
                        handles.len() as u32,
                        handles.as_ptr(),
                        0,
                        u32::MAX,
                    );
                    if r == u32::MAX {
                        break;
                    }
                    if let Some(app) = APP.get() {
                        activate(app);
                    } else {
                        PENDING.store(true, Ordering::Relaxed);
                        // 与 bind() 的 APP.set 竞争：若刚注入完就立刻消费，避免这次双击被吞掉
                        if let Some(app) = APP.get() {
                            if PENDING.swap(false, Ordering::Relaxed) {
                                activate(app);
                            }
                        }
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

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 同名互斥量第二次创建必须报「已存在」——双击图标时靠它阻止第二份实例写库
        #[test]
        fn second_create_reports_existing() {
            let name = "Local\\Stash-Test-Mutex";
            unsafe {
                let (first, exists) = create_mutex(name);
                assert!(!first.is_null(), "互斥量创建失败");
                assert!(!exists, "首次创建不应报已存在");
                let (second, exists) = create_mutex(name);
                assert!(!second.is_null());
                assert!(exists, "同名第二次创建应报已存在");
                CloseHandle(first);
                CloseHandle(second);
            }
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

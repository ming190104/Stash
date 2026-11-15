//! 全屏时挡住 Win 键与开始菜单（掌机防误触）。
//!
//! 背景：掌机上按手柄 A 时，系统层的键盘模拟 / 厂商工具偶尔会捎带一个 Win 键，
//! 全屏游戏库被开始菜单压住，看起来像「多出来一个窗口」。
//!
//! 两层防护，都只在本进程全屏时生效：
//! 1. `WH_KEYBOARD_LL` 低层键盘钩子：本窗口在前台时吞掉 `VK_LWIN` / `VK_RWIN`；
//!    退出全屏立即卸载（低层钩子会给每个系统按键加一次跨线程投递，能卸就卸）。
//! 2. 前台守卫：有些环境（WebView2 / 厂商工具）的钩子排在前面，Win 键可能绕过我们，
//!    于是再加一个 120ms 轮询——一旦前台变成开始菜单 / 搜索 / 任务栏，按 Esc 收起
//!    并把前台还给我们的窗口。钩子正常工作时守卫不会触发。
//!
//! 钩子**必须在主线程装**：低层钩子的回调由装钩线程的消息循环派发，放在独立线程里
//! 实测窗口切到前台后就收不到回调了（线程还在，钩子却不再触发）；主线程本来就是
//! tao 的事件循环，消息永远有人泵。
//!
//! 不新增设置项：这是掌机的基础防误触行为；窗口模式下 Win 键照常可用。

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, VK_ESCAPE, VK_LWIN, VK_RWIN};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
        SetForegroundWindow, SetWindowsHookExW, SwitchToThisWindow, UnhookWindowsHookEx,
        KBDLLHOOKSTRUCT, WH_KEYBOARD_LL,
    };

    /// 钩子回调里 `nCode == HC_ACTION` 表示正常事件（负数必须直接放行）
    const HC_ACTION: i32 = 0;
    /// 前台守卫的轮询间隔：够快（开始菜单闪一下就收）又不至于空转
    const GUARD_INTERVAL: Duration = Duration::from_millis(120);

    static ENABLED: AtomicBool = AtomicBool::new(false);
    static HOOK: Mutex<Option<isize>> = Mutex::new(None);
    /// 主窗口句柄：守卫要把前台抢回它
    static OUR_WINDOW: AtomicIsize = AtomicIsize::new(0);

    /// 启动时记下主窗口句柄
    pub fn set_window(hwnd: isize) {
        OUR_WINDOW.store(hwnd, Ordering::SeqCst);
    }

    /// 全屏状态变化时调用（主线程）：true 装钩子 + 开守卫，false 全部停下。
    pub fn set_enabled(on: bool) {
        // 先改开关：无论安装成功与否，退出全屏后都不许再吞键
        ENABLED.store(on, Ordering::SeqCst);
        let mut guard = HOOK.lock().unwrap_or_else(|e| e.into_inner());
        if on {
            ensure_shell_guard();
            if guard.is_none() {
                let hook = unsafe {
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0)
                };
                if hook.is_null() {
                    tracing::warn!(
                        "Win 键屏蔽：SetWindowsHookExW 失败：{}",
                        std::io::Error::last_os_error()
                    );
                } else {
                    *guard = Some(hook as isize);
                    tracing::info!("Win 键屏蔽：钩子已安装（全屏时生效）");
                }
            }
        } else if let Some(h) = guard.take() {
            unsafe {
                UnhookWindowsHookEx(h as *mut core::ffi::c_void);
            }
            tracing::info!("Win 键屏蔽：钩子已卸载");
        }
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION && ENABLED.load(Ordering::Relaxed) {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            let vk = kb.vkCode as u16;
            if vk == VK_LWIN || vk == VK_RWIN {
                tracing::debug!("Win 键钩子：vk={vk} flags={}", kb.flags);
                if own_foreground() {
                    return 1; // 吞掉：开始菜单 / Win 组合键都不触发
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /// 前台窗口是不是本进程：自己不在前台时不拦，用户还能用 Win 键
    fn own_foreground() -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            pid == GetCurrentProcessId()
        }
    }

    /// 开始菜单 / 搜索 / 任务栏这类 shell 界面：全屏时它们抢到前台就收回来
    fn shell_surface(hwnd: HWND) -> bool {
        unsafe {
            let mut buf = [0u16; 128];
            let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if n <= 0 {
                return false;
            }
            matches!(
                String::from_utf16_lossy(&buf[..n as usize]).as_str(),
                "Windows.UI.Core.CoreWindow"
                    | "XamlExplorerHostIslandWindow"
                    | "Shell_TrayWnd"
                    | "Shell_SecondaryTrayWnd"
            )
        }
    }

    /// 守卫线程只起一次；没进全屏时每轮直接跳过
    fn ensure_shell_guard() {
        static STARTED: OnceLock<()> = OnceLock::new();
        STARTED.get_or_init(|| {
            let spawned = std::thread::Builder::new()
                .name("shell-guard".into())
                .spawn(|| loop {
                    std::thread::sleep(GUARD_INTERVAL);
                    if !ENABLED.load(Ordering::Relaxed) {
                        continue;
                    }
                    guard_tick();
                });
            if let Err(e) = spawned {
                tracing::warn!("全屏守卫：线程启动失败：{e}");
            }
        });
    }

    fn guard_tick() {
        let ours = OUR_WINDOW.load(Ordering::Relaxed);
        if ours == 0 {
            return;
        }
        unsafe {
            let ours = ours as HWND;
            let fg = GetForegroundWindow();
            if fg.is_null() || fg == ours || !shell_surface(fg) {
                return;
            }
            // 先 Esc 收起开始菜单 / 搜索，再把前台还给全屏窗口
            keybd_event(VK_ESCAPE as u8, 0, 0, 0);
            keybd_event(VK_ESCAPE as u8, 0, 2, 0); // KEYEVENTF_KEYUP
            std::thread::sleep(Duration::from_millis(40));
            SetForegroundWindow(ours);
            SwitchToThisWindow(ours, 1);
            tracing::info!("全屏守卫：开始菜单抢到前台，已收回");
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 没装过钩子时关闭必须是空操作（退出路径不会因为顺序问题 panic）
        #[test]
        fn disable_without_install_is_noop() {
            set_enabled(false);
            set_enabled(false);
        }
    }
}

#[cfg(windows)]
pub use imp::{set_enabled, set_window};

#[cfg(not(windows))]
pub fn set_enabled(_on: bool) {}

#[cfg(not(windows))]
pub fn set_window(_hwnd: isize) {}

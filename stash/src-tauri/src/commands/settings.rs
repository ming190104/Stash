//! 设置命令：读写设置（含校验）、开机自启、全屏、锁 60Hz。

use crate::models::{AppError, ErrCode, Settings};
use crate::store::Store;
use crate::{input, power};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn get_settings(store: State<'_, Store>) -> Settings {
    store.load_settings()
}

#[tauri::command]
pub async fn update_settings(store: State<'_, Store>, settings: Settings) -> Result<(), AppError> {
    if !["auto", "120", "90", "60"].contains(&settings.fps_mode.as_str()) {
        return Err(AppError::new(ErrCode::ConfigInvalid, "fpsMode 仅支持 auto/120/90/60"));
    }
    if !["lastPlayed", "title", "year", "progress"].contains(&settings.sort.as_str()) {
        return Err(AppError::new(
            ErrCode::ConfigInvalid,
            "sort 仅支持 lastPlayed/title/year/progress",
        ));
    }
    if settings.motion > 1 {
        return Err(AppError::new(ErrCode::ConfigInvalid, "motion 仅支持 0/1"));
    }
    // 音效音量写进前端增益：NaN / 越界都会让 WebAudio 静默失败，宁可拒绝落盘
    if !(0.0..=1.0).contains(&settings.sound.gain) {
        return Err(AppError::new(ErrCode::ConfigInvalid, "音效音量仅支持 0–1"));
    }
    // 手柄键位白名单：未知键名会让对应动作彻底失联，宁可拒绝落盘
    {
        let valid = [
            "south", "east", "west", "north", "start", "select", "mode", "lb", "rb", "lt", "rt",
        ];
        let m = &settings.pad_map;
        for v in [&m.accept, &m.back, &m.menu, &m.x, &m.y, &m.r, &m.lb, &m.shot] {
            if !valid.contains(&v.as_str()) {
                return Err(AppError::new(
                    ErrCode::ConfigInvalid,
                    "手柄键位仅支持 south/east/west/north/start/select/mode/lb/rb/lt/rt",
                ));
            }
        }
    }
    // 手柄手感：NaN / 无穷会让死区比较永远为假（摇杆彻底失灵），保存时就拒绝；
    // 范围收敛交给 models::normalized()，与读盘走同一套
    {
        let t = &settings.pad_tuning;
        if ![t.deadzone, t.mouse_speed]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err(AppError::new(
                ErrCode::ConfigInvalid,
                "手柄手感参数必须是有限数值",
            ));
        }
    }
    // 主题 / 布局 / 字号这些取值白名单在 models.rs：落盘前与读盘走同一套收敛，
    // 否则非法值会先写进去，要到下次启动才被纠正（当次界面用的还是非法值）
    let settings = settings.normalized();
    {
        let _lock = crate::store::lock_settings();
        if let Err(e) = store.save_settings(&settings) {
            return Err(e.into());
        }
    }
    // 手柄键位与手感立刻生效，不用重启
    input::set_map(settings.pad_map.clone());
    input::set_tuning(settings.pad_tuning);
    Ok(())
}

/* ============ P3 掌机化：开机自启 + 全屏 ============ */

/// 开机自启写入的注册表位置（当前用户，免管理员）
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "Stash";

/// `reg.exe` 的绝对路径：裸名会走 PATH 解析，同目录被塞一个 reg.exe 就能劫持写启动项。
#[cfg(windows)]
fn reg_exe() -> String {
    std::env::var("SystemRoot")
        .map(|r| format!(r"{r}\System32\reg.exe"))
        .unwrap_or_else(|_| r"C:\Windows\System32\reg.exe".to_string())
}

/// 开关开机自启：写 `HKCU\...\Run`。
/// 用 `reg.exe` 而不是新增 winreg / autostart 插件依赖——零新依赖、免管理员，
/// 用户也能直接在「任务管理器 → 启动应用」里看到并随时收回。
#[tauri::command]
pub async fn set_autostart(enabled: bool) -> Result<(), AppError> {
    // reg.exe 是同步子进程：注册表被虚拟化 / 杀软拦截时可达数秒，
    // 放 tokio worker 上会和 autostart_enabled 一样拖慢其它命令
    tauri::async_runtime::spawn_blocking(move || set_autostart_sync(enabled))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

fn set_autostart_sync(enabled: bool) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new(reg_exe());
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW，避免闪黑框
        if enabled {
            let exe = std::env::current_exe()
                .map_err(|e| AppError::new(ErrCode::IoError, format!("取程序路径失败：{e}")))?;
            cmd.arg("add")
                .arg(RUN_KEY)
                .arg("/v")
                .arg(RUN_VALUE)
                .arg("/t")
                .arg("REG_SZ")
                .arg("/d")
                .arg(format!("\"{}\"", exe.display()))
                .arg("/f");
        } else {
            cmd.arg("delete").arg(RUN_KEY).arg("/v").arg(RUN_VALUE).arg("/f");
        }
        let out = cmd
            .output()
            .map_err(|e| AppError::new(ErrCode::IoError, format!("调用 reg.exe 失败：{e}")))?;
        // 关闭时值可能本来就不存在（reg 返回非 0），这是成功态而非错误
        if enabled && !out.status.success() {
            return Err(AppError::new(
                ErrCode::IoError,
                format!("写入启动项失败：{}", String::from_utf8_lossy(&out.stderr).trim()),
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err(AppError::new(ErrCode::ConfigInvalid, "开机自启仅支持 Windows"))
    }
}

/// 查询启动项是否真的在注册表里（用户可能在任务管理器里手动关掉）
#[tauri::command]
pub async fn autostart_enabled() -> bool {
    // reg.exe 查询是同步子进程：放主线程会冻界面（注册表被虚拟化 / 杀软拦截时可达数秒）
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new(reg_exe())
                .args(["query", RUN_KEY, "/v", RUN_VALUE])
                .creation_flags(0x0800_0000)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            false
        }
    })
    .await
    .unwrap_or(false)
}

/// 全屏切换（运行时即时生效；启动时按 settings.fullscreen 在 setup 里预置）
#[tauri::command]
pub fn set_fullscreen(app: AppHandle, enabled: bool) -> Result<(), AppError> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "主窗口未就绪"))?;
    // 最大化状态下 Windows 会把窗口钉死在工作区：SetWindowPos 到整块显示器会被忽略，
    // 结果全屏只铺满「工作区」（掌机 1920×1080 上实测 1848 宽）。进全屏前先解除最大化
    if enabled {
        let _ = w.unmaximize();
    }
    // 退出全屏前先取消挂起的贴边任务：它可能正好在 tao 还原之后醒来，把窗口又撑回整屏
    #[cfg(windows)]
    if !enabled {
        crate::win::cancel_fit_fullscreen();
    }
    w.set_fullscreen(enabled)
        .map_err(|e| AppError::new(ErrCode::IoError, format!("切换全屏失败：{e}")))?;
    // 掌机防误触：全屏时吞掉 Win 键（后台窗口不做拦截，窗口模式下照常可用）。
    // 钩子必须装在主线程：低层钩子的回调由装钩线程的消息循环派发。
    let _ = app.run_on_main_thread(move || crate::winkey::set_enabled(enabled));
    // P35：Win11 任务栏 TOPMOST 压在全屏窗口上（MarkFullscreenWindow 已实测无效），
    // 进全屏时临时把任务栏切为自动隐藏（真正滑出屏幕），退出时还原用户原状态
    #[cfg(windows)]
    if let Ok(hwnd) = w.hwnd() {
        let h = hwnd.0 as isize;
        crate::win::fullscreen_taskbar(h, enabled);
        // 任务栏停靠右侧时，全屏窗口会被 Explorer 重算工作区摆回 1848 宽：
        // 进全屏后延迟补两次贴边。**不能同步贴边**——tao 的 set_fullscreen 是排队到
        // 事件循环执行的，它会在这时候用 GetWindowPlacement 记下「进全屏前的窗口」；
        // 我们先把它撑到整屏，tao 记下的就是整屏尺寸，退出全屏会还原成整屏窗口
        if enabled {
            crate::win::fit_fullscreen_later(h);
        } else {
            crate::win::cancel_fit_fullscreen();
            // 退出全屏后把还原的矩形夹进工作区：掌机上还原的 1232×726 比 1232×720 高 6px
            crate::win::clamp_to_work_later(h);
        }
    }
    Ok(())
}

/// 深度省电：锁 60Hz / 还原。返回切换后的实际刷新率。
#[tauri::command]
pub async fn set_power60(enabled: bool) -> Result<u32, AppError> {
    power::apply(enabled)
}

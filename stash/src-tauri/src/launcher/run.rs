//! 启动 / 停止 / 运行态与游玩记录收尾。

use crate::models::{AppError, ErrCode, Game, PlaySession};
use crate::store::{now_secs, Store};
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::locale::{plan_locale, LeMode};
#[cfg(windows)]
use super::job as win;

/// 启动前主窗口的位置与尺寸（逻辑像素 x/y/w/h）。
/// 老游戏常把显示器切成 800×600，退回到桌面后 Windows 会把窗口挤到别处；
/// 这里记下原样，游戏退出后放回去。
static MAIN_RECT: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

fn save_main_rect(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else { return };
    let sf = w.scale_factor().unwrap_or(1.0);
    if sf <= 0.0 {
        return;
    }
    *MAIN_RECT.lock().unwrap_or_else(|e| e.into_inner()) = Some((
        pos.x as f64 / sf,
        pos.y as f64 / sf,
        size.width as f64 / sf,
        size.height as f64 / sf,
    ));
}

/// 游戏退出后把主窗口放回原位。夹取到当前显示器：
/// 万一游戏没把分辨率还原（崩溃 / 强杀），窗口也不至于整块跑到屏幕外。
fn restore_main_rect(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let Some((x, y, ww, wh)) = MAIN_RECT.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    if w.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (mw, mh, mx, my) = crate::screen::monitor_box(app);
    let nw = ww.min((mw - 16.0).max(640.0));
    let nh = wh.min((mh - 16.0).max(360.0));
    let nx = x.min(mx + (mw - nw).max(0.0)).max(mx);
    let ny = y.min(my + (mh - nh).max(0.0)).max(my);
    let _ = w.set_size(tauri::LogicalSize::new(nw, nh));
    let _ = w.set_position(tauri::LogicalPosition::new(nx, ny));
    // monitor_box 是整块显示器，任务栏停靠时仍可能压住窗口边缘：按 rcWork 再夹一次
    if let Ok(hwnd) = w.hwnd() {
        crate::win::clamp_to_work_later(hwnd.0 as isize);
    }
    tracing::info!("窗口：游戏退出后复位 {nx:.0},{ny:.0} {nw:.0}×{nh:.0}");
}

struct RunningGame {
    id: String,
    /// 主进程 pid：Job 挂不上时 stop 的兜底终止手段
    pid: u32,
    /// Job Object 句柄。windows-sys HANDLE = *mut c_void（非 Send），
    /// 存 isize 以便跨线程传递，用时 as 转回。0 = 没有可用的 Job（创建/挂载失败）
    #[cfg(windows)]
    job: isize,
    /// 启动时刻（epoch 秒）：应用退出兜底落盘时按 now-started 计本次时长
    started: i64,
    /// 已被退出兜底（flush_running_records）落过盘：监控线程收尾时跳过写记录，避免双计
    flushed: bool,
}

/// 转区接管超时：LEProc 正常 1~3 秒内拉起游戏，等太久只会让前端停在「启动中」。
const LOCALE_TAKEOVER: Duration = Duration::from_secs(8);
/// 等 Job 清空的上限：正常游戏退出后 1 秒内就空了；挂常驻辅助进程时不能无限等，
/// 否则 watcher 线程卡住、「运行中」永不结束、游玩时长也不落盘。
const JOB_DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

static RUNNING: Mutex<Vec<RunningGame>> = Mutex::new(Vec::new());
/// 正在启动（spawn 到 RUNNING 落位之间）的 id：转区接管最长 8 秒，
/// 这期间重复点击必须挡掉，否则会拉起第二份游戏。
static LAUNCHING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 启动占位，Drop 时自动释放：任何提前 return（前置检查、spawn 失败、接管超时）都不会漏。
struct LaunchGuard(String);

impl LaunchGuard {
    fn acquire(id: &str) -> Result<Self, AppError> {
        let mut cur = LAUNCHING.lock().unwrap_or_else(|e| e.into_inner());
        if cur.iter().any(|x| x == id) {
            return Err(AppError::new(ErrCode::AlreadyRunning, "该游戏正在启动中"));
        }
        cur.push(id.to_string());
        Ok(Self(id.to_string()))
    }
}

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        LAUNCHING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|x| x != &self.0);
    }
}

/// 应用退出时的兜底落盘：游玩记录（时长 / 次数 / 场次）唯一的写入点是监控线程的
/// 收尾，用户直接关掉 Stash（游戏还开着）会让该线程随进程一起终止，本次数据
/// 全丢（唯一不可再生数据）。Exit 回调里对仍在运行的实例按 now-started 补写一遍，
/// 并标记 flushed——监控线程若还有机会跑，看到标志会跳过写记录，避免 play_count 双计。
///
/// 锁序：先拿库写锁、锁内核对 RUNNING——监控线程写记录同样要过库写锁，且它在
/// 拿库写锁前就已把实例摘出 RUNNING，两个写入点天然互斥，退出瞬间的竞态也不会双计。
/// （RUNNING 与库锁无任何嵌套等待，不会死锁。）
pub(crate) fn flush_running_records(store: &Store) {
    let _lock = crate::store::lock_library();
    let mut games = store.load_library();
    let now = now_secs();
    let mut changed = false;
    {
        let mut cur = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        for x in cur.iter_mut().filter(|x| !x.flushed) {
            // 实例还在表里 = 监控线程尚未写记录（它写前会先摘表）
            let Some(g) = games.iter_mut().find(|g| g.id == x.id) else {
                continue;
            };
            let played = (now - x.started).max(0);
            g.last_played = Some(now);
            g.play_count += 1;
            if played > 0 {
                g.play_seconds = g.play_seconds.saturating_add(played as u64);
                g.sessions.push(PlaySession {
                    at: x.started,
                    seconds: played as u64,
                });
                if g.sessions.len() > 50 {
                    let extra = g.sessions.len() - 50;
                    g.sessions.drain(0..extra);
                }
            }
            x.flushed = true;
            changed = true;
        }
    }
    if changed {
        if let Err(e) = store.save_library(&games) {
            tracing::error!("exit flush: 游玩记录写盘失败：{e}");
        }
    }
}

pub fn is_running(id: &str) -> bool {
    // 锁中毒也继续读（与其它入口一致）：返回 false 会放行重复启动
    RUNNING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|x| x.id == id)
}

/// 当前正在运行的游戏 id（快速菜单窗用来知道「现在是哪一部」）
pub fn running_id() -> Option<String> {
    RUNNING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .first()
        .map(|x| x.id.clone())
}

/// 启动游戏：spawn → Job Object → 后台监控线程（wait 退出 → 更新游玩记录 → 事件回报）。
pub fn launch(app: AppHandle, store: Store, game: Game) -> Result<(), AppError> {
    if is_running(&game.id) {
        return Err(AppError::new(ErrCode::AlreadyRunning, format!("《{}》已在运行", game.title)));
    }
    let _launching = LaunchGuard::acquire(&game.id)?;

    let settings = store.load_settings();
    // 主程序可能已被移动/删除：spawn 只会给出笼统的「系统找不到文件」，先拦一层给能自救的提示。
    if !Path::new(&game.exe).is_file() {
        return Err(AppError::new(
            ErrCode::LaunchFailed,
            format!("游戏主程序不存在：{}（目录可能被移动或删除，请在设置里重新添加）", game.exe),
        ));
    }
    // P3：游戏运行期间把手柄当鼠标（设置里开才生效）
    let gamepad_mouse = settings.gamepad_mouse;
    // 转区启动（P4）：needsLocale + 设置开启 → 必须真能转区。
    // 工具缺失 / 未初始化一律报错并指路：静默直启会让日文老游戏乱码或闪退，
    // 退回 `-run` 则因为没有作品配置只会弹出 LEGUI，用户看到「什么都没发生」。
    let locale_launch_cfg = game.needs_locale && settings.locale.launch;
    let locale_plan = if locale_launch_cfg {
        Some(plan_locale(&settings, &game)?)
    } else {
        None
    };
    // 不向游戏传任何命令行参数：真实 Galgame 各自解析 argv，多给一个作品名可能直接报错。
    // 演示用的 fake-game 需要标题时读环境变量（见 tools/fake-game），真实游戏会忽略它。
    let mut cmd = match &locale_plan {
        Some((tool, mode)) => {
            let mut c = Command::new(tool);
            match mode {
                LeMode::AppConfig => {
                    tracing::info!("launch(locale): {} -run {}", tool.display(), game.exe);
                    c.arg("-run").arg(&game.exe);
                }
                LeMode::Profile(guid) => {
                    tracing::info!(
                        "launch(locale): {} -runas {} {}",
                        tool.display(),
                        guid,
                        game.exe
                    );
                    c.arg("-runas").arg(guid).arg(&game.exe);
                }
            }
            c
        }
        None => Command::new(&game.exe),
    };
    if locale_plan.is_some() {
        tracing::info!("launch: {} -> {} (locale)", game.title, game.exe);
    } else {
        tracing::info!("launch: {} -> {}", game.title, game.exe);
    }
    cmd.current_dir(&game.dir).env("STASH_GAME_TITLE", &game.title);
    // 每游戏启动参数（P4 B10）：转区工具只认 `-run/-runas <exe>`，多给的参数会被它吞掉，
    // 与其静默失效不如明确跳过并留一条日志。
    if !game.launch_args.is_empty() {
        if locale_plan.is_some() {
            tracing::warn!("launch: 转区启动下忽略自定义参数 {:?}", game.launch_args);
        } else {
            tracing::info!("launch args: {:?}", game.launch_args);
            cmd.args(&game.launch_args);
        }
    }
    // 转区启动：子进程是启动器，真正要跟踪的进程由它拉起，走「事后按 exe 名接管」
    let locale_launch = locale_plan.is_some();
    // 控制台子系统的程序（如演示用的 fake-game）必须拿到自己的控制台：
    // GUI 进程本身没有控制台，子进程继承到的 stdin 是无效句柄，read_line 立刻 EOF
    // → 演示游戏「一闪就退」。CREATE_NEW_CONSOLE 对 GUI 子系统（真实 Galgame）无副作用。
    //
    // 非转区再加 CREATE_SUSPENDED：先挂起创建，等 Job 挂上再恢复主线程（见
    // `win::attach_and_resume`）。否则启动壳可能在我们拿到 pid 之前就拉起真正的
    // 游戏，孙进程不在 Job 里，退出应用 / 停止游戏都杀不掉它。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(if locale_launch {
            CREATE_NEW_CONSOLE
        } else {
            CREATE_NEW_CONSOLE | CREATE_SUSPENDED
        });
    }
    // 转区接管要按 exe 名反查进程：先记下启动前已存在的同名进程，
    // 否则用户自己早就开着的一份会被当成本次启动的游戏（stop 会误杀它）
    #[cfg(windows)]
    let preexisting: std::collections::HashSet<u32> = if locale_launch {
        unsafe { win::pids_named(&game.exe) }
    } else {
        std::collections::HashSet::new()
    };
    // 记住主窗口原位：游戏切分辨率后 Windows 会把窗口挤走，退出时放回来
    save_main_rect(&app);
    let mut child: Child = cmd
        .spawn()
        .map_err(|e| AppError::new(ErrCode::LaunchFailed, format!("启动失败（{e}）：{}", game.exe)))?;

    // 非转区：子进程是挂起创建的，先挂 Job 再放行；失败就回收，绝不放一个逃出监控的进程出去
    #[cfg(windows)]
    let mut early_job: isize = 0;
    #[cfg(windows)]
    if !locale_launch {
        match unsafe { win::attach_and_resume(&child) } {
            Ok(job) => early_job = job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::new(
                    ErrCode::LaunchFailed,
                    format!("启动失败：{e}"),
                ));
            }
        }
    }

    // 转区启动器（LEProc / Ntleas）拉起游戏后自己就退出了：子进程句柄指向的是启动器，
    // 直接跟踪它会让「运行中」状态、游玩时长、停止按钮、文本钩子挂接全部失效。
    // 这里按 exe 路径找回真正的游戏进程，后续一律用它的 pid。
    let mut pid = child.id();
    #[cfg(windows)]
    let mut game_handle: isize = 0;
    if locale_launch {
        // 不能等启动器退出：LEProc 用 -runas 拉起游戏后可能自己长期驻留，
        // 等它就等于把整个 launch 命令卡死（前端会一直停在「启动中」）。
        // 直接按 exe 路径找游戏进程，启动器的回收放到游戏退出之后。
        #[cfg(windows)]
        match unsafe { win::wait_for_process(&game.exe, LOCALE_TAKEOVER, &preexisting) } {
            Some(p) => {
                pid = p;
                game_handle = unsafe { win::open_wait(p) };
                tracing::info!("launch: 已接管转区游戏进程 pid={p}");
            }
            None => {
                // 超时说明转区工具没把游戏拉起来（配置损坏 / 被杀软拦截 / 弹了 LEGUI 等人操作）。
                // 不能把启动器留在后台、更不能先报「运行中」再无声退出：收掉进程直接报错。
                let _ = child.kill();
                let _ = child.wait();
                // 但也要防「晚一步才起来」：启动器超时后游戏进程可能刚好出现，
                // 不收掉就会留下一个没人跟踪的游戏窗口（界面显示未运行、也停不掉）。
                #[cfg(windows)]
                for p in unsafe { win::pids_named(&game.exe) } {
                    if preexisting.contains(&p) {
                        continue;
                    }
                    if unsafe { win::kill_pid(p) } {
                        tracing::warn!("launch: 转区接管超时，已回收残留进程 pid={p}");
                    }
                }
                return Err(AppError::new(
                    ErrCode::LaunchFailed,
                    format!(
                        "转区启动失败：{} 秒内未检测到 {}。请检查 设置 → 启动 → 转区工具 的配置，或关闭「转区启动」直接运行",
                        LOCALE_TAKEOVER.as_secs(),
                        game.exe
                    ),
                ));
            }
        }
    }
    let mut local_child = child;
    #[cfg(windows)]
    let job = if early_job != 0 {
        // 非转区：spawn 时已经「先挂 Job 再放行」，直接复用那个句柄
        early_job
    } else if !locale_launch {
        // attach_and_resume 返回 0：Job 建不出来 / 挂不上，进程已放行，只能靠 pid 兜底
        tracing::warn!("launch: 无法把游戏挂进 Job Object（pid={pid}），停止时只杀主进程");
        0
    } else {
        unsafe {
            let job = win::create_job();
            if job == 0 {
                tracing::warn!("launch: Job Object 创建失败，停止游戏时只能终止主进程");
                0
            } else if !win::assign(job, pid) {
                // 挂不上（常见于父进程已在 Job 里 / 权限不足）：关掉句柄，靠 pid 兜底
                tracing::warn!("launch: 无法把游戏挂进 Job Object（pid={pid}），停止时只杀主进程");
                win::close(job);
                0
            } else {
                job
            }
        }
    };

    // 本次启动时间：游玩时长 / 最近场次都按它计算
    let started = now_secs();

    let id = game.id.clone();
    RUNNING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(RunningGame {
            id: id.clone(),
            pid,
            #[cfg(windows)]
            job,
            started,
            flushed: false,
        });
    let _ = app.emit("game://started", &id);
    if gamepad_mouse {
        crate::input::set_mouse_mode(true);
    }

    std::thread::spawn(move || {
        // 转区启动：child 是已经退出的启动器，要等的是游戏进程句柄；
        // 非转区：child 本身就是游戏，走原来的 wait。
        #[cfg(windows)]
        let game_code = if locale_launch {
            unsafe { win::wait_process_exit(pid, game_handle) }
        } else {
            None
        };
        #[cfg(not(windows))]
        let game_code: Option<i32> = None;
        // 转区启动器（LEProc）可能在游戏结束后仍驻留：主动收掉，避免留下后台进程
        if locale_launch {
            let _ = local_child.kill();
        }
        // 非转区：主进程可能是「启动壳」（Ren'Py 常见），真正的游戏在 Job 里。
        // 先收主进程（启动壳几十毫秒就退出），再等 Job 空掉；close(job) 时若游戏还在
        // Job 里会被一起杀掉，所以这一步必须在关闭 Job 之前、且带超时兜底。
        let status = local_child.wait();
        #[cfg(windows)]
        if !locale_launch && job != 0 && !unsafe { win::wait_job_empty(job, JOB_DRAIN_TIMEOUT) } {
            tracing::warn!(
                "launch: Job 内仍有进程未退出（超过 {:?}），关闭 Job 一并回收",
                JOB_DRAIN_TIMEOUT
            );
        }
        #[cfg(windows)]
        unsafe {
            // 关闭 Job 句柄：若有残留子进程整树回收；正常退出时无副作用
            win::close(job);
        }
        // 只摘掉「这一个实例」：stop 会先把条目移出 RUNNING，用户紧接着重启同一部时
        // 新实例的 pid 不同——按 id 清会把新实例的记录一起删掉（界面显示未运行、
        // stop 报 NotFound、还能再启动第三份）。摘除时顺带取出 flushed 标志：
        // 应用退出兜底（flush_running_records）已落过盘的，下面写记录要跳过防双计
        let this_pid = pid;
        let flushed = {
            let mut cur = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
            let mut hit = false;
            cur.retain(|x| {
                if x.id == id && x.pid == this_pid {
                    hit = x.flushed;
                    false
                } else {
                    true
                }
            });
            hit
        };
        // 最后一个游戏退出才关掉鼠标映射（多开时别的窗口还要用）
        let still_running = !RUNNING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if !still_running {
            crate::input::set_mouse_mode(false);
        }

        // 游玩记录：last_played / play_count / play_seconds（唯一不可再生数据，立即落盘）。
        // flushed = 应用退出兜底已写过：跳过，避免 play_count 双计
        let played = now_secs() - started;
        if !flushed {
            {
                // 与收藏 / END / 扫描共用库写锁：读—改—写必须原子，否则互相覆盖
                let _lock = crate::store::lock_library();
                let mut games = store.load_library();
                if let Some(g) = games.iter_mut().find(|g| g.id == id) {
                    g.last_played = Some(now_secs());
                    g.play_count += 1;
                    // 时长按秒累加；不足 1 秒的启动（误点即退）不计，避免把次数刷成时长
                    if played > 0 {
                        g.play_seconds = g.play_seconds.saturating_add(played as u64);
                        // M6：最近 50 次场次，供详情页展示
                        g.sessions.push(PlaySession { at: started, seconds: played as u64 });
                        if g.sessions.len() > 50 {
                            let extra = g.sessions.len() - 50;
                            g.sessions.drain(0..extra);
                        }
                    }
                    // 游玩记录是唯一不可再生数据：写盘失败必须留痕，不能静默当成功
                    if let Err(e) = store.save_library(&games) {
                        tracing::error!("game exit: 游玩记录写盘失败 {id}: {e}");
                    }
                }
            }
        }

        let code = game_code
            .or_else(|| status.ok().and_then(|s| s.code()))
            .unwrap_or(-1);
        tracing::info!("game exited: {id} code={code}");
        // 分辨率 / DPI 多半被游戏改过：把主窗口放回启动前的位置，别让用户找不到它
        restore_main_rect(&app);
        let _ = app.emit(
            "game://exited",
            serde_json::json!({ "id": id, "code": code }),
        );
    });

    Ok(())
}

/// 停止游戏：终止 Job 整树。退出回报与记录更新由监控线程收尾。
pub fn stop(id: &str) -> Result<(), AppError> {
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let Some(pos) = running.iter().position(|x| x.id == id) else {
        return Err(AppError::new(ErrCode::NotFound, "游戏未在运行"));
    };
    let g = running.remove(pos);
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        let ok = unsafe {
            // Job 没挂上（0）或 Terminate 失败时必须退到「杀主进程」，
            // 否则界面上已经显示「已停止」，游戏却还在跑
            let by_job = g.job != 0 && TerminateJobObject(g.job as _, 0) != 0;
            by_job || win::kill_pid(g.pid)
        };
        if !ok {
            // 两条路都失败（游戏以管理员权限运行 / 进程被保护）：条目放回 RUNNING。
            // 若照旧返回 Ok，界面会显示「已停止」而游戏还在跑，而且条目已删、
            // 用户再按一次「结束游戏」只会得到「游戏未在运行」——彻底停不掉
            running.push(g);
            return Err(AppError::new(
                ErrCode::IoError,
                "无法结束游戏进程（可能以管理员权限运行），请在任务管理器中手动结束",
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = g;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 启动占位：同 id 第二次 acquire 必须被挡住，Drop 之后又能正常启动
    #[test]
    fn launch_guard_blocks_duplicate_start() {
        let first = LaunchGuard::acquire("guard-test").unwrap();
        assert!(LaunchGuard::acquire("guard-test").is_err(), "启动窗口内重复点击必须被挡");
        drop(first);
        assert!(LaunchGuard::acquire("guard-test").is_ok(), "占位释放后必须能再次启动");
    }
    /// 进程必须先挂 Job 再恢复运行，主线程恢复后子进程才会继承 Job。
    ///
    /// 默认跳过：`CREATE_SUSPENDED` 的控制台子进程在「默认终端 = Windows Terminal」
    /// 的机器上会触发终端交接失败（Windows Terminal 弹 0x800700E8，ERROR_NO_SYSTEM_RESOURCES）。
    /// 需要验证时用 `cargo test --lib -- --ignored suspended_process_joins_job_before_resume`，
    /// 或把系统默认终端临时改为 conhost。
    #[cfg(windows)]
    #[test]
    #[ignore = "Windows Terminal 默认终端下，挂起的控制台子进程会触发终端交接失败"]
    fn suspended_process_joins_job_before_resume() {
        use std::os::windows::process::CommandExt;
        let mut child = Command::new("cmd.exe")
            .args(["/C", "exit", "0"])
            .creation_flags(0x0000_0010 | 0x0000_0004 | 0x0800_0000)
            .spawn()
            .unwrap();
        let job = match unsafe { win::attach_and_resume(&child) } {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("挂 Job 并恢复线程失败：{e}");
            }
        };
        assert!(child.wait().unwrap().success());
        unsafe { win::close(job) };
    }
}

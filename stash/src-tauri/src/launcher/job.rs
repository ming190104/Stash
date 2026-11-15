//! Job Object 与进程枚举（Windows）：先挂 Job 再放行，退出时整树回收。

use std::path::Path;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
    PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, OpenThread, QueryFullProcessImageNameW, ResumeThread,
    WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

/// 创建 Job Object 并设置「句柄关闭即杀整树」。返回 isize 句柄（0 = 创建失败）。
pub unsafe fn create_job() -> isize {
    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
        return 0;
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const core::ffi::c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    );
    if ok == 0 {
        // 标志没设上就等于没有 KILL_ON_JOB_CLOSE：句柄关掉也杀不掉整树，
        // 与其交一个「看起来能用」的 Job 出去，不如直接判失败让调用方走 pid 兜底
        CloseHandle(job);
        return 0;
    }
    job as isize
}

pub unsafe fn assign(job: isize, pid: u32) -> bool {
    if job == 0 {
        return false;
    }
    let ph = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if ph.is_null() {
        return false;
    }
    let ok = AssignProcessToJobObject(job as _, ph);
    CloseHandle(ph);
    ok != 0
}

/// 兜底终止：Job 没挂上时（已存在的 Job 会拒绝挂载），直接杀主进程
pub unsafe fn kill_pid(pid: u32) -> bool {
    use windows_sys::Win32::System::Threading::TerminateProcess;
    let ph = OpenProcess(PROCESS_TERMINATE, 0, pid);
    if ph.is_null() {
        return false;
    }
    let ok = TerminateProcess(ph, 1);
    CloseHandle(ph);
    ok != 0
}

pub unsafe fn close(job: isize) {
    if job != 0 {
        CloseHandle(job as _);
    }
}

/// 恢复目标进程被 CREATE_SUSPENDED 挂起的线程，返回恢复成功的线程数。
///
/// `std::process::Child` 不保留主线程句柄（spawn 后就被 std 关掉了），
/// 只能按 pid 枚举线程后逐个 `ResumeThread`。第一次 ResumeThread 把挂起计数
/// 从 1 减到 0，进程随即开始执行；新拉起的子进程天然继承 Job。
pub unsafe fn resume_threads(pid: u32) -> usize {
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if snap == INVALID_HANDLE_VALUE {
        return 0;
    }
    let mut te: THREADENTRY32 = std::mem::zeroed();
    te.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut resumed = 0usize;
    if Thread32First(snap, &mut te) != 0 {
        loop {
            if te.th32OwnerProcessID == pid {
                let th = OpenThread(THREAD_SUSPEND_RESUME, 0, te.th32ThreadID);
                if !th.is_null() {
                    // 只可能挂起了一次（CREATE_SUSPENDED），恢复一次即可
                    if ResumeThread(th) != u32::MAX {
                        resumed += 1;
                    }
                    CloseHandle(th);
                }
            }
            if Thread32Next(snap, &mut te) == 0 {
                break;
            }
        }
    }
    CloseHandle(snap);
    resumed
}

/// 「先挂 Job、再放行」：以 `CREATE_SUSPENDED` 创建的子进程，在挂进 Job 之前
/// 一条指令都没执行，所以游戏本体拉起的任何子进程都不可能逃出 Job。
///
/// 返回 Job 句柄；0 表示 Job 建不出来 / 挂不上（进程已恢复运行，调用方退回 pid 兜底）。
/// 返回 Err 表示线程恢复失败——此时进程已被回收，绝不会留下挂起且无人跟踪的僵尸。
pub unsafe fn attach_and_resume(child: &std::process::Child) -> Result<isize, String> {
    let pid = child.id();
    let job = create_job();
    if job != 0 && assign(job, pid) {
        if resume_threads(pid) == 0 {
            close(job);
            kill_pid(pid);
            return Err(format!("恢复游戏线程失败（pid={pid}）"));
        }
        return Ok(job);
    }
    if job != 0 {
        close(job);
    }
    // 挂不上（父进程已在 Job 里 / 权限不足）：仍要放行，否则游戏永远停在挂起态
    if resume_threads(pid) == 0 {
        return Err(format!("恢复游戏线程失败（pid={pid}）"));
    }
    Ok(0)
}

/// 转区启动器（LEProc）拉起游戏后会立刻退出，真正要跟踪的是它拉起的进程。
/// 按全路径匹配（查不到路径时退回文件名），最多等 `timeout`。
/// `exclude` 是启动前就已经存在的同名 pid：用户可能自己早已开着一份，
/// 权限不足读不到路径时仅凭文件名会把它当成本次启动的游戏（stop 会误杀）。
pub unsafe fn wait_for_process(
    exe: &str,
    timeout: Duration,
    exclude: &std::collections::HashSet<u32>,
) -> Option<u32> {
    let target = Path::new(exe);
    let want_name = target
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let want_path = target.to_string_lossy().replace('/', "\\").to_lowercase();
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(pid) = find_process(&want_path, &want_name, exclude) {
            return Some(pid);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// 启动前按文件名收集已存在的进程 pid（转区接管用来排除「用户本来开着的」实例）
pub unsafe fn pids_named(exe: &str) -> std::collections::HashSet<u32> {
    let mut out = std::collections::HashSet::new();
    let want = Path::new(exe)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if want.is_empty() {
        return out;
    }
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snap == INVALID_HANDLE_VALUE {
        return out;
    }
    let mut pe: PROCESSENTRY32W = std::mem::zeroed();
    pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    if Process32FirstW(snap, &mut pe) != 0 {
        loop {
            let end = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
            let name = String::from_utf16_lossy(&pe.szExeFile[..end]).to_lowercase();
            if name == want {
                out.insert(pe.th32ProcessID);
            }
            if Process32NextW(snap, &mut pe) == 0 {
                break;
            }
        }
    }
    CloseHandle(snap);
    out
}

unsafe fn find_process(
    want_path: &str,
    want_name: &str,
    exclude: &std::collections::HashSet<u32>,
) -> Option<u32> {
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snap == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut pe: PROCESSENTRY32W = std::mem::zeroed();
    pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut name_hit = None;
    if Process32FirstW(snap, &mut pe) != 0 {
        loop {
            let name = {
                let end = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                String::from_utf16_lossy(&pe.szExeFile[..end]).to_lowercase()
            };
            if name == want_name
                && pe.th32ProcessID != std::process::id()
                && !exclude.contains(&pe.th32ProcessID)
            {
                let ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pe.th32ProcessID);
                if ph.is_null() {
                    // 权限不足时读不到路径：文件名一致即认为是目标（演示/独立游戏足够）
                    name_hit.get_or_insert(pe.th32ProcessID);
                } else {
                    let mut buf = [0u16; 512];
                    let mut len = buf.len() as u32;
                    let ok = QueryFullProcessImageNameW(ph, 0, buf.as_mut_ptr(), &mut len);
                    if ok != 0 {
                        let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
                        if path.replace('/', "\\") == want_path {
                            CloseHandle(ph);
                            CloseHandle(snap);
                            return Some(pe.th32ProcessID);
                        }
                        // 路径读得到且不匹配 = 明确是另一个同名程序（另一份拷贝 / 别的启动器）。
                        // 不能退化成「同名就算」：接管错进程后 stop 会杀掉用户自己开的那一份
                    }
                    // 读路径失败时才退回文件名（容错），成功读到却不等的情况上面已排除
                    if ok == 0 {
                        name_hit.get_or_insert(pe.th32ProcessID);
                    }
                    CloseHandle(ph);
                }
            }
            if Process32NextW(snap, &mut pe) == 0 {
                break;
            }
        }
    }
    CloseHandle(snap);
    name_hit
}

/// 打开「可等待」句柄；0 = 打开失败（进程已退出或权限不足）
pub unsafe fn open_wait(pid: u32) -> isize {
    let ph = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    ph as isize
}

/// 等句柄就绪并取退出码（顺便关句柄）
pub unsafe fn wait_and_code(handle: isize) -> Option<i32> {
    if handle == 0 {
        return None;
    }
    WaitForSingleObject(handle as _, INFINITE);
    let mut code: u32 = 0;
    let ok = GetExitCodeProcess(handle as _, &mut code);
    CloseHandle(handle as _);
    if ok != 0 {
        Some(code as i32)
    } else {
        None
    }
}

/// Job 里还活着的进程数；查不到时返回 None（调用方退回等主进程）
unsafe fn job_process_count(job: isize) -> Option<u32> {
    let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
    let ok = QueryInformationJobObject(
        job as _,
        JobObjectBasicAccountingInformation,
        &mut info as *mut _ as *mut _,
        std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
        std::ptr::null_mut(),
    );
    if ok != 0 {
        Some(info.ActiveProcesses)
    } else {
        None
    }
}

/// 等整个 Job 空掉。Ren'Py 这类「启动壳再拉起真正的游戏」的作品，
/// 主进程 30ms 就退出，真正的游戏还在 Job 里；此时 close(job) 会把游戏一起杀掉。
///
/// 带超时：Job 里若挂着常驻辅助进程（更新器 / 崩溃上报），以前这里会无限等，
/// watcher 线程卡死 → 「运行中」永远不结束、游玩时长也永远不落盘。
/// 返回 false 表示超时（调用方关 Job 一并回收）。
pub unsafe fn wait_job_empty(job: isize, limit: Duration) -> bool {
    if job == 0 {
        return true;
    }
    let deadline = std::time::Instant::now() + limit;
    loop {
        match job_process_count(job) {
            Some(0) => return true,
            Some(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(700))
            }
            Some(_) => return false,
            None => return true,
        }
    }
}

/// 转区游戏可能以更高完整性级别运行（读不到句柄/权限不足）：
/// 这时退回「轮询进程表直到 pid 消失」，至少让运行状态与游玩时长是对的。
pub unsafe fn wait_process_exit(pid: u32, handle: isize) -> Option<i32> {
    if handle != 0 {
        return wait_and_code(handle);
    }
    while pid_alive(pid) {
        std::thread::sleep(Duration::from_millis(800));
    }
    None
}

unsafe fn pid_alive(pid: u32) -> bool {
    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snap == INVALID_HANDLE_VALUE {
        return false;
    }
    let mut pe: PROCESSENTRY32W = std::mem::zeroed();
    pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut alive = false;
    if Process32FirstW(snap, &mut pe) != 0 {
        loop {
            if pe.th32ProcessID == pid {
                alive = true;
                break;
            }
            if Process32NextW(snap, &mut pe) == 0 {
                break;
            }
        }
    }
    CloseHandle(snap);
    alive
}

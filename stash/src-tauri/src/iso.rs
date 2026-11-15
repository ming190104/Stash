//! ISO 挂载（P4 B11）：老 Galgame 常以光盘镜像发行，玩家不想装第三方虚拟光驱。
//! 走系统自带的 Mount-DiskImage / Dismount-DiskImage（PowerShell），零依赖。
//! 注意：这两个 cmdlet 需要管理员权限；失败时把原因原样带回前端，不假装成功。

use crate::models::{AppError, ErrCode};

#[cfg(windows)]
fn powershell(script: &str) -> Result<String, AppError> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    // 用绝对路径而不是裸 `powershell`：PATH 里若被放进同名 exe（当前目录优先时更危险），
    // 一次 ISO 挂载就把任意脚本执行权交了出去。
    let exe = std::env::var("SystemRoot")
        .map(|r| format!(r"{r}\System32\WindowsPowerShell\v1.0\powershell.exe"))
        .unwrap_or_else(|_| format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", r"C:\Windows"));
    let mut child = std::process::Command::new(exe)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：别闪黑框
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::new(ErrCode::IoError, format!("调用 PowerShell 失败：{e}")))?;
    // 必须边等边把两条管道读空：输出一旦超过管道缓冲（约 4KB，多行报错很容易超），
    // 子进程会阻塞在 write 上永不退出 —— 只看 try_wait 就只能白等 30 秒，错误原文也拿不到
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    // 挂载/卸载可能卡在杀软扫描、离线的网络盘或驱动重试里：
    // 不设上限会让 async 命令一直占着 tokio worker，反复点击还会堆起多个 powershell.exe
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(80)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                // 杀掉子进程后管道即关闭，两个读线程会立刻收尾，不会泄漏
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(AppError::new(ErrCode::IoError, "ISO 操作超时（30 秒），已取消"));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(AppError::new(ErrCode::IoError, format!("等待 PowerShell 失败：{e}")));
            }
        }
    };
    let out_bytes = out_reader.join().unwrap_or_default();
    let err_bytes = err_reader.join().unwrap_or_default();
    if !status.success() {
        let err = String::from_utf8_lossy(&err_bytes);
        return Err(AppError::new(
            ErrCode::IoError,
            format!("ISO 操作失败（挂载/卸载需要管理员权限）：{}", err.trim()),
        ));
    }
    Ok(String::from_utf8_lossy(&out_bytes).trim().to_string())
}

/// 挂载 ISO，返回盘符（形如 `H:`）。已挂载的镜像会直接返回现有盘符。
#[cfg(windows)]
pub fn mount(path: &str) -> Result<String, AppError> {
    if !std::path::Path::new(path).is_file() {
        return Err(AppError::new(ErrCode::NotFound, format!("找不到镜像文件：{path}")));
    }
    // PowerShell 单引号字符串里只需把单引号翻倍，反斜杠不用转义
    let esc = path.replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='Stop'; $v = Mount-DiskImage -ImagePath '{esc}' -PassThru | Get-Volume | Select-Object -First 1; Write-Output $v.DriveLetter"
    );
    let letter = powershell(&script)?;
    if letter.is_empty() {
        return Err(AppError::new(ErrCode::IoError, "镜像已挂载但没有可用的盘符"));
    }
    Ok(format!("{}:", letter.trim()))
}

/// 卸载 ISO。镜像没挂载时按成功处理（幂等），避免用户点两下就报错。
#[cfg(windows)]
pub fn unmount(path: &str) -> Result<(), AppError> {
    let esc = path.replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='Stop'; if (Get-DiskImage -ImagePath '{esc}' | Select-Object -ExpandProperty Attached) {{ Dismount-DiskImage -ImagePath '{esc}' | Out-Null }}"
    );
    powershell(&script)?;
    Ok(())
}

#[cfg(not(windows))]
pub fn mount(_path: &str) -> Result<String, AppError> {
    Err(AppError::new(ErrCode::IoError, "ISO 挂载仅支持 Windows"))
}

#[cfg(not(windows))]
pub fn unmount(_path: &str) -> Result<(), AppError> {
    Err(AppError::new(ErrCode::IoError, "ISO 挂载仅支持 Windows"))
}

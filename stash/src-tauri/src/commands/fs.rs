//! 只读文件浏览器：列盘符 / 列目录。没有任何打开外部程序或资源管理器的命令。
//!
//! 只读：这里没有任何创建、重命名、删除、写文件的通道。
//! 允许全盘浏览（不做库根白名单），因此也不接受相对路径——一律要求绝对路径，
//! 避免前端拼错时落到进程当前目录上。

use crate::models::{AppError, ErrCode};
use serde::Serialize;
use std::path::PathBuf;

/// 单次最多返回的条目数：C:\ 根目录、缓存目录这类地方可能上万项，
/// 全量塞给 WebView 会让切目录明显卡顿。超出部分由前端提示「已截断」。
const MAX_ENTRIES: usize = 3000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// 目录记 0：不递归统计，避免慢盘 / 网络盘上切一次目录卡几十秒
    pub size: u64,
    /// 修改时间（Unix 秒），取不到记 0
    pub modified: i64,
    pub hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDrive {
    /// "C:"
    pub name: String,
    /// "C:\"
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListing {
    /// None = 盘符列表（此电脑）
    pub path: Option<String>,
    /// 上一级；到盘符根目录时为 None
    pub parent: Option<String>,
    pub entries: Vec<FsEntry>,
    pub drives: Vec<FsDrive>,
    pub truncated: bool,
}

/// 逻辑盘符列表（不探测介质，空光驱也不会卡住）
#[cfg(windows)]
fn drives() -> Vec<FsDrive> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        out.push(FsDrive {
            name: format!("{letter}:"),
            path: format!("{letter}:\\"),
        });
    }
    out
}

#[cfg(not(windows))]
fn drives() -> Vec<FsDrive> {
    Vec::new()
}

/// Windows 隐藏属性（0x2）；以 `.` 开头的名字也按隐藏处理（跨平台习惯）
#[cfg(windows)]
fn is_hidden(name: &str, md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    name.starts_with('.') || md.file_attributes() & 0x2 != 0
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _md: &std::fs::Metadata) -> bool {
    name.starts_with('.')
}

fn modified_secs(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 同步实现（调用方负责放到后台线程）
pub fn fs_list_sync(raw: Option<&str>) -> Result<FsListing, AppError> {
    let Some(raw) = raw.map(str::trim).filter(|p| !p.is_empty()) else {
        // 没给路径 = 此电脑：只返回盘符
        return Ok(FsListing {
            path: None,
            parent: None,
            entries: Vec::new(),
            drives: drives(),
            truncated: false,
        });
    };

    let dir = PathBuf::from(raw);
    if !dir.is_absolute() {
        return Err(AppError::new(ErrCode::ConfigInvalid, "需要绝对路径"));
    }
    let rd = std::fs::read_dir(&dir).map_err(|e| {
        AppError::new(ErrCode::IoError, format!("无法读取 {}：{e}", dir.display()))
    })?;

    let mut entries: Vec<FsEntry> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // 读不到元数据的条目（权限 / 刚被删）直接跳过，不让整次列目录失败
        let Ok(md) = e.metadata() else { continue };
        let Ok(ft) = e.file_type() else { continue };
        // DirEntry::metadata 不跟随符号链接：软链到目录的项没有 DIRECTORY 属性，
        // 直接判会显示成「文件」且进不去。只有链接项才多付一次跟随查询。
        let (is_dir, size, modified) = if ft.is_symlink() {
            match std::fs::metadata(e.path()) {
                Ok(target) => (
                    target.is_dir(),
                    if target.is_dir() { 0 } else { target.len() },
                    modified_secs(&target),
                ),
                // 目标已失效：保留链接自身的信息，至少还能被选中 / 定位
                Err(_) => (
                    md.is_dir(),
                    if md.is_dir() { 0 } else { md.len() },
                    modified_secs(&md),
                ),
            }
        } else {
            (
                md.is_dir(),
                if md.is_dir() { 0 } else { md.len() },
                modified_secs(&md),
            )
        };
        entries.push(FsEntry {
            path: e.path().to_string_lossy().to_string(),
            hidden: is_hidden(&name, &md),
            name,
            is_dir,
            size,
            modified,
        });
    }

    // 目录在前，同类按小写名排序：大小写混排时更接近资源管理器的观感
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);

    Ok(FsListing {
        parent: dir
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| p.to_string_lossy().to_string()),
        path: Some(dir.to_string_lossy().to_string()),
        entries,
        drives: Vec::new(),
        truncated,
    })
}

/// 列目录 / 列盘符。`path` 为空 = 此电脑。
#[tauri::command]
pub async fn fs_list(path: Option<String>) -> Result<FsListing, AppError> {
    // 移动盘 / 网络盘上的 read_dir 会阻塞：与其它磁盘类命令一致，挪出 tokio worker
    tauri::async_runtime::spawn_blocking(move || fs_list_sync(path.as_deref()))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "stash-fs-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_dirs_first_and_reports_meta() {
        let dir = temp_dir("list");
        std::fs::create_dir(dir.join("alpha")).unwrap();
        std::fs::write(dir.join("b.txt"), b"hello").unwrap();
        std::fs::write(dir.join("C.bin"), b"").unwrap();

        let out = fs_list_sync(Some(dir.to_string_lossy().as_ref())).unwrap();
        let names: Vec<&str> = out.entries.iter().map(|e| e.name.as_str()).collect();
        // 目录优先；同名次按小写排序（b.txt < C.bin）
        assert_eq!(names, vec!["alpha", "b.txt", "C.bin"]);
        assert!(out.entries[0].is_dir);
        assert_eq!(out.entries[0].size, 0, "目录不做递归统计");
        let file = out.entries.iter().find(|e| e.name == "b.txt").unwrap();
        assert_eq!(file.size, 5);
        assert!(!file.hidden);
        assert_eq!(out.parent.as_deref(), Some(dir.parent().unwrap().to_string_lossy().as_ref()));
        assert!(!out.truncated);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_relative_path() {
        let err = fs_list_sync(Some("Games\\Air")).unwrap_err();
        assert_eq!(err.code, ErrCode::ConfigInvalid);
    }

    #[test]
    fn empty_path_lists_drives_only() {
        let out = fs_list_sync(None).unwrap();
        assert!(out.path.is_none());
        assert!(out.entries.is_empty());
        // 盘符数量取决于机器，只验证结构：每项都是 "X:" 形式
        assert!(out.drives.iter().all(|d| d.name.ends_with(':') && d.path.ends_with(":\\")));
    }

    #[test]
    fn missing_dir_is_io_error() {
        let dir = temp_dir("missing").join("nope");
        let err = fs_list_sync(Some(dir.to_string_lossy().as_ref())).unwrap_err();
        assert_eq!(err.code, ErrCode::IoError);
        assert!(err.message.contains("无法读取"));
    }

}

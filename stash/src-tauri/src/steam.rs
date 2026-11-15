//! Steam 已安装游戏发现。
//!
//! 只读本地文件，不启动 Steam：
//! 1. 注册表 `HKCU\Software\Valve\Steam\SteamPath` 定位主安装目录，
//!    兜底 `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`；
//! 2. 解析 `steamapps/libraryfolders.vdf`，汇总所有 Steam 库（含其他磁盘）；
//! 3. 逐个读取 `steamapps/appmanifest_*.acf`，跳过未安装完成 / 工具 / 无主程序的项目。

use crate::scanner;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Steamworks Common Redistributables：所有库都会出现，不是游戏
const REDIST_APP_ID: u32 = 228_980;
/// AppState.StateFlags 的「已完全安装」位
const STATE_FULLY_INSTALLED: u32 = 0x4;

/// 一部已安装的 Steam 游戏
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteamApp {
    pub app_id: u32,
    pub name: String,
    pub dir: PathBuf,
    pub exe: PathBuf,
}

/// 扫描本机全部 Steam 库，按名称排序返回
pub fn installed_apps() -> Vec<SteamApp> {
    let Some(primary) = steam_root() else {
        return Vec::new();
    };
    let mut by_id: BTreeMap<u32, SteamApp> = BTreeMap::new();
    for lib in library_roots(&primary) {
        for app in library_apps(&lib) {
            // 同一游戏可能装在多个库目录：保留先扫到的一份
            by_id.entry(app.app_id).or_insert(app);
        }
    }
    let mut out: Vec<SteamApp> = by_id.into_values().collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// 解析各 Steam 库下的 appmanifest；纯函数化的目录扫描，便于单测
fn library_apps(library: &Path) -> Vec<SteamApp> {
    let steamapps = library.join("steamapps");
    let Ok(rd) = std::fs::read_dir(&steamapps) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("acf"))
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let fields = pairs(&text);
        let get = |key: &str| {
            fields
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v.clone())
        };
        let Some(app_id) = get("appid").and_then(|v| v.parse::<u32>().ok()) else {
            continue;
        };
        if app_id == REDIST_APP_ID {
            continue;
        }
        // 下载中 / 只装了部分 DLC 的条目不算可启动
        if let Some(state) = get("stateflags").and_then(|v| v.parse::<u32>().ok()) {
            if state & STATE_FULLY_INSTALLED == 0 {
                continue;
            }
        }
        let Some(installdir) = get("installdir") else {
            continue;
        };
        let dir = steamapps.join("common").join(&installdir);
        if !dir.is_dir() {
            continue;
        }
        let Some(exe) = scanner::find_main_exe(&dir) else {
            continue;
        };
        let name = get("name")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| installdir.clone());
        out.push(SteamApp {
            app_id,
            name,
            dir,
            exe,
        });
    }
    out
}

/// 主安装目录 + 其他库目录（去重，且要求 `steamapps` 存在）
fn library_roots(primary: &Path) -> Vec<PathBuf> {
    let mut roots = vec![primary.to_path_buf()];
    let vdf = primary.join("steamapps").join("libraryfolders.vdf");
    if let Ok(text) = std::fs::read_to_string(vdf) {
        for (key, value) in pairs(&text) {
            let new_format = key.eq_ignore_ascii_case("path");
            // 旧版格式是 `"1" "D:\\SteamLibrary"`，键是序号、值直接是路径
            let old_format = key.parse::<u32>().is_ok() && Path::new(&value).is_absolute();
            if new_format || old_format {
                roots.push(PathBuf::from(value));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    roots.retain(|p| {
        if !p.join("steamapps").is_dir() {
            return false;
        }
        let key = p.to_string_lossy().replace('/', "\\").to_lowercase();
        seen.insert(key)
    });
    roots
}

#[cfg(windows)]
fn steam_root() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW,
    };
    const HKCU: &str = "Software\\Valve\\Steam";
    const HKLM: &str = "SOFTWARE\\Valve\\Steam";
    const HKLM32: &str = "SOFTWARE\\WOW6432Node\\Valve\\Steam";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn read(hive: HKEY, sub: &str, name: &str) -> Option<String> {
        let sub = wide(sub);
        let name = wide(name);
        let mut buf = [0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                hive,
                sub.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut _,
                &mut size,
            )
        };
        if rc != 0 {
            return None;
        }
        let len = (size as usize / 2).saturating_sub(1).min(buf.len());
        let s = String::from_utf16_lossy(&buf[..len]);
        (!s.trim().is_empty()).then_some(s)
    }

    let candidates = [
        read(HKEY_CURRENT_USER, HKCU, "SteamPath"),
        read(HKEY_LOCAL_MACHINE, HKLM, "InstallPath"),
        read(HKEY_LOCAL_MACHINE, HKLM32, "InstallPath"),
    ];
    candidates
        .into_iter()
        .flatten()
        .map(|s| PathBuf::from(s.replace('/', "\\")))
        .find(|p| p.join("steamapps").is_dir())
}

#[cfg(not(windows))]
fn steam_root() -> Option<PathBuf> {
    None
}

/// 极简 VDF 词法：引号字符串（支持 `\\` / `\"` 转义）、花括号、裸词、`//` 行注释
fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if c.is_whitespace() {
            continue;
        }
        if c == '/' && it.peek() == Some(&'/') {
            while let Some(&n) = it.peek() {
                if n == '\n' {
                    break;
                }
                it.next();
            }
            continue;
        }
        if c == '{' || c == '}' {
            out.push(c.to_string());
            continue;
        }
        if c == '"' {
            let mut s = String::new();
            while let Some(ch) = it.next() {
                match ch {
                    '\\' => match it.peek() {
                        Some('"') | Some('\\') => {
                            s.push(it.next().unwrap());
                        }
                        _ => s.push('\\'),
                    },
                    '"' => break,
                    _ => s.push(ch),
                }
            }
            out.push(s);
            continue;
        }
        let mut s = String::from(c);
        while let Some(&n) = it.peek() {
            if n.is_whitespace() || n == '{' || n == '}' || n == '"' {
                break;
            }
            s.push(n);
            it.next();
        }
        out.push(s);
    }
    out
}

/// 提取所有「键 值」对（跳过 `键 { ... }` 这种嵌套块头）
fn pairs(text: &str) -> Vec<(String, String)> {
    let t = tokens(text);
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if t[i] == "{" || t[i] == "}" {
            i += 1;
            continue;
        }
        if i + 1 >= t.len() {
            break;
        }
        if t[i + 1] == "{" {
            i += 1;
            continue;
        }
        out.push((t[i].clone(), t[i + 1].clone()));
        i += 2;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_library_folders_new_and_old_format() {
        let text = r#"
            "libraryfolders"
            {
                "0" { "path" "C:\\Program Files (x86)\\Steam" }
                "1" { "path" "D:\\SteamLibrary" }
                "2" "E:\\OldLibrary"
            }
        "#;
        let ps = pairs(text);
        let paths: Vec<&str> = ps
            .iter()
            .filter(|(k, v)| k == "path" || (k.parse::<u32>().is_ok() && Path::new(v).is_absolute()))
            .map(|(_, v)| v.as_str())
            .collect();
        assert_eq!(
            paths,
            vec!["C:\\Program Files (x86)\\Steam", "D:\\SteamLibrary", "E:\\OldLibrary"]
        );
    }

    #[test]
    fn tokenizer_handles_escaped_quotes_and_comments() {
        let text = "\"name\" \"A \\\"quoted\\\" game\" // 注释 \"x\" \"y\"";
        assert_eq!(
            pairs(text),
            vec![("name".to_string(), "A \"quoted\" game".to_string())]
        );
    }

    #[test]
    fn library_apps_skips_uninstalled_and_finds_exe() {
        let base = std::env::temp_dir().join(format!(
            "stash-steam-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let steamapps = base.join("steamapps");
        let game_dir = steamapps.join("common").join("MyVN");
        std::fs::create_dir_all(&game_dir).unwrap();
        std::fs::write(game_dir.join("MyVN.exe"), b"fake").unwrap();
        std::fs::write(
            steamapps.join("appmanifest_100.acf"),
            r#""AppState" { "appid" "100" "name" "My Visual Novel" "installdir" "MyVN" "StateFlags" "4" }"#,
        )
        .unwrap();
        // 下载中（StateFlags 不含 4）且目录内没有 exe：不应出现
        std::fs::write(
            steamapps.join("appmanifest_200.acf"),
            r#""AppState" { "appid" "200" "name" "Downloading" "installdir" "Nope" "StateFlags" "2" }"#,
        )
        .unwrap();

        let apps = library_apps(&base);
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].app_id, 100);
        assert_eq!(apps[0].name, "My Visual Novel");
        assert_eq!(apps[0].exe.file_name().unwrap(), "MyVN.exe");
    }
}

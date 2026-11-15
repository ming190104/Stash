//! tracing 滚动日志：按天一份、单文件 5MB 上限、保留最近 7 天（总预算 35MB）。
//! 目录 %APPDATA%\Stash\logs\，默认 info 级。
//!
//! 为什么不用 tracing-appender 的 RollingFileAppender：它只按时间滚动，
//! 没有容量控制——日志被刷爆时（例如循环报错）单文件能长到几百 MB。
//! 这里自己实现一个 `Write` 落点（总案 10.5「7 份 × 5MB」）：
//! - 当天文件 `stash.<YYYY-MM-DD>.log`，写满 5MB 后另起 `stash.<日期>.<n>.log`；
//! - 进程重启续写当天文件（先取已有长度，已满则直接开下一段）；
//! - 启动与每次滚段时做一次清理：只留最近 7 个日期，并保证目录总量 ≤ 35MB。
//!
//! 用 blocking 写：日志量极低（每日几十条），无需后台线程——
//! non_blocking + 忘记持有 guard 曾实测丢掉全部启动日志（文件 0 字节）。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tracing_subscriber::fmt::MakeWriter;

/// 单文件上限（总案 10.5）
const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// 保留天数
const KEEP_DAYS: usize = 7;
/// 文件名前缀；也用于清理时识别自家日志
const PREFIX: &str = "stash.";

/// 日志写入失败只提示一次（避免每条日志都刷 stderr）
static WRITE_WARNED: AtomicBool = AtomicBool::new(false);

pub fn init() {
    let dir = logs_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        // tracing 还没初始化，只能先打到 stderr；不能让日志链路静默死掉
        eprintln!("stash: 无法创建日志目录 {}：{e}", dir.display());
    }
    cleanup(&dir, KEEP_DAYS, MAX_BYTES);
    let writer = Capped::new(dir.clone(), MAX_BYTES);
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_max_level(tracing::Level::INFO)
        .with_writer(writer)
        .init();
    tracing::info!("log ready: {} ({} MB/份 · 保留 {} 天)", dir.display(), MAX_BYTES / 1024 / 1024, KEEP_DAYS);
}

/// 日志目录（关于页「打开日志目录」与写入共用，避免两处各拼一次路径）
pub fn logs_dir() -> PathBuf {
    // 与 Store 共用同一套根目录决议：迁移失败时日志也跟着留在旧目录
    crate::store::data_root().join("logs")
}

/// 一条 WARN / ERROR（关于页自助排障只展示这两种，INFO 太多会淹掉重点）
pub struct Issue {
    pub time: String,
    pub level: String,
    pub text: String,
}

/// 最近 `limit` 条 WARN/ERROR：从最新一段日志往回读，日期与段号都倒序。
/// 只读最近几份文件：日志总预算 35MB，全量扫描没有意义。
pub fn recent_issues(limit: usize) -> Vec<Issue> {
    let dir = logs_dir();
    let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<(String, u32, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let (date, part) = parse(&name)?;
            Some((date, part, e.path()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

    let mut out: Vec<Issue> = Vec::new();
    for (_, _, path) in files {
        if out.len() >= limit {
            break;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        for line in text.lines().rev() {
            if !line.contains(" WARN ") && !line.contains(" ERROR ") {
                continue;
            }
            let issue = split_line(line);
            // 第三方库的内部告警（设备没映射 / 力反馈慢 / 手柄已拔出）不属于本应用可处理的问题：
            // 原始日志仍保留（「打开日志目录」能看到），但关于页的自助排障列表不再被它刷屏。
            if is_third_party_noise(&issue.text) {
                continue;
            }
            out.push(issue);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

/// 已知的第三方噪声：gilrs 对未知 UUID 设备 / 已拔出设备的内部告警。
fn is_third_party_noise(text: &str) -> bool {
    text.starts_with("gilrs::gamepad: No mapping found")
        || text.starts_with("gilrs::ff::server: One iteration")
        || text.starts_with("gilrs_core::platform::platform::ff: Failed to change FF state")
}

/// `2026-10-22T06:09:33Z  WARN stash_lib::x: msg` → (时间, 级别, 消息)
fn split_line(line: &str) -> Issue {
    let line = line.trim();
    let (time, rest) = line.split_once(' ').unwrap_or((line, ""));
    let rest = rest.trim_start();
    let level = if rest.starts_with("ERROR") { "ERROR" } else { "WARN" };
    let text = rest.strip_prefix(level).unwrap_or(rest).trim_start();
    Issue {
        time: time.to_string(),
        level: level.to_string(),
        text: text.to_string(),
    }
}

/* ============ 落点 ============ */

/// tracing 的 MakeWriter 包装：每条事件取一次匿名 guard，真正写入在 `Inner` 里加锁完成。
struct Capped {
    inner: Mutex<Inner>,
}

impl Capped {
    fn new(dir: PathBuf, max: u64) -> Self {
        Self {
            inner: Mutex::new(Inner { dir, max, date: String::new(), file: None, size: 0, degraded: false }),
        }
    }
}

impl<'a> MakeWriter<'a> for Capped {
    type Writer = Guard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        Guard { inner: &self.inner }
    }
}

struct Guard<'a> {
    inner: &'a Mutex<Inner>,
}

impl Write for Guard<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // 日志写失败不该把业务带崩：锁中毒时当作已写入丢弃
        let r = match self.inner.lock() {
            Ok(mut g) => g.write(buf),
            Err(_) => Ok(buf.len()),
        };
        // tracing 自己会吞掉写入错误：磁盘满 / 目录只读时日志会静默丢光。
        // 至少往 stderr 留一次，别让「排障时发现日志是空的」成为唯一线索。
        if let Err(e) = &r {
            if !WRITE_WARNED.swap(true, Ordering::Relaxed) {
                eprintln!("[log] 日志写入失败（后续日志可能丢失）：{e}");
            }
        }
        r
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.inner.lock() {
            Ok(mut g) => g.flush(),
            Err(_) => Ok(()),
        }
    }
}

struct Inner {
    dir: PathBuf,
    max: u64,
    /// 当前打开文件所属日期（YYYY-MM-DD）
    date: String,
    file: Option<File>,
    size: u64,
    /// 滚段失败（磁盘满 / 目录只读）后置位：继续写当前文件，不再每条日志都重试滚段
    degraded: bool,
}

impl Write for Inner {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let today = today();
        if self.date != today {
            self.open_day(&today)?;
        }
        // 空文件不滚：单条事件本身超过上限时只能让它写进去，否则会无限滚段
        if !self.degraded && self.size > 0 && self.size + buf.len() as u64 > self.max {
            if let Err(e) = self.roll() {
                // 滚段失败时若照常返回错误，之后每条日志都会再试一次并再失败；
                // 标记降级后继续写当前文件，至少保证日志不中断
                self.degraded = true;
                return Err(e);
            }
        }
        let f = self.file.as_mut().ok_or_else(|| io::Error::other("log not opened"))?;
        let n = f.write(buf)?;
        self.size += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

impl Inner {
    /// 切到某一天：已有文件就续写（重启场景），否则新建；已满则直接滚到下一段。
    fn open_day(&mut self, day: &str) -> io::Result<()> {
        let path = self.dir.join(format!("{PREFIX}{day}.log"));
        let (file, size) = if path.exists() {
            let f = OpenOptions::new().append(true).open(&path)?;
            let len = f.metadata()?.len();
            (f, len)
        } else {
            (File::create(&path)?, 0)
        };
        self.file = Some(file);
        self.date = day.to_string();
        self.size = size;
        if self.size >= self.max {
            if let Err(e) = self.roll() {
                self.degraded = true;
                return Err(e);
            }
        }
        Ok(())
    }

    /// 当前段写满：另起 `stash.<日期>.<n>.log`，并顺手做一次清理。
    fn roll(&mut self) -> io::Result<()> {
        let _ = self.flush();
        let mut n = 1u32;
        let file = loop {
            let p = self.dir.join(format!("{PREFIX}{}.{}.log", self.date, n));
            if !p.exists() {
                break File::create(&p)?;
            }
            n += 1;
        };
        self.file = Some(file);
        self.size = 0;
        self.degraded = false;
        cleanup(&self.dir, KEEP_DAYS, self.max);
        Ok(())
    }
}

/* ============ 清理 ============ */

/// 从文件名取 (日期, 段号)：`stash.2026-10-20.log` → ("2026-10-20", 0)；
/// `stash.2026-10-20.3.log` → ("2026-10-20", 3)。旧版 tracing-appender 的
/// `stash.2026-10-20`（无扩展名）同样识别，段号记 0。
fn parse(name: &str) -> Option<(String, u32)> {
    let rest = name.strip_prefix(PREFIX)?;
    let b = rest.as_bytes();
    // 先做 ASCII 检查再切片：日期段固定 10 字节，非 ASCII 文件名（如 `stash.日志.log`）
    // 可能把 `[..10]` 切在多字节字符中间，直接 panic
    if b.len() < 10 || !b[..10].iter().all(u8::is_ascii) {
        return None;
    }
    let date = &rest[..10];
    if b[4] != b'-' || b[7] != b'-' || !b[..4].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let tail = &rest[10..];
    if tail.is_empty() || tail == ".log" {
        return Some((date.to_string(), 0));
    }
    let part = tail.strip_prefix('.')?.strip_suffix(".log")?;
    Some((date.to_string(), part.parse().unwrap_or(0)))
}

/// 只留最近 `keep` 个日期；再把目录总量压到 `keep * max` 以内（从最旧的段开始删）。
fn cleanup(dir: &Path, keep: usize, max: u64) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files: Vec<(String, u32, PathBuf, u64)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let (date, part) = parse(&name)?;
            let size = e.metadata().ok()?.len();
            Some((date, part, e.path(), size))
        })
        .collect();
    if files.is_empty() {
        return;
    }
    files.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    // 日期去重后取最近 keep 个，早于此的一律删
    let oldest_kept = {
        let mut dates: Vec<&str> = files.iter().map(|f| f.0.as_str()).collect();
        dates.dedup();
        let keep_from = dates.len().saturating_sub(keep);
        dates.get(keep_from).copied().unwrap_or("").to_string()
    };
    files.retain(|f| {
        if f.0.as_str() < oldest_kept.as_str() {
            let _ = fs::remove_file(&f.2);
            false
        } else {
            true
        }
    });

    // 总量预算：多段写满一天时会超出，从最旧的段继续删
    let budget = keep as u64 * max;
    let mut total: u64 = files.iter().map(|f| f.3).sum();
    for f in &files {
        if total <= budget {
            break;
        }
        if fs::remove_file(&f.2).is_ok() {
            total = total.saturating_sub(f.3);
        }
    }
}

/* ============ 日期 ============ */

/// 当天日期（UTC，与 tracing-appender 旧命名一致）
pub fn today() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    date_from_days((secs / 86_400) as i64)
}

/// 1970-01-01 起的天数 → YYYY-MM-DD（Howard Hinnant 的 civil_from_days，避免只为格式化日期引依赖）
fn date_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vnlog-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn date_math() {
        assert_eq!(date_from_days(0), "1970-01-01");
        assert_eq!(date_from_days(20_746), "2026-10-20");
        assert_eq!(date_from_days(20_754), "2026-10-28");
        assert_eq!(date_from_days(19_723), "2024-01-01");
    }

    #[test]
    fn filename_parse() {
        assert_eq!(parse("stash.2026-10-20.log"), Some(("2026-10-20".into(), 0)));
        assert_eq!(parse("stash.2026-10-20.12.log"), Some(("2026-10-20".into(), 12)));
        assert_eq!(parse("stash.2026-10-20"), Some(("2026-10-20".into(), 0)));
        assert_eq!(parse("other.2026-10-20.log"), None);
        assert_eq!(parse("stash.bad"), None);
    }

    #[test]
    fn rolls_at_cap() {
        let dir = tmpdir("roll");
        let mut w = Inner {
            dir: dir.clone(),
            max: 200,
            date: String::new(),
            file: None,
            size: 0,
            degraded: false,
        };
        let line = [b'x'; 64];
        for _ in 0..10 {
            w.write_all(&line).unwrap();
        }
        w.flush().unwrap();
        drop(w); // NTFS 的目录项大小在句柄关闭后才刷新，先关再量
        let files: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        // 10 × 64 = 640 字节 / 每段 200 → 至少 4 段
        assert!(files.len() >= 4, "expected ≥4 parts, got {}", files.len());
        for f in &files {
            let len = f.metadata().unwrap().len();
            assert!(len <= 200 || len == 64, "part over cap: {len}");
        }
        // 内容总量不丢
        let mut detail: Vec<String> = files
            .iter()
            .map(|f| format!("{}:{}", f.file_name().to_string_lossy(), f.metadata().unwrap().len()))
            .collect();
        detail.sort();
        let total: u64 = files.iter().map(|f| f.metadata().unwrap().len()).sum();
        assert_eq!(total, 640, "parts = {detail:?}");
    }

    #[test]
    fn resumes_today_file() {
        let dir = tmpdir("resume");
        let day = today();
        let p = dir.join(format!("{PREFIX}{day}.log"));
        fs::write(&p, vec![b'a'; 100]).unwrap();
        let mut w = Inner {
            dir: dir.clone(),
            max: 4096,
            date: String::new(),
            file: None,
            size: 0,
            degraded: false,
        };
        w.write_all(b"hello").unwrap();
        w.flush().unwrap();
        let len = fs::metadata(&p).unwrap().len();
        assert_eq!(len, 105, "应在已有文件后续写而不是覆盖");
    }

    #[test]
    fn cleanup_keeps_recent_days() {
        let dir = tmpdir("clean");
        for d in 1..=10 {
            let name = format!("{PREFIX}2026-10-{d:02}.log");
            fs::write(dir.join(name), vec![b'x'; 10]).unwrap();
        }
        cleanup(&dir, 7, 1024);
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names.len(), 7);
        assert_eq!(names.first().unwrap(), "stash.2026-10-04.log");
        assert_eq!(names.last().unwrap(), "stash.2026-10-10.log");
    }

    #[test]
    fn cleanup_enforces_total_budget() {
        let dir = tmpdir("budget");
        // 同一天 6 段，每段 100 字节；预算 7 天 × 120 = 840 → 应删到 8 段以内
        for n in 0..6 {
            let name = if n == 0 {
                format!("{PREFIX}2026-10-20.log")
            } else {
                format!("{PREFIX}2026-10-20.{n}.log")
            };
            fs::write(dir.join(name), vec![b'x'; 100]).unwrap();
        }
        cleanup(&dir, 7, 120);
        let total: u64 = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.metadata().unwrap().len())
            .sum();
        assert!(total <= 840, "总量应在预算内，实际 {total}");
        assert!(total > 0);
    }

    #[test]
    fn split_warn_error_line() {
        let w = split_line("2026-10-22T06:09:33.123456Z  WARN stash_lib::net: bangumi timeout");
        assert_eq!(w.time, "2026-10-22T06:09:33.123456Z");
        assert_eq!(w.level, "WARN");
        assert_eq!(w.text, "stash_lib::net: bangumi timeout");
        let e = split_line("2026-10-22T06:09:34Z ERROR stash_lib::launcher: 启动失败");
        assert_eq!(e.level, "ERROR");
        assert_eq!(e.text, "stash_lib::launcher: 启动失败");
    }

    #[test]
    fn third_party_noise_is_skipped() {
        assert!(is_third_party_noise(
            "gilrs::gamepad: No mapping found for UUID 00000000-0000-0000-0000-000000000000"
        ));
        assert!(is_third_party_noise(
            "gilrs::ff::server: One iteration of a force feedback loop took more than 20ms!"
        ));
        assert!(is_third_party_noise(
            "gilrs_core::platform::platform::ff: Failed to change FF state – gamepad with id 0 is no longer connected."
        ));
        // 本应用自己的网络 / 存档 / 启动错误必须保留
        assert!(!is_third_party_noise("stash_lib::net: bangumi timeout"));
        assert!(!is_third_party_noise("stash_lib: settings write failed 0123456789abcdef"));
        assert!(!is_third_party_noise("stash_lib::launcher: 启动失败"));
    }

    #[test]
    fn writes_through_subscriber() {
        let dir = tmpdir("sub");
        let sub = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .with_writer(Capped::new(dir.clone(), MAX_BYTES))
            .finish();
        tracing::subscriber::with_default(sub, || {
            tracing::info!("hello-from-test");
            tracing::warn!("second-line");
        });
        let mut text = String::new();
        for f in fs::read_dir(&dir).unwrap().flatten() {
            text.push_str(&fs::read_to_string(f.path()).unwrap());
        }
        assert!(text.contains("hello-from-test"), "日志未落盘：{text:?}");
        assert!(text.contains("second-line"));
    }
}

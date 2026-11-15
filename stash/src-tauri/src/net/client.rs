//! 网络层公共设施：串行阀门、限流冷却、超时 / 代理 / 响应大小上限。

use crate::models::{AppError, ErrCode, Settings};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const UA: &str = concat!(
    "Stash/",
    env!("CARGO_PKG_VERSION"),
    " (local Galgame library front-end; +https://github.com/zhao1171921108-cyber/Stash)"
);
pub(crate) const SEARCH_URL: &str = "https://api.bgm.tv/v0/search/subjects";
/// 旧版搜索（GET）。v0 的 POST 检索对短标题召回极差——
/// 实测搜「AIR」前 10 条全是空战游戏、真正的 AIR（id=232）根本不出现；
/// 「千恋＊万花」「サクラノ詩」同样搜不到正主。旧版接口按名字包含度排序，召回正常，
/// 因此以它为主检索，v0 留作兜底（v0 的结果带标签，会社打分用得上）。
/// 代价：旧版条目不含标签，选中后再用 v0 详情补一次（1 req/s 不变）。
pub(crate) const LEGACY_SEARCH_URL: &str = "https://api.bgm.tv/search/subject";
/// 两次请求之间的最小间隔（总案 7.3：1 / ≥1s）
pub(crate) const TICK: Duration = Duration::from_secs(1);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const RETRIES: usize = 3;
/// 封面走图片 CDN，实测单张 3–9s；元数据接口那套 10s 总超时会把 body 读断
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
/// Bangumi subject type=4 即游戏
pub(crate) const TYPE_GAME: u8 = 4;

/// 串行阀门：保证「同一时刻只有 1 个请求、且间隔 ≥1s」
static GATE: Mutex<Option<Instant>> = Mutex::new(None);
/// 在途许可：guard 活到请求结束，才是真正的「并发 1」
static IN_FLIGHT: Mutex<()> = Mutex::new(());

/// 取得发车许可；返回值必须持有到请求结束（`let _turn = wait_turn();`）
pub(crate) fn wait_turn() -> std::sync::MutexGuard<'static, ()> {
    let flight = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    // 429 之后的全局冷却：只靠 1req/s 仍然会持续撞限流，最后被站点封 IP。
    // 分片睡眠 + 每片重读截止时间：用户点「测试连接 / 重新匹配」会 clear_cooldown()，
    // 不必再干等满 60 秒（旧实现是一觉睡到底，只能等定时器自然到期）。
    loop {
        let left = (*COOLDOWN.lock().unwrap_or_else(|e| e.into_inner()))
            .map(|t| t.saturating_duration_since(Instant::now()))
            .unwrap_or_default();
        if left.is_zero() {
            break;
        }
        std::thread::sleep(left.min(std::time::Duration::from_millis(500)));
    }
    let mut g = GATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(last) = *g {
        let elapsed = last.elapsed();
        if elapsed < TICK {
            std::thread::sleep(TICK - elapsed);
        }
    }
    *g = Some(Instant::now());
    flight
}

/// 429 / 403 之后的冷却截止时间
static COOLDOWN: Mutex<Option<Instant>> = Mutex::new(None);

/// 清掉限流冷却：用户主动重试（换网络 / 换代理 / 点测试连接）时用，不该再等旧的 60 秒
pub(crate) fn clear_cooldown() {
    *COOLDOWN.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 记一次限流：下一个请求至少等这么久。Bangumi 的限流窗口是分钟级的，60s 才有效果。
/// 其他站点（EGS / SDGB / 萌娘百科）共用同一个冷却闸，只是错误文案各自拼。
pub(crate) fn cool_down() {
    *COOLDOWN.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Instant::now() + std::time::Duration::from_secs(60));
}

pub(crate) fn note_rate_limited(status: u16) -> AppError {
    cool_down();
    AppError::new(
        ErrCode::RateLimited,
        format!("Bangumi 限流（HTTP {status}），已暂停 60 秒后自动重试"),
    )
}

/// 文本 / JSON 响应的硬上限：正常 API 响应远小于 1MB，4MB 足够；
/// 站点异常或被劫持的代理返回超大响应时，不应整段读进内存。
pub(crate) const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;

/// 读到上限为止（多读 1 字节供调用方判定超限）。独立成函数便于单测。
fn read_capped<R: std::io::Read>(r: R, max: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut buf = Vec::new();
    r.take(max + 1).read_to_end(&mut buf)?;
    Ok(buf)
}

/// 按上限读取响应体。超限归 ServerError：这是「对端数据异常」，不是本机断网。
pub(crate) fn read_body_limited(
    resp: reqwest::blocking::Response,
    what: &str,
) -> Result<Vec<u8>, AppError> {
    if let Some(len) = resp.content_length() {
        if len > MAX_TEXT_BYTES {
            return Err(AppError::new(
                ErrCode::ServerError,
                format!("{what}响应过大（{len} B），已放弃"),
            ));
        }
    }
    let bytes = read_capped(resp, MAX_TEXT_BYTES)
        .map_err(|e| AppError::new(ErrCode::NetworkOffline, format!("{what}响应读取失败：{e}")))?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(AppError::new(
            ErrCode::ServerError,
            format!("{what}响应超过 {} MB，已放弃", MAX_TEXT_BYTES / 1024 / 1024),
        ));
    }
    Ok(bytes)
}

/// 读取并解析 JSON（同样受 [`MAX_TEXT_BYTES`] 约束）。
pub(crate) fn read_json_limited<T: serde::de::DeserializeOwned>(
    resp: reqwest::blocking::Response,
    what: &str,
) -> Result<T, AppError> {
    let bytes = read_body_limited(resp, what)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| AppError::new(ErrCode::ServerError, format!("{what}响应解析失败：{e}")))
}

pub(crate) fn client(settings: &Settings) -> Result<reqwest::blocking::Client, AppError> {
    build_client(settings, TOTAL_TIMEOUT)
}

/// 封面下载专用：与 API 同一套 UA / 代理 / 连接超时，只把整请求时限放宽
pub(crate) fn download_client(settings: &Settings) -> Result<reqwest::blocking::Client, AppError> {
    build_client(settings, DOWNLOAD_TIMEOUT)
}

/// Windows 系统代理（设置 → 网络和 Internet → 代理 → 手动设置代理）。
/// reqwest 只读 `HTTP_PROXY` 等环境变量，不读 WinINET，所以这里直接读注册表；
/// PAC 自动配置脚本无法在无浏览器环境解析，遇到时按直连处理。
pub fn system_proxy() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let key = wide(KEY);
    let read_dword = |name: &str| -> Option<u32> {
        let val = wide(name);
        let mut out: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                val.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                &mut out as *mut u32 as *mut _,
                &mut size,
            )
        };
        (rc == 0).then_some(out)
    };
    let read_string = |name: &str| -> Option<String> {
        let val = wide(name);
        let mut buf = [0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                val.as_ptr(),
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
        Some(String::from_utf16_lossy(&buf[..len]))
    };
    resolve_system_proxy(read_dword("ProxyEnable"), read_string("ProxyServer").as_deref())
}

/// 系统代理的纯决策层：注册表缺失、`ProxyEnable=0`、只配了 PAC（`ProxyServer` 为空）
/// 都按直连处理。拆出来是为了在没有注册表写入权限的环境里也能单测。
fn resolve_system_proxy(enable: Option<u32>, server: Option<&str>) -> Option<String> {
    if enable? == 0 {
        return None;
    }
    parse_proxy_server(server?)
}

/// 解析注册表 `ProxyServer`：可能是 `host:port`，也可能是
/// `http=host:port;https=host:port;socks=host:port`。后者优先取 https 入口（HTTP CONNECT 通用）。
fn parse_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let (value, scheme) = if raw.contains('=') {
        let pick = |k: &str| {
            raw.split(';')
                .filter_map(|p| p.split_once('='))
                .find(|(n, _)| n.trim().eq_ignore_ascii_case(k))
                .map(|(_, v)| v.trim().to_string())
        };
        pick("https")
            .map(|v| (v, "http"))
            .or_else(|| pick("http").map(|v| (v, "http")))
            .or_else(|| pick("socks").map(|v| (v, "socks5")))
            .or_else(|| pick("socks5").map(|v| (v, "socks5")))?
    } else {
        (raw.to_string(), "http")
    };
    if value.is_empty() || value.contains(' ') {
        return None;
    }
    Some(if value.contains("://") {
        value
    } else {
        format!("{scheme}://{value}")
    })
}

/// 代理地址归一化：注册表 / 旧配置里可能只有 `127.0.0.1:7890`（不带协议）。
/// reqwest 会把它当成 scheme=`127.0.0.1` 的非法代理，之后**每个**请求都报 builder error，
/// 界面上只看到「网络不可达」，根本看不出是代理写法问题。这里补齐 `http://` 并校验协议。
pub(crate) fn proxy_url(p: &str) -> Result<String, AppError> {
    let t = p.trim();
    if t.is_empty() {
        return Err(AppError::new(ErrCode::ConfigInvalid, "代理地址为空"));
    }
    let url = if t.contains("://") { t.to_string() } else { format!("http://{t}") };
    let scheme = url.split("://").next().unwrap_or("").to_ascii_lowercase();
    if !["http", "https", "socks5", "socks5h", "socks4", "socks4a"].contains(&scheme.as_str()) {
        return Err(AppError::new(
            ErrCode::ConfigInvalid,
            format!("代理仅支持 http / https / socks5：{p}"),
        ));
    }
    Ok(url)
}

fn build_client(
    _settings: &Settings,
    total: Duration,
) -> Result<reqwest::blocking::Client, AppError> {
    let mut b = reqwest::blocking::Client::builder()
        .user_agent(UA)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(total);
    // 跟随 Windows 系统代理；配置异常时按直连处理，避免一个坏值让所有请求都「不可达」
    if let Some(p) = system_proxy() {
        match proxy_url(&p) {
            Ok(url) => {
                b = b.proxy(reqwest::Proxy::all(&url).map_err(|e| {
                    AppError::new(ErrCode::ConfigInvalid, format!("系统代理不可用（{p}）：{e}"))
                })?);
            }
            Err(e) => tracing::warn!("系统代理格式不可用，按直连处理：{}", e.message),
        }
    }
    b.build().map_err(|e| AppError::new(ErrCode::NetworkOffline, e.to_string()))
}

/// Bangumi 一旦整体不可达（国内直连常见），本轮不再为每部作品重复等 30s 超时；
/// 「测试连接」会复位，便于更换网络后重试。
static BANGUMI_OFFLINE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn reset_bangumi_offline() {
    BANGUMI_OFFLINE.store(false, std::sync::atomic::Ordering::Relaxed);
    // 上一轮的限流冷却也一并清掉：换了网络 / 代理之后不该继续干等旧的 60 秒
    clear_cooldown();
}

pub(crate) fn bangumi_offline() -> bool {
    BANGUMI_OFFLINE.load(std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn mark_bangumi_offline() {
    BANGUMI_OFFLINE.store(true, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn note_bangumi_error<T>(r: Result<T, AppError>) -> Result<T, AppError> {
    if let Err(ref e) = r {
        if e.code == ErrCode::NetworkOffline {
            mark_bangumi_offline();
        }
    }
    r
}

/// 是否是「连不上主机」类错误（`network_err` 的产物）。
/// 同域名的 v0 此时必然也连不上，不必再重试 3 次白等 30s；
/// HTTP 非 2xx 则是主机可达的逻辑错误，仍值得试一次 v0。
pub(crate) fn transport_failure(e: &AppError) -> bool {
    e.is_transport()
}

pub(crate) fn network_err(e: reqwest::Error, what: &str) -> AppError {
    let msg = if e.is_timeout() {
        format!("{what}超时：{e}")
    } else {
        format!("{what}网络不可达：{e}")
    };
    // 打上 transport 标记：调用方据此判断「同域名的备用接口也不必再试」，
    // 而不是靠 message 里有没有「超时」两个字（模块约定是按结构化信息分支）
    AppError::new(ErrCode::NetworkOffline, msg).transport()
}

/// Bangumi 直连客户端：连接阶段只等 2.5s。
/// 国内到 api.bgm.tv 时通时不通，统一走代理会把本该直连成功的请求拖成整轮超时；
/// 反过来完全不走代理，遇到确实连不上的网络又会全军覆没。
const BANGUMI_CONNECT: Duration = Duration::from_millis(2500);

/// 直连被判不可用后 5 分钟内直接走代理：否则一批 30–80 部作品
/// 每部都要先白等 2.5s，整轮匹配会被拖慢一两分钟。
static BGM_DIRECT_OFF_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn direct_cooling() -> bool {
    BGM_DIRECT_OFF_UNTIL.load(std::sync::atomic::Ordering::Relaxed) > now_ms()
}

fn bangumi_direct() -> Result<reqwest::blocking::Client, AppError> {
    reqwest::blocking::Client::builder()
        .user_agent(UA)
        .connect_timeout(BANGUMI_CONNECT)
        .timeout(TOTAL_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|e| AppError::new(ErrCode::NetworkOffline, e.to_string()))
}

/// 系统是否启用了代理：只有此时 Bangumi 直连失败才有必要回落到代理重试
fn proxy_ready() -> bool {
    system_proxy().is_some()
}

/// Bangumi 请求：先直连，连接/超时类失败且确有代理时再走代理重试一次。
/// 注意只在「没拿到任何响应」时回落——4xx/5xx 是服务端答复，换出口 IP 也不会变。
pub(crate) fn bgm_send(
    settings: &Settings,
    what: &str,
    make: impl Fn(&reqwest::blocking::Client) -> reqwest::blocking::RequestBuilder,
) -> Result<reqwest::blocking::Response, AppError> {
    // 冷却期内直接走代理，不再重复付 2.5s 的连接超时
    if proxy_ready() && direct_cooling() {
        let proxied = client(settings)?;
        return make(&proxied).send().map_err(|e| network_err(e, what));
    }
    let direct = bangumi_direct()?;
    match make(&direct).send() {
        Ok(r) => Ok(r),
        Err(e) if (e.is_connect() || e.is_timeout()) && proxy_ready() => {
            BGM_DIRECT_OFF_UNTIL.store(
                now_ms() + 300_000,
                std::sync::atomic::Ordering::Relaxed,
            );
            let proxied = client(settings)?;
            make(&proxied).send().map_err(|e| network_err(e, what))
        }
        Err(e) => Err(network_err(e, what)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_reader_stops_at_cap() {
        let data = vec![b'a'; 32];
        let got = read_capped(std::io::Cursor::new(&data), 16).unwrap();
        assert_eq!(got.len(), 17, "多读 1 字节供调用方判定超限");
    }

    /// 系统代理注册表的两种写法都要能解析；缺省协议补 http，socks 补 socks5
    #[test]
    fn parses_windows_proxy_server_formats() {
        assert_eq!(
            parse_proxy_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_proxy_server("http=10.0.0.2:8080;https=10.0.0.2:8443").as_deref(),
            Some("http://10.0.0.2:8443")
        );
        assert_eq!(
            parse_proxy_server("socks=127.0.0.1:1080").as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        assert_eq!(
            parse_proxy_server("socks5=127.0.0.1:1080").as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        assert_eq!(
            parse_proxy_server("https://proxy.example:443").as_deref(),
            Some("https://proxy.example:443")
        );
        // 大小写不敏感、允许尾随分号与空格
        assert_eq!(
            parse_proxy_server(" HTTP = 127.0.0.1:7890 ; ").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        // 空值 / 不支持的协议 / 带空格的可疑值都按「不可用」处理
        assert_eq!(parse_proxy_server("  "), None);
        assert_eq!(parse_proxy_server("ftp=127.0.0.1:21"), None);
        assert_eq!(parse_proxy_server("127.0.0.1 7890"), None);
    }

    /// 系统代理决策：必须同时满足「已启用」和「有 ProxyServer」。
    /// 缺 ProxyEnable / ProxyEnable=0 / 只配 PAC 都按直连，不能误用残留地址。
    #[test]
    fn resolve_system_proxy_requires_enabled_and_server() {
        assert_eq!(
            resolve_system_proxy(Some(1), Some("127.0.0.1:7890")).as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(resolve_system_proxy(Some(0), Some("127.0.0.1:7890")), None);
        assert_eq!(resolve_system_proxy(None, Some("127.0.0.1:7890")), None);
        assert_eq!(resolve_system_proxy(Some(1), None), None);
        // 只开了 PAC 自动配置脚本时 ProxyServer 为空：无浏览器环境无法解析，按直连
        assert_eq!(resolve_system_proxy(Some(1), Some("   ")), None);
        // 启动项里的地址格式不合法时同样回落到直连
        assert_eq!(resolve_system_proxy(Some(1), Some("ftp=127.0.0.1:21")), None);
    }

    /// 代理地址归一化：不带协议的写法要补齐 http://（reqwest 会把它当非法 scheme），
    /// 不支持的协议要拒绝，而不是让每个请求都失败
    #[test]
    fn proxy_url_adds_scheme_and_rejects_unknown() {
        assert_eq!(proxy_url("127.0.0.1:7890").unwrap(), "http://127.0.0.1:7890");
        assert_eq!(proxy_url("  http://127.0.0.1:7890 ").unwrap(), "http://127.0.0.1:7890");
        assert_eq!(proxy_url("socks5://127.0.0.1:1080").unwrap(), "socks5://127.0.0.1:1080");
        assert!(proxy_url("ftp://127.0.0.1:21").is_err());
        assert!(proxy_url("   ").is_err());
    }
}

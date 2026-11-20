//! EGS（ErogameScape / 批评空间）第三元数据源：中央値（口碑分）与参考游玩时长。
//!
//! 只做「标题 → 搜索结果第一条 → 作品页」两步，纯 HTML 解析，不带账号。
//! - 使用 EGS 自己的 1 req/s 串行阀门与限流冷却（各站点互不阻塞），同一套代理设置；
//! - EGS 整体不可达时置 OFFLINE，本轮剩余作品直接跳过，不再逐个等超时；
//! - 任何解析失败都返回 None（补不上总比整批匹配失败好）。
//!
//! 2026-10 实测：本机网络下 EGS 的检索页 404、作品页 503（站点维护/地区限制），
//! 因此这条源按「可降级」处理：不可达就静默跳过，评分 / 时长退回 Bangumi。

use crate::models::{AppError, ErrCode, Settings};
use std::sync::atomic::{AtomicBool, Ordering};

const BASE: &str = "https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki";

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct EgsStat {
    /// 中央値（0–100）
    pub score: Option<f64>,
    /// 投票数（拿不到就是 None）
    pub votes: Option<u32>,
    /// プレイ時間中央値（分钟）
    pub minutes: Option<u32>,
}

static OFFLINE: AtomicBool = AtomicBool::new(false);

/// 新一轮全量匹配开始时复位，换网络后可重试
pub fn reset_offline() {
    OFFLINE.store(false, Ordering::Relaxed);
}

fn note_offline(e: &AppError) {
    if e.code == ErrCode::NetworkOffline {
        OFFLINE.store(true, Ordering::Relaxed);
    }
}

fn enc(s: &str) -> String {
    // 只处理 URL 查询串需要的字符，避免额外依赖
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 限流时等完冷却自动重试一次（与 Bangumi / 萌娘百科 同口径）；仍失败才上报
fn fetch(client: &reqwest::blocking::Client, url: &str) -> Result<String, AppError> {
    match fetch_once(client, url) {
        Err(e) if e.code == ErrCode::RateLimited => {
            tracing::warn!("EGS 限流，冷却后自动重试一次");
            fetch_once(client, url)
        }
        r => r,
    }
}

fn fetch_once(client: &reqwest::blocking::Client, url: &str) -> Result<String, AppError> {
    let _turn = crate::net::wait_turn(crate::net::Gate::Egs);
    let resp = client
        .get(url)
        .send()
        .map_err(|e| AppError::new(ErrCode::NetworkOffline, format!("EGS 不可达：{e}")))?;
    let status = resp.status();
    // 只有 429 是真限流；403 多为地区封锁（EGS 对部分 IP 段直接拒绝），
    // 等 60 秒也不会好转；冷却也只作用于 EGS 自己的闸门
    if status.as_u16() == 429 {
        crate::net::cool_down(crate::net::Gate::Egs);
        return Err(AppError::new(
            ErrCode::RateLimited,
            "EGS 限流（HTTP 429），已暂停 60 秒",
        ));
    }
    if !status.is_success() {
        // 403 / 404 / 410 都是「这个源这次用不了」，不是本机断网：
        // 归到 ServerError，上层只会跳过 EGS，不会把整源标成离线
        return Err(AppError::new(
            ErrCode::ServerError,
            format!("EGS 返回 HTTP {}（{url}）", status.as_u16()),
        ));
    }
    let bytes = crate::net::read_body_limited(resp, "EGS")?;
    Ok(decode(&bytes))
}

/// EGS 老页面仍有 Shift_JIS：先按 UTF-8 解，非法字节序列再退回 SJIS
fn decode(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let (s, _, _) = encoding_rs::SHIFT_JIS.decode(bytes);
    s.into_owned()
}

/// 把 HTML 压成纯文本（保留换行），后续按「标记词 → 附近数字」取值
fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if in_tag => {}
            '&' => out.push_str("&amp;"),
            _ => out.push(c),
        }
    }
    out.replace("&amp;nbsp;", " ")
        .replace("&amp;lt;", "<")
        .replace("&amp;gt;", ">")
        .replace("&amp;amp;", "&")
        .replace("&amp;quot;", "\"")
        .replace("&amp;#39;", "'")
}

/// 从 `marker` 之后最多 `window` 个字符里找第一个合法数字（0..=max）
fn number_after(text: &str, marker: &str, max: u32) -> Option<u32> {
    let at = text.find(marker)?;
    let tail: String = text[at + marker.len()..].chars().take(240).collect();
    let mut digits = String::new();
    for c in tail.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            if digits.len() > 6 {
                break;
            }
        } else if !digits.is_empty() {
            break;
        }
    }
    let n: u32 = digits.parse().ok()?;
    (n <= max).then_some(n)
}

/// 「プレイ時間」后的第一段数字 + 单位：12時間 → 720 分，90分 → 90 分
fn minutes_after(text: &str) -> Option<u32> {
    let at = text.find("プレイ時間")?;
    let tail: String = text[at + "プレイ時間".len()..].chars().take(300).collect();
    let mut num = String::new();
    let mut num_end = 0usize;
    let mut started = false;
    for (i, c) in tail.char_indices() {
        if c.is_ascii_digit() {
            started = true;
            num.push(c);
            num_end = i + c.len_utf8();
        } else if started {
            break;
        }
    }
    let n: u32 = num.parse().ok()?;
    let rest = &tail[num_end..];
    let unit: String = rest.chars().take(4).filter(|c| !c.is_whitespace()).collect();
    Some(if unit.starts_with('分') {
        n
    } else {
        // 「1時間30分」要把分钟补上，但只能在「時間」正后方找：
        // 在整段 tail 里找数字会把后面的投票数当成分钟
        let mins = rest
            .trim_start()
            .strip_prefix("時間")
            .map(str::trim_start)
            .and_then(|r| {
                let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
                if r[d.len()..].starts_with('分') {
                    d.parse::<u32>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        n.saturating_mul(60).saturating_add(mins)
    })
}

/// 作品页解析：中央值 / 投票数 / 游玩时长中位数
pub fn parse_stats(html: &str) -> Option<EgsStat> {
    let t = plain(html);
    let score = number_after(&t, "中央値", 100)
        .or_else(|| number_after(&t, "得点", 100))
        .map(|n| n as f64);
    let votes = number_after(&t, "投票数", 999_999);
    let minutes = minutes_after(&t);
    if score.is_none() && minutes.is_none() {
        return None;
    }
    Some(EgsStat { score, votes, minutes })
}

/// 搜索结果页取第一个作品 id。
/// 页面顶部 / 侧栏也有 `game.php?game=` 链接（最近浏览 / 相关作品 / 广告位），
/// 盲取第一条会把别的作品数据写进库；先逐条看链接文字，命中关键词才采用，
/// 都不命中再退回第一条（保持旧行为，不至于一条都拿不到）。
pub fn parse_search_first(html: &str, keyword: &str) -> Option<u32> {
    let t = plain(html);
    if !t.contains(keyword) {
        return None;
    }
    let kw = norm(keyword);
    let key = "game.php?game=";
    let mut first: Option<u32> = None;
    let mut rest = html;
    while let Some(at) = rest.find(key) {
        let tail = &rest[at + key.len()..];
        let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(id) = digits.parse::<u32>() {
            if first.is_none() {
                first = Some(id);
            }
            let label: String = tail
                .find('>')
                .map(|i| tail[i + 1..].chars().take_while(|c| *c != '<').collect())
                .unwrap_or_default();
            if !kw.is_empty() && norm(&label).contains(&kw) {
                return Some(id);
            }
        }
        rest = tail;
    }
    first
}

/// 标题比对用：去掉空白与标点，只留字母 / 数字 / 假名
fn norm(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// 查询一部作品的 EGS 数据；None = 没找到 / 解析不出
pub fn lookup(settings: &Settings, title: &str) -> Result<Option<EgsStat>, AppError> {
    if !settings.network.metadata_enabled {
        return Ok(None);
    }
    let kw = title.trim();
    if kw.is_empty() {
        return Ok(None);
    }
    if OFFLINE.load(Ordering::Relaxed) {
        return Err(AppError::new(
            ErrCode::NetworkOffline,
            "EGS 不可达（本轮已跳过）",
        ));
    }
    let client = crate::net::client(settings)?;
    let search = format!("{BASE}/game_search.php?game_name={}", enc(kw));
    let html = match fetch(&client, &search) {
        Ok(h) => h,
        Err(e) => {
            note_offline(&e);
            return Err(e);
        }
    };
    let Some(id) = parse_search_first(&html, kw) else {
        return Ok(None);
    };
    let page = match fetch(&client, &format!("{BASE}/game.php?game={id}")) {
        Ok(h) => h,
        Err(e) => {
            note_offline(&e);
            return Err(e);
        }
    };
    Ok(parse_stats(&page))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_central_score_and_minutes() {
        let html = r#"
          <table><tr><td>中央値</td><td>82</td></tr>
          <tr><td>投票数</td><td>1234</td></tr>
          <tr><td>プレイ時間</td><td>25時間</td></tr></table>"#;
        let s = parse_stats(html).unwrap();
        assert_eq!(s.score, Some(82.0));
        assert_eq!(s.votes, Some(1234));
        assert_eq!(s.minutes, Some(25 * 60));
    }

    #[test]
    fn parse_minutes_unit() {
        let html = "<td>プレイ時間</td><td>90分</td>";
        assert_eq!(parse_stats(html).unwrap().minutes, Some(90));
    }

    #[test]
    fn parse_minutes_hours_plus_minutes_only() {
        // 「1時間30分」= 90 分，不能被算成 60
        let html = "<td>プレイ時間</td><td>1時間30分</td>";
        assert_eq!(parse_stats(html).unwrap().minutes, Some(90));
        // 「時間」后面没有紧邻的「数字+分」时，不能把后面的投票数当分钟
        let html = "<td>プレイ時間</td><td>12時間</td><td>投票数</td><td>500</td>";
        assert_eq!(parse_stats(html).unwrap().minutes, Some(720));
    }

    #[test]
    fn parse_search_id() {
        let html = r#"<a href="game.php?game=12345">千恋＊万花</a>"#;
        assert_eq!(parse_search_first(html, "千恋＊万花"), Some(12345));
        assert_eq!(parse_search_first(html, "别的东西"), None);
    }

    /// 页头 / 侧栏的「最近浏览」链接排在结果前面时，不能拿它当搜索结果
    #[test]
    fn parse_search_skips_decoy_links() {
        let html = r#"<div class="recent"><a href="game.php?game=999">最近見たゲーム</a></div>
            <table><tr><td><a href="game.php?game=12345">千恋＊万花</a></td></tr></table>"#;
        assert_eq!(parse_search_first(html, "千恋＊万花"), Some(12345));
        // 页面上有关键词、但没有任何链接文字对得上时退回第一条，保持旧行为
        let only_decoy = r#"<h1>千恋＊万花 の検索結果</h1>
            <div class="recent"><a href="game.php?game=999">最近見たゲーム</a></div>"#;
        assert_eq!(parse_search_first(only_decoy, "千恋＊万花"), Some(999));
    }

    #[test]
    fn empty_page_is_none() {
        assert!(parse_stats("<html><body>メンテナンス</body></html>").is_none());
    }
}

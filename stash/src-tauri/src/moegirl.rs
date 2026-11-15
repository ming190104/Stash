//! 萌娘百科兜底检索（MediaWiki API）。
//!
//! 站点匿名只开放了部分查询模块（`prop=revisions` / `list=search` / `action=parse`
//! 都返回 `action-notallowed`），实测可用的是：
//! - `action=opensearch`：标题联想，用来找条目；
//! - `action=query&prop=extracts|pageimages`：纯文本首段 + 页面主图。
//!
//! 定位：Bangumi 召回不足（<80 分）时，用中文简介 / 年份 / 竖版主图兜底。
//! 与 Bangumi / EGS 共用 1 req/s 串行阀门；站点不可达时本轮直接短路（`OFFLINE`）。
//!
//! 许可：萌娘百科正文为 CC BY-NC-SA，详情页「元数据」角标会标出来源；
//! 这里只取简介首段（≤1200 字），不做全文搬运。

use crate::models::{AppError, ErrCode, Settings};
use std::sync::atomic::{AtomicBool, Ordering};

const API: &str = "https://zh.moegirl.org.cn/api.php";

/// 本轮不可达：后续作品不再逐个白等超时，由主动重试（测试连接 / 重匹配）复位
static OFFLINE: AtomicBool = AtomicBool::new(false);

pub(crate) fn reset_offline() {
    OFFLINE.store(false, Ordering::Relaxed);
}

/// 命中条目（只保留库界面用得到的字段）
#[derive(Debug, Clone)]
pub struct Article {
    /// 页面标题（通常就是中文译名）
    pub title: String,
    /// 与查询的相似度 0–100
    pub score: u32,
    pub summary: Option<String>,
    pub year: Option<u32>,
    /// 页面主图：只有竖版才收——横版头图裁成 2:3 封面会很难看
    pub cover: Option<String>,
}

/// 按标题检索并取首段。无相似条目 / 页面取不到时返回 `Ok(None)`；
/// 网络与限流错误原样返回，由调用方决定是否忽略。
pub fn lookup(s: &Settings, keyword: &str) -> Result<Option<Article>, AppError> {
    let kw = keyword.trim();
    if kw.is_empty() || !s.network.metadata_enabled {
        return Ok(None);
    }
    if OFFLINE.load(Ordering::Relaxed) {
        return Err(AppError::new(
            ErrCode::NetworkOffline,
            "萌娘百科不可达（本轮已跳过）",
        ));
    }
    let titles = match opensearch(s, kw) {
        Ok(v) => v,
        Err(e) => {
            note_error(&e);
            return Err(e);
        }
    };
    let Some((best, title)) = titles
        .into_iter()
        .map(|t| (title_score(kw, &t), t))
        .max_by_key(|(sc, _)| *sc)
    else {
        return Ok(None);
    };
    // 只用「完全一致 / 互为包含」：联想结果里常混着原声带、衍生动画、
    // 同名角色，78 分级别的模糊命中会让简介写错作品
    if best < 82 {
        return Ok(None);
    }

    let page = match page_info(s, &title) {
        Ok(v) => v,
        Err(e) => {
            note_error(&e);
            return Err(e);
        }
    };
    let Some(page) = page else {
        return Ok(None);
    };
    let score = best.max(title_score(kw, &page.title));
    let summary = page
        .extract
        .as_deref()
        .map(str::trim)
        .filter(|t| t.chars().count() >= 8)
        .map(|t| cap_chars(t, 1200));
    let year = summary.as_deref().and_then(year_in);
    if summary.is_none() && page.cover.is_none() {
        // 条目存在但没有任何可用内容：宁可当没命中，也不要把空数据写进库
        return Ok(None);
    }
    Ok(Some(Article {
        title: page.title,
        score,
        summary,
        year,
        cover: page.cover,
    }))
}

fn note_error(e: &AppError) {
    if e.code == ErrCode::NetworkOffline {
        OFFLINE.store(true, Ordering::Relaxed);
    }
}

/// 一次 API 调用：共用串行阀门，429 进入全局冷却
fn get_json(
    s: &Settings,
    params: &[(&str, &str)],
    what: &str,
) -> Result<serde_json::Value, AppError> {
    let c = crate::net::client(s)?;
    let _turn = crate::net::wait_turn();
    let resp = c
        .get(API)
        .query(params)
        .send()
        .map_err(|e| AppError::new(ErrCode::NetworkOffline, format!("{what}不可达：{e}")))?;
    let status = resp.status();
    if status.as_u16() == 429 {
        crate::net::cool_down();
        return Err(AppError::new(
            ErrCode::RateLimited,
            format!("{what}限流（HTTP 429），已暂停 60 秒"),
        ));
    }
    if !status.is_success() {
        return Err(AppError::new(
            ErrCode::ServerError,
            format!("{what}返回 HTTP {}", status.as_u16()),
        ));
    }
    crate::net::read_json_limited(resp, what)
}

/// 标题联想：只返回 ns0（条目）里的候选
fn opensearch(s: &Settings, kw: &str) -> Result<Vec<String>, AppError> {
    let v = get_json(
        s,
        &[
            ("action", "opensearch"),
            ("search", kw),
            ("limit", "6"),
            ("namespace", "0"),
            ("format", "json"),
            ("formatversion", "2"),
        ],
        "萌娘百科",
    )?;
    Ok(parse_titles(&v))
}

fn parse_titles(v: &serde_json::Value) -> Vec<String> {
    v.get(1)
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

struct Page {
    title: String,
    extract: Option<String>,
    cover: Option<String>,
}

/// 首段纯文本 + 页面主图，一次请求同时拿
fn page_info(s: &Settings, title: &str) -> Result<Option<Page>, AppError> {
    let v = get_json(
        s,
        &[
            ("action", "query"),
            ("prop", "extracts|pageimages"),
            ("exintro", "1"),
            ("explaintext", "1"),
            ("piprop", "original"),
            ("redirects", "1"),
            ("titles", title),
            ("format", "json"),
            ("formatversion", "2"),
        ],
        "萌娘百科",
    )?;
    Ok(parse_page(&v))
}

fn parse_page(v: &serde_json::Value) -> Option<Page> {
    let page = v.pointer("/query/pages/0")?;
    if page.get("missing").and_then(|m| m.as_bool()).unwrap_or(false)
        || page.get("invalid").is_some()
    {
        return None;
    }
    let title = page
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        return None;
    }
    let extract = page
        .get("extract")
        .and_then(|e| e.as_str())
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string);
    let cover = page.get("original").and_then(|o| {
        let url = o.get("source")?.as_str()?.trim();
        let w = o.get("width")?.as_u64()?;
        let h = o.get("height")?.as_u64()?;
        // 严格竖版：横版头图（例如 ATRI 的 header）当封面会被裁得只剩中间一条
        (!url.is_empty() && h > w).then(|| url.to_string())
    });
    Some(Page {
        title,
        extract,
        cover,
    })
}

/// 标题相似度：归一化后完全相同 90，互为包含 82，其余 0（口径与其它源一致）
fn title_score(query: &str, name: &str) -> u32 {
    let q = crate::net::normalize(query);
    let n = crate::net::normalize(name);
    if q.is_empty() || n.is_empty() {
        return 0;
    }
    if q == n {
        90
    } else if n.contains(&q) || q.contains(&n) {
        82
    } else {
        0
    }
}

fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 从简介里找第一个 1950–2100 的四位年份（首段通常是发售年）
fn year_in(v: &str) -> Option<u32> {
    let chars: Vec<char> = v.chars().collect();
    for i in 0..chars.len().saturating_sub(3) {
        if chars[i..i + 4].iter().all(|c| c.is_ascii_digit()) {
            let s: String = chars[i..i + 4].iter().collect();
            if let Ok(y) = s.parse::<u32>() {
                if (1950..=2100).contains(&y) {
                    return Some(y);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_score_matches_with_decorations() {
        assert_eq!(title_score("千恋万花", "千恋万花"), 90);
        assert_eq!(title_score("千恋＊万花", "千恋万花"), 90);
        assert_eq!(title_score("ATRI", "ATRI -My Dear Moments-"), 82);
        assert_eq!(title_score("CLANNAD", "AIR"), 0);
        assert_eq!(title_score("***", "AIR"), 0);
    }

    #[test]
    fn opensearch_payload_yields_titles() {
        let v: serde_json::Value = serde_json::from_str(
            r#"["千恋万花",["千恋万花","千恋万花原声带","千变万花 妄想崇拜"],[],["u1","u2","u3"]]"#,
        )
        .unwrap();
        assert_eq!(
            parse_titles(&v),
            vec!["千恋万花", "千恋万花原声带", "千变万花 妄想崇拜"]
        );
        // 结构漂移时给空列表，不 panic
        assert!(parse_titles(&serde_json::json!({"error": "x"})).is_empty());
    }

    #[test]
    fn page_keeps_portrait_cover_only() {
        let portrait = serde_json::json!({
            "query": {"pages": [{
                "title": "千恋万花",
                "extract": "《千恋＊万花》是由柚子社制作的一部美少女游戏。",
                "original": {"source": "https://x/a.jpg", "width": 480, "height": 605}
            }]}
        });
        let p = parse_page(&portrait).unwrap();
        assert_eq!(p.cover.as_deref(), Some("https://x/a.jpg"));
        assert_eq!(p.extract.as_deref().map(|s| s.contains("柚子社")), Some(true));

        let banner = serde_json::json!({
            "query": {"pages": [{
                "title": "ATRI -My Dear Moments-",
                "extract": "《ATRI》是视觉小说。",
                "original": {"source": "https://x/header.jpg", "width": 1920, "height": 620}
            }]}
        });
        assert_eq!(parse_page(&banner).unwrap().cover, None);

        let missing = serde_json::json!({"query": {"pages": [{"title": "x", "missing": true}]}});
        assert!(parse_page(&missing).is_none());
    }

    #[test]
    fn year_picks_first_plausible() {
        assert_eq!(
            year_in("《千恋＊万花》……本作曾获得2016年美少女游戏大赏综合部门第一名"),
            Some(2016)
        );
        assert_eq!(year_in("7月29日发售"), None);
    }
}

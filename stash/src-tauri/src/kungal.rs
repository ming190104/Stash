//! 鲲 Galgame（KUN Visual Novel）第四元数据源：标题 / 原名 / 年份 / 简介 / 封面 / 评分 / 时长。
//!
//! 官方提供 OpenAPI（`apps/api/openapi/kungal-v1.json`），匿名可读：
//! - 搜索：`GET {BASE}/search/works?q=<关键词>&limit=<n>&include_nsfw=true`
//! - 详情：`GET {BASE}/works/<work_id>?include_nsfw=true`
//!
//! 站点在国内可直连，因此固定 `no_proxy()`：系统代理通常只服务 Bangumi，
//! 把国内站点也绕出去只会更慢。与 Bangumi / 萌娘百科 / EGS 共用 1 req/s 串行阀门；
//! 整源不可达时置 OFFLINE，本轮剩余作品直接跳过，用户主动重试时复位。
//!
//! 许可：站点为社区开源项目，元数据仅用于本地库展示；详情页来源角标会标出「鲲 Galgame」。

use crate::models::{AppError, ErrCode, Settings};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const BASE: &str = "https://www.kungal.com/api/v1";
const UA: &str = concat!(
    "Stash/",
    env!("CARGO_PKG_VERSION"),
    " (local Galgame library front-end; +https://github.com/zhao1171921108-cyber/VN-SHELF)"
);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(12);

/// 本轮不可达：后续作品不再逐个白等超时，由主动重试（测试连接 / 重匹配）复位
static OFFLINE: AtomicBool = AtomicBool::new(false);

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

/// 统一后的作品数据（M 站字段已折算成库内口径）
#[derive(Debug, Clone, Default)]
pub struct Work {
    /// 作品 id（也是网页 `/galgame/<id>` 的 id）
    pub id: String,
    /// 中文标题优先，没有中文就用原名
    pub title: String,
    /// 原名（`display_name`）
    pub original: Option<String>,
    pub year: Option<u32>,
    pub summary: Option<String>,
    pub cover: Option<String>,
    /// 站内评分已归一成 0–100（原值 0–10）
    pub score: Option<f64>,
    pub votes: Option<u32>,
    /// 参考时长（分钟），优先取 EGS 聚合值
    pub minutes: Option<u32>,
    /// 其它标题（匹配打分用）
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct Image {
    #[serde(default)]
    url: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct Localized {
    #[serde(default)]
    value: String,
}

/// 搜索结果条目（`WorkSummary` 的用得到的子集）
#[derive(Debug, Clone, Deserialize, Default)]
struct Hit {
    #[serde(default)]
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    localized: HashMap<String, Localized>,
    #[serde(default)]
    cover: Option<Image>,
    #[serde(default)]
    cover_sfw: Option<Image>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    rating_score: Option<f64>,
    #[serde(default)]
    rating_count: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
struct SearchResp {
    #[serde(default)]
    items: Vec<Hit>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct Intro {
    #[serde(default)]
    locale: String,
    #[serde(default)]
    value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct Playtime {
    #[serde(default)]
    site: String,
    #[serde(default)]
    minutes: u32,
}

/// 详情（`Work` 的用得到的子集）
#[derive(Debug, Clone, Deserialize, Default)]
struct Detail {
    #[serde(default)]
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    localized: HashMap<String, Localized>,
    #[serde(default)]
    cover: Option<Image>,
    #[serde(default)]
    cover_sfw: Option<Image>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    rating_score: Option<f64>,
    #[serde(default)]
    rating_count: Option<u32>,
    #[serde(default)]
    intros: Vec<Intro>,
    #[serde(default)]
    playtimes: Vec<Playtime>,
}

fn client() -> Result<reqwest::blocking::Client, AppError> {
    reqwest::blocking::Client::builder()
        .user_agent(UA)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|e| AppError::new(ErrCode::NetworkOffline, format!("鲲 Galgame 客户端失败：{e}")))
}

fn get_json<T: DeserializeOwned>(url: &str, what: &str) -> Result<T, AppError> {
    let c = client()?;
    let _turn = crate::net::wait_turn();
    let resp = c
        .get(url)
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
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::new(ErrCode::NotFound, format!("{what}：条目不存在")));
    }
    if !status.is_success() {
        // 5xx / 403 是「这个源这次用不了」，不该把整源标成离线
        return Err(AppError::new(
            ErrCode::ServerError,
            format!("{what}返回 HTTP {}", status.as_u16()),
        ));
    }
    crate::net::read_json_limited(resp, what)
}

/// 按标题搜索，返回站内顺序的结果（成人作品一并返回，用于匹配 R18 游戏）。
/// 搜索结果不含简介，`summary` 为空；需要简介时再按 id [`lookup`]。
pub fn search(s: &Settings, keyword: &str, limit: usize) -> Result<Vec<Work>, AppError> {
    if !s.network.metadata_enabled {
        return Ok(Vec::new());
    }
    let kw = keyword.trim();
    if kw.is_empty() {
        return Ok(Vec::new());
    }
    if OFFLINE.load(Ordering::Relaxed) {
        return Err(AppError::new(
            ErrCode::NetworkOffline,
            "鲲 Galgame 不可达（本轮已跳过）",
        ));
    }
    let limit = limit.clamp(1, 20);
    let url = format!(
        "{BASE}/search/works?q={}&limit={limit}&include_nsfw=true",
        enc(kw)
    );
    match get_json::<SearchResp>(&url, "鲲 Galgame 搜索") {
        Ok(r) => Ok(r
            .items
            .into_iter()
            .filter(|h| !h.id.is_empty())
            .map(from_hit)
            .collect()),
        Err(e) => {
            note_offline(&e);
            Err(e)
        }
    }
}

/// 按作品 id 取详情。返回统一后的 [`Work`]；找不到返回 NotFound。
pub fn lookup(s: &Settings, id: &str) -> Result<Work, AppError> {
    if !s.network.metadata_enabled {
        return Err(AppError::new(ErrCode::ConfigInvalid, "在线元数据未开启"));
    }
    let id = id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::new(ErrCode::ConfigInvalid, "无效的鲲 Galgame 作品 id"));
    }
    if OFFLINE.load(Ordering::Relaxed) {
        return Err(AppError::new(
            ErrCode::NetworkOffline,
            "鲲 Galgame 不可达（本轮已跳过）",
        ));
    }
    let url = format!("{BASE}/works/{id}?include_nsfw=true");
    match get_json::<Detail>(&url, "鲲 Galgame 详情") {
        Ok(d) => Ok(to_work(d)),
        Err(e) => {
            note_offline(&e);
            Err(e)
        }
    }
}

/// 连通性探测：一次最简搜索，能拿到响应即视为可达
pub fn probe(s: &Settings) -> Result<(), AppError> {
    search(s, "CLANNAD", 1).map(|_| ())
}

fn zh_title(d: &Detail) -> Option<String> {
    for key in ["zh-Hans", "zh-Hant"] {
        if let Some(v) = d.localized.get(key) {
            if !v.value.trim().is_empty() {
                return Some(v.value.trim().to_string());
            }
        }
    }
    None
}

fn pick_cover(d: &Detail) -> Option<String> {
    let pick = |x: &Option<Image>| {
        x.as_ref()
            .map(|i| i.url.trim().to_string())
            .filter(|u| !u.is_empty())
    };
    pick(&d.cover_sfw).or_else(|| pick(&d.cover))
}

fn year_of(date: Option<&str>) -> Option<u32> {
    let d = date?.trim();
    if d.len() < 4 {
        return None;
    }
    d[..4].parse().ok()
}

/// 简介语言优先级：简体 > 繁体 > 日文 > 英文 > 第一条
fn pick_summary(intros: &[Intro]) -> Option<String> {
    for locale in ["zh-Hans", "zh-Hant", "ja", "en"] {
        if let Some(i) = intros.iter().find(|i| i.locale == locale) {
            let v = i.value.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    intros
        .iter()
        .map(|i| i.value.trim())
        .find(|v| !v.is_empty())
        .map(str::to_string)
}

/// 参考时长优先级：EGS 聚合 > VNDB > 第一条有效值（与项目「EGS 口径」一致）
fn pick_minutes(list: &[Playtime]) -> Option<u32> {
    for site in ["erogamescape", "vndb"] {
        if let Some(p) = list.iter().find(|p| p.site == site && p.minutes > 0) {
            return Some(p.minutes);
        }
    }
    list.iter().find(|p| p.minutes > 0).map(|p| p.minutes)
}

fn to_work(d: Detail) -> Work {
    let title = zh_title(&d).unwrap_or_else(|| d.display_name.trim().to_string());
    let cover = pick_cover(&d);
    let original = {
        let name = d.display_name.trim().to_string();
        if name.is_empty() || name == title {
            d.localized
                .get("ja")
                .map(|v| v.value.trim().to_string())
                .filter(|v| !v.is_empty())
        } else {
            Some(name)
        }
    };
    Work {
        id: d.id,
        title,
        original,
        year: year_of(d.release_date.as_deref()),
        summary: pick_summary(&d.intros),
        cover,
        // 站内 0–10 分 → 库内 0–100 口径
        score: d.rating_score.map(|sc| (sc * 10.0).round()),
        votes: d.rating_count,
        minutes: pick_minutes(&d.playtimes),
        aliases: d.aliases,
    }
}

fn from_hit(h: Hit) -> Work {
    let title = h
        .localized
        .get("zh-Hans")
        .or_else(|| h.localized.get("zh-Hant"))
        .map(|v| v.value.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| h.display_name.trim().to_string());
    let original = {
        let name = h.display_name.trim().to_string();
        (name != title && !name.is_empty()).then_some(name)
    };
    Work {
        id: h.id,
        title,
        original,
        year: year_of(h.release_date.as_deref()),
        summary: None,
        cover: pick_cover(&Detail {
            cover: h.cover,
            cover_sfw: h.cover_sfw,
            ..Detail::default()
        }),
        score: h.rating_score.map(|sc| (sc * 10.0).round()),
        votes: h.rating_count,
        minutes: None,
        aliases: Vec::new(),
    }
}

fn norm(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// 标题相似度（0–100）：别名 / 原名 / 中文名任一完全一致 100，互相包含 82，其余 60。
/// 仅用于候选排序与「匹配度」展示，不参与自动绑定判定。
pub fn title_score(keyword: &str, w: &Work) -> u32 {
    let kw = norm(keyword);
    if kw.is_empty() {
        return 60;
    }
    let mut names: Vec<&str> = vec![w.title.as_str()];
    if let Some(o) = &w.original {
        names.push(o);
    }
    names.extend(w.aliases.iter().map(String::as_str));
    let mut best = 60;
    for n in names {
        let n = norm(n);
        if n.is_empty() {
            continue;
        }
        if n == kw {
            return 100;
        }
        if n.contains(&kw) || kw.contains(&n) {
            best = best.max(82);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(json: &str) -> Detail {
        serde_json::from_str(json).unwrap()
    }

    /// 中文标题优先；简介按简中 > 繁中 > 日 > 英；评分 ×10；时长取 EGS 聚合
    #[test]
    fn maps_detail_fields() {
        let d = detail(
            r#"{
              "id":"4145","display_name":"アマカノ３","aliases":["甜蜜女友3"],
              "localized":{"zh-Hans":{"value":"甜蜜女友 3"},"ja":{"value":"アマカノ３"}},
              "cover_sfw":null,
              "cover":{"url":"https://img.example/a.webp"},
              "release_date":"2025-09-26",
              "rating_score":8.3,"rating_count":52,
              "intros":[
                {"locale":"en","value":"English intro"},
                {"locale":"ja","value":"日本語紹介"},
                {"locale":"zh-Hans","value":"中文简介"}
              ],
              "playtimes":[
                {"site":"vndb","minutes":1950},
                {"site":"erogamescape","minutes":1380}
              ]
            }"#,
        );
        let w = to_work(d);
        assert_eq!(w.title, "甜蜜女友 3");
        assert_eq!(w.original.as_deref(), Some("アマカノ３"));
        assert_eq!(w.year, Some(2025));
        assert_eq!(w.summary.as_deref(), Some("中文简介"));
        assert_eq!(w.cover.as_deref(), Some("https://img.example/a.webp"));
        assert_eq!(w.score, Some(83.0));
        assert_eq!(w.votes, Some(52));
        assert_eq!(w.minutes, Some(1380));
    }

    /// 没有中文简介时按 繁中 > 日 > 英 回退；cover_sfw 优先
    #[test]
    fn falls_back_for_summary_and_cover() {
        let d = detail(
            r#"{
              "id":"1","display_name":"作品",
              "cover":{"url":"https://img.example/orig.webp"},
              "cover_sfw":{"url":"https://img.example/sfw.webp"},
              "intros":[{"locale":"ja","value":"日本語"},{"locale":"zh-Hant","value":"繁體"}],
              "playtimes":[{"site":"vndb","minutes":600}]
            }"#,
        );
        let w = to_work(d);
        assert_eq!(w.summary.as_deref(), Some("繁體"));
        assert_eq!(w.cover.as_deref(), Some("https://img.example/sfw.webp"));
        assert_eq!(w.minutes, Some(600));
        assert_eq!(w.year, None);
        assert_eq!(w.score, None);
    }

    /// 搜索结果只在拿不到详情时兜底使用：标题 / 年份 / 评分仍要能映射
    #[test]
    fn maps_search_hit_without_detail() {
        let h: Hit = serde_json::from_str(
            r#"{"id":"479","display_name":"アマカノ","localized":{"zh-Hans":{"value":"甜蜜女友1"}},
                "cover":{"url":"https://img.example/1.webp"},"release_date":"2014-12-19",
                "rating_score":7.5,"rating_count":6}"#,
        )
        .unwrap();
        let w = from_hit(h);
        assert_eq!(w.id, "479");
        assert_eq!(w.title, "甜蜜女友1");
        assert_eq!(w.original.as_deref(), Some("アマカノ"));
        assert_eq!(w.year, Some(2014));
        assert_eq!(w.score, Some(75.0));
        assert_eq!(w.summary, None);
    }

    #[test]
    fn title_score_matches_alias_and_contains() {
        let w = Work {
            title: "甜蜜女友 3".into(),
            original: Some("アマカノ３".into()),
            aliases: vec!["Amakano 3".into()],
            ..Work::default()
        };
        assert_eq!(title_score("甜蜜女友3", &w), 100);
        assert_eq!(title_score("amakano3", &w), 100);
        assert_eq!(title_score("甜蜜女友", &w), 82);
        assert_eq!(title_score("别的作品", &w), 60);
    }

    #[test]
    fn rejects_bad_work_id() {
        let s = Settings::default();
        assert_eq!(
            lookup(&s, "abc").unwrap_err().code,
            ErrCode::ConfigInvalid
        );
    }
}

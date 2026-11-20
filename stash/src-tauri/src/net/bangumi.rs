//! Bangumi 检索与打分：旧版 GET 为主、v0 兜底，结果重排与相似度打分。

use crate::models::{AppError, ErrCode, Settings};
use serde::{Deserialize, Serialize};

use super::client::{
    bangumi_offline, bgm_send, mark_bangumi_offline, note_bangumi_error, note_rate_limited,
    read_json_limited, transport_failure, wait_turn, Gate, LEGACY_SEARCH_URL, RETRIES, SEARCH_URL,
    TICK, TYPE_GAME,
};

/// Bangumi 返回条目（只取用得到的字段）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub id: u32,
    /// 原名
    pub name: String,
    /// 中文译名（可能为空）
    pub name_cn: Option<String>,
    pub images_large: Option<String>,
    pub summary: Option<String>,
    /// 发售年（从 date 取前 4 位）
    pub year: Option<u32>,
    pub score: Option<f64>,
    pub tags: Vec<String>,
    /// 收藏人数：用来在「同名条目（本体 / FD / 番外）」里选本体——
    /// 本体收藏数通常高一个数量级，比搜索排名可靠
    pub collection: u32,
}

/// 待确认 / 手动绑定用的候选
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub subject: Subject,
    /// 匹配得分（总案 7.2）
    pub score: u32,
    /// 候选封面在本地的缓存路径（`thumbs/cand-<id>.webp`）。
    /// 前端 CSP 只放行 `asset:`，不能直接用 Bangumi 的图片 URL，所以由后端下载并缓存；
    /// 下载失败 / 条目没有封面时为 None，列表退回纯文字。
    pub thumb: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiSearchResp {
    #[serde(default)]
    data: Vec<ApiSubject>,
}

#[derive(Debug, Deserialize)]
struct ApiSubject {
    id: u32,
    name: String,
    #[serde(default)]
    name_cn: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    images: Option<ApiImages>,
    #[serde(default)]
    rating: Option<ApiRating>,
    #[serde(default)]
    tags: Vec<ApiTag>,
    #[serde(default)]
    collection: Option<ApiCollection>,
}

#[derive(Debug, Deserialize)]
struct ApiCollection {
    #[serde(default)]
    collect: u32,
}

#[derive(Debug, Deserialize)]
struct ApiImages {
    #[serde(default)]
    large: String,
}

#[derive(Debug, Deserialize)]
struct ApiRating {
    #[serde(default)]
    score: f64,
}

#[derive(Debug, Deserialize)]
struct ApiTag {
    #[serde(default)]
    name: String,
}

/// 旧版搜索响应：`{ "results": 27, "list": [...] }`（条目不含标签）
#[derive(Debug, Deserialize)]
struct LegacyResp {
    #[serde(default)]
    list: Vec<LegacySubject>,
}

#[derive(Debug, Deserialize)]
struct LegacySubject {
    id: u32,
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_cn: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    air_date: Option<String>,
    #[serde(default)]
    images: Option<ApiImages>,
    #[serde(default)]
    rating: Option<ApiRating>,
    #[serde(default)]
    collection: Option<ApiCollection>,
}

fn year_of(date: Option<&str>) -> Option<u32> {
    date.and_then(|d| d.get(0..4)).and_then(|y| y.parse::<u32>().ok())
}

/// 搜索作品（type=4 游戏）。优先旧版 GET（召回好），失败或空结果再走 v0 POST。
/// 返回候选列表，已按 Bangumi 返回顺序排列（打分依赖这个顺序算递减奖励）。
pub fn search(settings: &Settings, keyword: &str) -> Result<Vec<Subject>, AppError> {
    if !settings.network.metadata_enabled {
        // 这是「没开开关」而不是「网络断了」：报 NetworkOffline 会让调用方把整轮
        // 匹配当成离线短路，日志里也只剩一句误导人的「不可达」
        return Err(AppError::new(ErrCode::ConfigInvalid, "在线元数据未开启（设置 · 网络）"));
    }
    if bangumi_offline() {
        return Err(AppError::new(
            ErrCode::NetworkOffline,
            "Bangumi 不可达（本轮已跳过，萌娘百科兜底仍可用）",
        ));
    }
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    match legacy_search(settings, keyword) {
        Ok(list) if !list.is_empty() => Ok(order_for_query(list, keyword)),
        Ok(_) => note_bangumi_error(
            search_v0(settings, keyword).map(|l| order_for_query(l, keyword)),
        ),
        // 限流时不能立刻再打 v0（会加重封禁）；但 429 常是短窗口突发，
        // 等完冷却再自动重试一次主源就够了，仍失败才把限流上报给调用方
        Err(e) if e.code == ErrCode::RateLimited => {
            tracing::warn!("Bangumi 限流（{keyword}），冷却后自动重试一次");
            match legacy_search(settings, keyword) {
                Ok(list) if !list.is_empty() => Ok(order_for_query(list, keyword)),
                Ok(_) => search_v0(settings, keyword).map(|l| order_for_query(l, keyword)),
                Err(e) => Err(e),
            }
        }
        Err(e) => {
            // 连不上主机：v0 同一域名，重试也只是再等 3 个超时
            if transport_failure(&e) {
                mark_bangumi_offline();
                return Err(e);
            }
            tracing::warn!("legacy search failed ({keyword}): {}，回退 v0", e.message);
            note_bangumi_error(
                search_v0(settings, keyword).map(|l| order_for_query(l, keyword)),
            )
        }
    }
}

/// 旧版搜索：`GET /search/subject/<keyword>?type=4&responseGroup=large&max_results=10`
fn legacy_search(settings: &Settings, keyword: &str) -> Result<Vec<Subject>, AppError> {
    let mut url = reqwest::Url::parse(LEGACY_SEARCH_URL)
        .map_err(|e| AppError::new(ErrCode::NetworkOffline, e.to_string()))?;
    url.path_segments_mut()
        .map_err(|_| AppError::new(ErrCode::NetworkOffline, "URL 构造失败"))?
        .push(keyword);
    url.query_pairs_mut()
        .append_pair("type", "4")
        .append_pair("responseGroup", "large")
        .append_pair("max_results", "10");

    let _turn = wait_turn(Gate::Bangumi);
    let resp = bgm_send(settings, "旧版搜索", |c| c.get(url.clone()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(Vec::new()); // 无结果时旧版会 404
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN {
        return Err(note_rate_limited(status.as_u16()));
    }
    if !status.is_success() {
        // 5xx / 其他非 2xx 是「服务端出错」，不是「网络不可达」：
        // 归成 NetworkOffline 会触发整轮离线短路（后面所有作品都不再请求），
        // 一次临时的 502 就被当成了断网。
        return Err(AppError::new(
            ErrCode::ServerError,
            format!("Bangumi 旧版搜索返回 HTTP {}", status.as_u16()),
        ));
    }
    let parsed: LegacyResp = read_json_limited(resp, "旧版搜索")?;
    Ok(parsed.list.into_iter().map(to_subject_legacy).collect())
}

/// v0 POST 搜索（兜底；结果带标签）
fn search_v0(settings: &Settings, keyword: &str) -> Result<Vec<Subject>, AppError> {
    let body = serde_json::json!({
        "keyword": keyword,
        "filter": { "type": [TYPE_GAME] }
    });

    let mut last_err: Option<AppError> = None;
    for attempt in 0..RETRIES {
        let _turn = wait_turn(Gate::Bangumi);
        match bgm_send(settings, "搜索", |c| c.post(SEARCH_URL).json(&body)) {
            Ok(resp) => {
                let status = resp.status();
                if status == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || status == reqwest::StatusCode::FORBIDDEN
                {
                    return Err(note_rate_limited(status.as_u16()));
                }
                if !status.is_success() {
                    last_err = Some(AppError::new(
                        ErrCode::ServerError,
                        format!("Bangumi 返回 HTTP {}", status.as_u16()),
                    ));
                } else {
                    let parsed: ApiSearchResp = read_json_limited(resp, "搜索")?;
                    return Ok(parsed.data.into_iter().map(to_subject).collect());
                }
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
        // 指数退避：1s → 2s（配合 TICK 的 1s，实际 2s → 3s）
        if attempt + 1 < RETRIES {
            std::thread::sleep(TICK * (1 << attempt));
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::new(ErrCode::NetworkOffline, "请求失败")))
}

/// 取单个条目（手动绑定 / 校验用）
pub fn subject(settings: &Settings, id: u32) -> Result<Subject, AppError> {
    if !settings.network.metadata_enabled {
        return Err(AppError::new(ErrCode::ConfigInvalid, "在线元数据未开启"));
    }
    let _turn = wait_turn(Gate::Bangumi);
    let url = format!("https://api.bgm.tv/v0/subjects/{id}");
    let resp = bgm_send(settings, "Bangumi 条目", |c| c.get(&url))?;
    let status = resp.status();
    if !status.is_success() {
        // 429/403 必须进全局冷却；5xx 是服务端问题，不能报成「断网」；404/410 才是条目不存在
        let n = status.as_u16();
        if n == 429 || n == 403 {
            return Err(note_rate_limited(n));
        }
        let code = match n {
            404 | 410 => ErrCode::NotFound,
            _ => ErrCode::ServerError,
        };
        return Err(AppError::new(
            code,
            format!("Bangumi 条目请求失败（HTTP {n}）"),
        ));
    }
    let s: ApiSubject = read_json_limited(resp, "Bangumi 条目")?;
    Ok(to_subject(s))
}

fn to_subject(a: ApiSubject) -> Subject {
    let year = year_of(a.date.as_deref());
    Subject {
        id: a.id,
        name: a.name,
        name_cn: Some(a.name_cn).filter(|s| !s.is_empty()),
        images_large: a.images.map(|i| i.large).filter(|s| !s.is_empty()),
        summary: Some(a.summary).filter(|s| !s.is_empty()),
        year,
        score: a.rating.map(|r| r.score),
        tags: a.tags.into_iter().map(|t| t.name).take(8).collect(),
        collection: a.collection.map(|c| c.collect).unwrap_or(0),
    }
}

fn to_subject_legacy(a: LegacySubject) -> Subject {
    Subject {
        id: a.id,
        name: a.name,
        name_cn: Some(a.name_cn).filter(|s| !s.is_empty()),
        images_large: a.images.map(|i| i.large).filter(|s| !s.is_empty()),
        summary: Some(a.summary).filter(|s| !s.is_empty()),
        year: year_of(a.air_date.as_deref()),
        score: a.rating.map(|r| r.score),
        tags: Vec::new(), // 旧版条目不带标签：选中后由 v0 详情补齐
        collection: a.collection.map(|c| c.collect).unwrap_or(0),
    }
}

/// 结果重排：完全同名的排最前，其次「标题包含关键字」的按收藏数降序，
/// 其余保持接口原序。目的：同名作品的本体 / FD / 番外里，本体收藏数通常高一个数量级，
/// 比接口排名可靠（实测 WA2 的 mini FD、planetarian 的雪圈球会被排到本体之前）。
/// 重排后再算「排名递减」奖励，等于把收藏数当作并列名次的第一权重。
fn order_for_query(list: Vec<Subject>, keyword: &str) -> Vec<Subject> {
    let q = normalize(keyword);
    if q.is_empty() {
        return list;
    }
    let (mut exact, mut contains, mut rest) = (Vec::new(), Vec::new(), Vec::new());
    for s in list {
        let n = normalize(&s.name);
        let cn = s.name_cn.as_deref().map(normalize).unwrap_or_default();
        if n == q || cn == q {
            exact.push(s);
        } else if n.contains(&q) || cn.contains(&q) {
            contains.push(s);
        } else {
            rest.push(s);
        }
    }
    contains.sort_by_key(|b| std::cmp::Reverse(b.collection));
    exact.extend(contains);
    exact.extend(rest);
    exact
}

/// 查询清洗：砍掉副标题（～ / ~ / — / – 之后）并去掉装饰符号。
/// 真实库名常带「＊」「～…～」，Bangumi 对这类写法召回很差（实测「千恋＊万花」搜不到正主）。
pub fn simplify_query(s: &str) -> Option<String> {
    let base = s.split(['～', '~', '—', '–']).next().unwrap_or(s);
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, '＊' | '☆' | '★' | '♪' | '・' | '　'))
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.chars().count() >= 2 && cleaned != s.trim() {
        Some(cleaned)
    } else {
        None
    }
}

/// 相似度打分（总案 7.2）：完全一致 100 / 包含 60 / 会社命中 30 /
/// 编辑距离 0–40 / 搜索结果排名递减 10、8、6…
pub fn score(query: &str, subject: &Subject, rank: usize, company: Option<&str>) -> u32 {
    let q = normalize(query);
    // 归一化后为空（目录名只有符号 / 装饰）时不能继续：空串 `contains("")` 恒真，
    // 每个候选都会拿到 60 分并进「待确认」，等于给任意作品乱写元数据
    if q.is_empty() {
        return 0;
    }
    let name = normalize(&subject.name);
    let cn = subject.name_cn.as_deref().map(normalize).unwrap_or_default();

    // 缩写目录名（`DDLC-1.1.1-pc`）字面上跟原名毫无重叠，编辑距离只能给个位数；
    // 这里按词首字母补一档「包含级」，让它至少进「待确认」而不是「未匹配」
    let acro = acronym_hit(query, &subject.name)
        || subject
            .name_cn
            .as_deref()
            .map(|n| acronym_hit(query, n))
            .unwrap_or(false);

    let mut s: u32 = 0;
    for candidate in [&name, &cn] {
        if candidate.is_empty() {
            continue;
        }
        if *candidate == q {
            s = s.max(100);
        } else if candidate.contains(&q) || q.contains(candidate.as_str()) {
            s = s.max(60);
        } else {
            // 编辑距离转 0–40：距离越短分越高
            let d = levenshtein(&q, candidate);
            let longest = q.chars().count().max(candidate.chars().count()).max(1);
            let sim = 1.0 - (d as f64 / longest as f64);
            if sim > 0.0 {
                s = s.max((sim * 40.0).round() as u32);
            }
        }
    }
    if acro {
        s = s.max(60);
    }

    // PE CompanyName 与条目里的会社线索一致（标签 / 原名中出现即算命中）
    if let Some(c) = company {
        let c = normalize(c);
        if !c.is_empty()
            && (name.contains(&c)
                || subject
                    .tags
                    .iter()
                    .any(|t| normalize(t).contains(&c) || c.contains(&normalize(t))))
        {
            s += 30;
        }
    }

    // 排名递减 10 / 8 / 6…
    let rank_bonus = 10u32.saturating_sub((rank as u32) * 2);
    s.saturating_add(rank_bonus)
}

/// 归一化：全角 ASCII 折成半角，只留中日文与字母数字。
/// 中黑点 `・`（U+30FB）不算字符：`千恋・万花` 与 `千恋万花` 必须视为同名。
pub(crate) fn normalize(s: &str) -> String {
    s.chars()
        .filter_map(|c| {
            // 全角 ！-～（U+FF01–FF5E）与半角 ASCII 一一对应；中文输入法很常见
            let c = match c {
                '\u{ff01}'..='\u{ff5e}' => char::from_u32(c as u32 - 0xfee0).unwrap_or(c),
                _ => c,
            };
            let keep = c.is_alphanumeric()
                || ('\u{3041}'..='\u{309f}').contains(&c) // 平假名
                || ('\u{30a1}'..='\u{30fa}').contains(&c) // 片假名（显式排除 U+30FB ・）
                || ('\u{30fc}'..='\u{30ff}').contains(&c) // 长音 / 重复记号
                || ('\u{4e00}'..='\u{9fff}').contains(&c);
            keep.then_some(c)
        })
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// 目录名常被写成「缩写 + 版本号 / 平台后缀」（`DDLC-1.1.1-pc`）：
/// 取查询里开头的纯字母段作为缩写，与候选名的词首字母比对。
/// 命中只按「包含级」60 分算（→ 待确认），不会自动入库。
fn acronym_hit(query: &str, name: &str) -> bool {
    let mut parts = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty());
    let Some(head) = parts.next() else { return false };
    // 只有「缩写 + 后缀」这种形态才算：查询本身就是一个词时不猜
    if parts.next().is_none() {
        return false;
    }
    if !(2..=8).contains(&head.chars().count()) || !head.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let initials: String = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().next().is_some_and(|c| c.is_alphabetic()))
        .filter_map(|t| t.chars().next())
        .collect();
    initials.chars().count() >= 2 && initials.eq_ignore_ascii_case(head)
}

/// 目录名常带版本号 / 平台 / 语言后缀：`DDLC-1.1.1-pc` → `DDLC`。
/// 只在尾部确实是这类噪声时才给变体；带副标题、带续作数字的普通标题原样不动。
pub fn clean_name(s: &str) -> Option<String> {
    let parts: Vec<&str> = s
        .split(['-', '_'])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 {
        return None;
    }
    let mut end = parts.len();
    while end > 1 {
        let low = parts[end - 1].to_ascii_lowercase();
        // v1.2 / 1.1.1 / 1.0b 这类版本号
        let body = low.strip_prefix('v').unwrap_or(&low);
        let ver = !body.is_empty()
            && body
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == 'a' || c == 'b');
        let tag = matches!(
            low.as_str(),
            "pc"
                | "win"
                | "windows"
                | "x64"
                | "x86"
                | "jp"
                | "jpn"
                | "en"
                | "eng"
                | "chs"
                | "cht"
                | "zh"
                | "cn"
                | "hd"
                | "remaster"
                | "portable"
                | "setup"
                | "rip"
        );
        if ver || tag {
            end -= 1;
        } else {
            break;
        }
    }
    if end == parts.len() {
        return None;
    }
    let out = parts[..end].join(" ");
    (out.chars().count() >= 2 && out != s.trim()).then_some(out)
}

/// 判定档位（总案 7.2）：≥80 自动入库；50–80 待确认；<50 未匹配
pub fn tier(score: u32) -> MatchTier {
    if score >= 80 {
        MatchTier::Auto
    } else if score >= 50 {
        MatchTier::Pending
    } else {
        MatchTier::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchTier {
    /// ≥80：自动入库
    Auto,
    /// 50–80：入库但标「待确认」
    Pending,
    /// <50：未匹配，支持手动绑定
    None,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(name: &str, cn: &str, tags: &[&str]) -> Subject {
        Subject {
            id: 1,
            name: name.into(),
            name_cn: Some(cn.to_string()).filter(|s| !s.is_empty()),
            images_large: None,
            summary: None,
            year: Some(2004),
            score: None,
            tags: tags.iter().map(|t| (*t).to_string()).collect(),
            collection: 0,
        }
    }

    #[test]
    fn exact_title_hits_full_score() {
        let s = sub("CLANNAD", "CLANNAD", &[]);
        // 归一化后完全一致 → 100，再加排名第一的 10 分（封顶在 saturating）
        assert_eq!(score("CLANNAD", &s, 0, None), 110);
        assert_eq!(tier(score("CLANNAD", &s, 0, None)), MatchTier::Auto);
    }

    #[test]
    fn clean_name_strips_version_and_platform() {
        assert_eq!(clean_name("DDLC-1.1.1-pc").as_deref(), Some("DDLC"));
        assert_eq!(clean_name("CLANNAD_Full_v1.2").as_deref(), Some("CLANNAD Full"));
        assert_eq!(clean_name("CLANNAD"), None, "没有噪声后缀就不要造变体");
        assert_eq!(clean_name("WHITE ALBUM2"), None);
        assert_eq!(clean_name("樱之诗 - 在樱花之森上飞舞"), None, "副标题不能被当成噪声砍掉");
    }

    #[test]
    fn acronym_query_lands_in_pending() {
        // 真实案例：目录名 DDLC-1.1.1-pc，正主是 Doki Doki Literature Club!
        assert!(acronym_hit("DDLC-1.1.1-pc", "Doki Doki Literature Club!"));
        assert!(!acronym_hit("DDLC-1.1.1-pc", "Doki Doki Literature Club Plus!"));
        assert!(!acronym_hit("DDLC", "Doki Doki Literature Club!"), "只有一个词时不猜缩写");
        let s = sub("Doki Doki Literature Club!", "心跳文学部！", &[]);
        let sc = score("DDLC-1.1.1-pc", &s, 0, None);
        assert!(sc >= 50, "缩写目录名应进待确认，实际 {sc}");
        assert!(sc < 80, "缩写不算完全一致，不该自动入库，实际 {sc}");
    }

    #[test]
    fn containment_scores_sixty_plus_rank() {
        let s = sub("WHITE ALBUM 2", "", &[]);
        // "白色相簿2" 与原名无字面包含关系；用原名片段试包含
        let sc = score("WHITE ALBUM", &s, 2, None);
        assert!(sc >= 60, "包含关系应 ≥60，实际 {sc}");
    }

    #[test]
    fn company_match_adds_thirty() {
        let s = sub("千恋＊万花", "", &["柚子社"]);
        let without = score("千恋＊万花", &s, 0, None);
        let with = score("千恋＊万花", &s, 0, Some("柚子社"));
        assert_eq!(with, without + 30);
    }

    #[test]
    fn unrelated_query_lands_in_none_tier() {
        let s = sub("CLANNAD", "", &[]);
        let sc = score("完全不相干的标题", &s, 9, None);
        assert_eq!(tier(sc), MatchTier::None, "得分 {sc} 应落在未匹配档");
    }

    #[test]
    fn tier_boundaries() {
        assert_eq!(tier(80), MatchTier::Auto);
        assert_eq!(tier(79), MatchTier::Pending);
        assert_eq!(tier(50), MatchTier::Pending);
        assert_eq!(tier(49), MatchTier::None);
    }

    #[test]
    fn levenshtein_basic() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("abc", "abc"), 0);
        assert_eq!(levenshtein("", "ab"), 2);
    }

    /// 真实联网集成测试：默认 ignore（CI 不该依赖外网）。
    /// 手动跑：`cargo test --lib -- --ignored --nocapture live_search_reaches_bangumi`
    /// 需要代理的机器：在 Windows「设置 → 网络和 Internet → 代理」里开启系统代理
    #[test]
    #[ignore]
    fn live_search_reaches_bangumi() {
        let mut s = crate::models::Settings::default();
        s.network.metadata_enabled = true;
        let list = search(&s, "CLANNAD").expect("真实请求应成功（本机需能直连 api.bgm.tv）");
        assert!(!list.is_empty(), "应至少返回一条结果");
        let first = &list[0];
        println!(
            "Bangumi 首条: id={} name={} nameCn={:?} year={:?} tags={:?}",
            first.id, first.name, first.name_cn, first.year, first.tags
        );
        assert!(first.id > 0);
        assert!(first.images_large.is_some(), "首条应带封面地址");
        // 打分链路应给出「自动入库」档
        assert_eq!(tier(score("CLANNAD", first, 0, None)), MatchTier::Auto);
    }

    #[test]
    fn normalize_strips_symbols_and_width() {
        // 全角星号 / 空格 / 大小写差异都应被抹平
        assert_eq!(normalize("千恋＊万花"), normalize("千恋 万花"));
        assert_eq!(normalize("CLANNAD"), normalize("clannad"));
        // 全角字母数字折成半角：中文输入法下很常见
        assert_eq!(normalize("ＡＩＲ"), normalize("AIR"));
        assert_eq!(normalize("１２３"), "123");
        // 中黑点不是字符：带点与不带点必须同名
        assert_eq!(normalize("千恋・万花"), normalize("千恋万花"));
    }

    /// 目录名只有符号时归一化为空：不能靠 `contains("")` 恒真给所有候选 60 分
    #[test]
    fn symbol_only_query_scores_zero() {
        let s = sub("CLANNAD", "", &[]);
        assert_eq!(score("★☆", &s, 0, None), 0);
    }

    #[test]
    fn simplify_strips_decorations_and_subtitle() {
        assert_eq!(simplify_query("千恋＊万花").as_deref(), Some("千恋万花"));
        assert_eq!(simplify_query("サクラノ詩 —櫻の森の上を舞う—").as_deref(), Some("サクラノ詩"));
        assert_eq!(simplify_query("素晴らしき日々～不連続存在～").as_deref(), Some("素晴らしき日々"));
        assert_eq!(simplify_query("CLANNAD"), None);
        assert_eq!(simplify_query("AIR"), None);
    }

    /// 同名作品：完全一致的排最前；都包含关键字时收藏数高的（本体）排前面
    #[test]
    fn order_prefers_exact_then_collection() {
        let mut a = sub("planetarian -雪圏球-", "", &[]);
        a.collection = 900;
        let mut b = sub("planetarian ～ちいさなほしのゆめ～", "", &[]);
        b.collection = 3000;
        let mut c = sub("planetarian", "", &[]);
        c.collection = 50;
        let out = order_for_query(vec![a, b, c], "planetarian");
        assert_eq!(out[0].name, "planetarian", "完全同名应排第一，哪怕收藏数最低");
        assert_eq!(out[1].name, "planetarian ～ちいさなほしのゆめ～", "本体收藏数高，应压过雪圈球");
        assert_eq!(out[2].name, "planetarian -雪圏球-");
    }

    /// 真实联网：演示库 10 部的可复跑准确率指标（自动入库 / 待确认 / 未匹配 + 首选条目）。
    /// 手动跑：在 Windows 设置里开启系统代理后 `cargo test --lib live_match_demo_library -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_match_demo_library() {
        let mut s = Settings::default();
        s.network.metadata_enabled = true;

        let demo = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("demo-library");
        let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&demo)
            .expect("需要演示库")
            .flatten()
            .filter(|e| e.path().is_dir() && e.path().join("meta.json").exists())
            .map(|e| e.path())
            .collect();
        dirs.sort();

        let (mut auto, mut pending, mut none) = (0, 0, 0);
        for d in dirs {
            let raw = std::fs::read_to_string(d.join("meta.json")).unwrap_or_default();
            let raw = raw.trim_start_matches('\u{feff}');
            let meta: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
            let orig = meta.get("titleOriginal").and_then(|v| v.as_str()).unwrap_or("");
            let dev = meta.get("developer").and_then(|v| v.as_str());
            let dirname = d.file_name().unwrap().to_string_lossy().to_string();

            let mut kws: Vec<String> = Vec::new();
            for k in [orig.to_string(), dirname.clone()] {
                if !k.trim().is_empty() && !kws.contains(&k) {
                    kws.push(k);
                }
            }
            if let Some(k) = kws.first().and_then(|k| simplify_query(k)) {
                kws.push(k);
            }

            let mut best: Option<(u32, Subject, String)> = None;
            for kw in kws.iter().take(3) {
                let list = search(&s, kw).unwrap_or_default();
                for (i, sub) in list.iter().enumerate() {
                    let sc = score(kw, sub, i, dev);
                    if best.as_ref().map(|(b, _, _)| sc > *b).unwrap_or(true) {
                        best = Some((sc, sub.clone(), kw.clone()));
                    }
                }
                if best.as_ref().map(|(b, _, _)| *b >= 80).unwrap_or(false) {
                    break;
                }
            }
            match best {
                Some((sc, sub, kw)) => {
                    let t = tier(sc);
                    match t {
                        MatchTier::Auto => auto += 1,
                        MatchTier::Pending => pending += 1,
                        MatchTier::None => none += 1,
                    }
                    println!(
                        "{dirname:<12} kw={kw:<12} -> id={} name={} cn={:?} score={sc} {:?}",
                        sub.id, sub.name, sub.name_cn, t
                    );
                }
                None => {
                    none += 1;
                    println!("{dirname:<12} -> 无结果");
                }
            }
        }
        println!("==== auto={auto} pending={pending} none={none} ====");
    }
}

//! 第三方图片源：SteamGridDB 封面 + hero 横幅。
//!
//! 需要用户自填 API Key；缺 Key 时直接 `Ok(None)` 静默跳过，绝不阻塞
//! Bangumi 主链路。请求共用 net 的串行阀门（1 req/s + 429 冷却），
//! 5xx 单独归为 ServerError，避免被误判成断网而整轮短路。

use crate::models::{AppError, ErrCode, Settings};

const SGDB_API: &str = "https://www.steamgriddb.com/api/v2";

/// 标题相似度（0–100），口径与 Bangumi / 萌娘百科对齐：
/// 归一化后完全相同 90；互为包含 82；否则不算命中（0）。
pub fn title_score(query: &str, name: &str) -> u32 {
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

/// 只做 URL 编码（空格、日文、括号都要转）：不为此引入 percent-encoding 依赖。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// HTTP 状态归类。
///
/// 只有 429 才进全局冷却：旧实现把 403 也当限流，一次填错的 API Key 会让整轮匹配
/// 每部作品都白等 60 秒（12 部 = 12 分钟），且界面只看到「已暂停 60 秒」看不出是凭据错。
/// 凭据类 4xx 归 `ConfigInvalid`（上层会把它带回 UI 让用户改设置），404 归 `NotFound`——
/// 都不能伪装成「网络不可达」，否则会被上层当成断网短路掉整轮匹配。
fn status_err(what: &str, code: u16) -> AppError {
    match code {
        429 => {
            // 与 Bangumi / EGS / 萌娘百科共用冷却闸，否则下一部作品会立刻再撞一次
            crate::net::cool_down();
            AppError::new(
                ErrCode::RateLimited,
                format!("{what} 限流（HTTP 429），已暂停 60 秒"),
            )
        }
        400 | 401 | 403 => AppError::new(
            ErrCode::ConfigInvalid,
            format!("{what} 拒绝访问（HTTP {code}）：请检查 设置 → 网络 里的 API 凭据"),
        ),
        404 | 410 => AppError::new(ErrCode::NotFound, format!("{what} 找不到资源（HTTP {code}）")),
        c if c >= 500 => AppError::new(ErrCode::ServerError, format!("{what} 服务端错误（HTTP {c}）")),
        c => AppError::new(ErrCode::ServerError, format!("{what} 返回 HTTP {c}")),
    }
}

fn key_of(s: &str) -> Option<&str> {
    let k = s.trim();
    (!k.is_empty()).then_some(k)
}

/* ============ SteamGridDB：封面（竖版优先，退横版） ============ */

/// 按标题搜 SteamGridDB 条目 id：autocomplete 对译名 / 带版本号的目录名经常返回
/// 完全无关的作品，所以取「标题相似度最高」的一条，0 分直接当没命中。
fn sgdb_game_id(
    c: &reqwest::blocking::Client,
    key: &str,
    kw: &str,
) -> Result<Option<u64>, AppError> {
    let search = {
        let _turn = crate::net::wait_turn();
        let resp = c
            .get(format!("{SGDB_API}/search/autocomplete/{}", urlencode(kw)))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
            .send()
            .map_err(|e| AppError::new(ErrCode::NetworkOffline, format!("SteamGridDB 不可达：{e}")))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(status_err("SteamGridDB", status.as_u16()));
        }
        crate::net::read_json_limited::<serde_json::Value>(resp, "SteamGridDB")?
    };
    let Some(best) = search
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| {
            a.iter().max_by_key(|g| {
                title_score(kw, g.get("name").and_then(|n| n.as_str()).unwrap_or(""))
            })
        })
    else {
        return Ok(None);
    };
    let best_name = best.get("name").and_then(|n| n.as_str()).unwrap_or("");
    if title_score(kw, best_name) == 0 {
        tracing::info!("SteamGridDB：没有相似条目，跳过（{kw}）");
        return Ok(None);
    }
    Ok(best.get("id").and_then(|v| v.as_u64()))
}

/// 按标题搜一张竖版封面；无凭据 / 无结果返回 None，网络错误原样返回给调用方决定是否忽略
pub fn sgdb_cover(settings: &Settings, title: &str) -> Result<Option<String>, AppError> {
    let Some(key) = settings.network.sgdb_key.as_deref().and_then(key_of) else {
        return Ok(None);
    };
    let kw = title.trim();
    if kw.is_empty() {
        return Ok(None);
    }
    let c = crate::net::client(settings)?;
    let Some(id) = sgdb_game_id(&c, key, kw)? else {
        return Ok(None);
    };

    // dimensions=600x900 即 2:3 竖版（Galgame 轨道就是竖封面）；取不到再退横版
    for q in ["?dimensions=600x900,342x482&types=static&limit=8", "?types=static&limit=8"] {
        let _turn = crate::net::wait_turn();
        let resp = c
            .get(format!("{SGDB_API}/grids/game/{id}{q}"))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
            .send()
            .map_err(|e| AppError::new(ErrCode::NetworkOffline, format!("SteamGridDB 不可达：{e}")))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(status_err("SteamGridDB", status.as_u16()));
        }
        let v: serde_json::Value = crate::net::read_json_limited(resp, "SteamGridDB")?;
        if let Some(url) = v
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.iter().find_map(|g| g.get("url").and_then(|u| u.as_str())))
        {
            return Ok(Some(url.to_string()));
        }
    }
    Ok(None)
}

/* ============ SteamGridDB：hero 横幅（详情页背景） ============ */

/// 按标题搜一张横版 hero（商店横幅，常见 1920×620 / 3840×1240），
/// 返回「地址 + 原始尺寸」，由调用方按有效面积和其他源比较。
/// 无凭据 / 无结果返回 None；网络错误原样返回给调用方决定是否忽略。
pub fn sgdb_hero(settings: &Settings, title: &str) -> Result<Option<(String, [u32; 2])>, AppError> {
    let Some(key) = settings.network.sgdb_key.as_deref().and_then(key_of) else {
        return Ok(None);
    };
    let kw = title.trim();
    if kw.is_empty() {
        return Ok(None);
    }
    let c = crate::net::client(settings)?;
    let Some(id) = sgdb_game_id(&c, key, kw)? else {
        return Ok(None);
    };
    let _turn = crate::net::wait_turn();
    let resp = c
        .get(format!("{SGDB_API}/heroes/game/{id}?types=static&limit=16"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .send()
        .map_err(|e| AppError::new(ErrCode::NetworkOffline, format!("SteamGridDB 不可达：{e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(status_err("SteamGridDB", status.as_u16()));
    }
    let v: serde_json::Value = crate::net::read_json_limited(resp, "SteamGridDB")?;
    // 同一部作品常混着 1920×620 和 3840×1240 两档，取尺寸最大的那张
    Ok(v.get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| {
            a.iter()
                .filter_map(|h| {
                    let url = h.get("url")?.as_str()?;
                    let w = h.get("width")?.as_u64()? as u32;
                    let hh = h.get("height")?.as_u64()? as u32;
                    (w > 0 && hh > 0).then(|| (url.to_string(), [w, hh]))
                })
                .max_by_key(|(_, [w, h])| *w as u64 * *h as u64)
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 凭据错误必须是 ConfigInvalid 而不是「限流」：旧实现把 403 丢进 60 秒全局冷却，
    /// 一个填错的 API Key 会让整轮匹配每部作品都白等一分钟，界面还看不出是设置问题
    #[test]
    fn credential_errors_are_not_rate_limited() {
        assert_eq!(status_err("SteamGridDB", 401).code, ErrCode::ConfigInvalid);
        assert_eq!(status_err("SteamGridDB", 403).code, ErrCode::ConfigInvalid);
        // 404 不能报成「网络不可达」：上层会据此短路整轮匹配
        assert_eq!(status_err("SteamGridDB", 404).code, ErrCode::NotFound);
        assert_eq!(status_err("SteamGridDB", 502).code, ErrCode::ServerError);
    }

    #[test]
    fn search_keyword_is_percent_encoded() {
        assert_eq!(urlencode("千恋＊万花"), "%E5%8D%83%E6%81%8B%EF%BC%8A%E4%B8%87%E8%8A%B1");
        assert_eq!(urlencode("A B"), "A%20B");
    }
}

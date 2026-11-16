//! 四源并行候选（人工选择）：Bangumi / 萌娘百科 / EGS / 鲲 Galgame。

use crate::models::{AppError, ErrCode, Settings};
use crate::store::Store;
use crate::{egs, kungal, moegirl, net, thumb};
use tauri::State;

use super::matching::keywords;

/// 四源统一候选：前端只认这一套字段，绑定按 `source` + `key` 回落盘。
/// `subject` / `article` / `kungal` 只在后端用于写入，不发给前端。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaCandidate {
    /// bangumi / moegirl / egs / kungal
    pub source: String,
    /// Bangumi 条目 id / 鲲 Galgame 作品 id；萌娘百科与 EGS 用页面标题
    pub key: String,
    pub title: String,
    pub original: Option<String>,
    pub year: Option<u32>,
    pub score: u32,
    pub summary: Option<String>,
    pub thumb: Option<String>,
    pub egs: Option<egs::EgsStat>,
    #[serde(skip)]
    pub subject: Option<net::Subject>,
    #[serde(skip)]
    pub article: Option<moegirl::Article>,
    #[serde(skip)]
    pub kungal: Option<kungal::Work>,
}

/// 四源并行候选：Bangumi / 萌娘百科 / EGS / 鲲 Galgame 同时跑，各自限流闸独立。
/// 某源不可达只丢该源结果；全部为空时把第一个错误带回，避免把网络故障伪装成「没找到」。
#[tauri::command]
pub async fn match_candidates_all(
    store: State<'_, Store>,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<MetaCandidate>, AppError> {
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match_candidates_all_sync(&st, &id, limit))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

pub fn match_candidates_all_sync(
    store: &Store,
    id: &str,
    limit: Option<usize>,
) -> Result<Vec<MetaCandidate>, AppError> {
    let s = store.load_settings();
    let games = store.load_library();
    let g = games
        .iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中"))?;
    let company = g.pe_company.clone().or_else(|| g.developer.clone());
    let per_source = limit.unwrap_or(4).clamp(2, 8);
    let mut kws = keywords(g);
    if kws.is_empty() {
        kws.push(g.title.clone());
    }
    kws.truncate(3);

    // 用户主动打开候选：四源都重新探测一次，避免上一轮的离线短路让入口失效
    net::reset_bangumi_offline();
    moegirl::reset_offline();
    egs::reset_offline();
    kungal::reset_offline();

    // 鲲 Galgame 每个候选都要再取一次详情才有简介，请求数按 3 条封顶
    let kun_limit = per_source.min(3);
    let (bgm_join, moe_join, kun_join, egs_join) = std::thread::scope(|scope| {
        let b = scope.spawn(|| bangumi_candidates(&s, &kws, company.as_deref(), per_source));
        let m = scope.spawn(|| moegirl_candidates(&s, &kws, per_source));
        let k = scope.spawn(|| kungal_candidates(&s, &kws, kun_limit));
        let e = scope.spawn(|| egs::lookup(&s, &kws[0]));
        (b.join(), m.join(), k.join(), e.join())
    });
    let bgm = bgm_join.map_err(|_| AppError::new(ErrCode::IoError, "Bangumi 候选线程异常"))?;
    let moe = moe_join.map_err(|_| AppError::new(ErrCode::IoError, "萌娘百科候选线程异常"))?;
    let kun = kun_join.map_err(|_| AppError::new(ErrCode::IoError, "鲲 Galgame 候选线程异常"))?;
    let egs_hit = egs_join
        .map_err(|_| AppError::new(ErrCode::IoError, "批评空间候选线程异常"))?
        .unwrap_or(None);

    let mut out = aggregate_candidates(bgm, moe, kun, egs_hit, &kws[0])?;
    fill_meta_thumbs(store, &s, &mut out);
    out.sort_by_key(|c| std::cmp::Reverse(c.score));
    Ok(out)
}

/// 合并四源结果：单源失败只丢该源；全空时把第一个错误带回，避免把网络故障伪装成「没找到」。
/// 封面与排序依赖 Store，留在调用方；这里只做可单测的聚合决策。
fn aggregate_candidates(
    bgm: Result<Vec<MetaCandidate>, AppError>,
    moe: Result<Vec<MetaCandidate>, AppError>,
    kun: Result<Vec<MetaCandidate>, AppError>,
    egs_hit: Option<egs::EgsStat>,
    egs_title: &str,
) -> Result<Vec<MetaCandidate>, AppError> {
    let mut out: Vec<MetaCandidate> = Vec::new();
    let mut first_err: Option<AppError> = None;
    match bgm {
        Ok(mut v) => out.append(&mut v),
        Err(e) => {
            tracing::warn!("候选 Bangumi 不可用：{}", e.message);
            first_err = Some(e);
        }
    }
    match moe {
        Ok(mut v) => out.append(&mut v),
        Err(e) => {
            tracing::warn!("候选萌娘百科不可用：{}", e.message);
            first_err.get_or_insert(e);
        }
    }
    match kun {
        Ok(mut v) => out.append(&mut v),
        Err(e) => {
            tracing::warn!("候选鲲 Galgame 不可用：{}", e.message);
            first_err.get_or_insert(e);
        }
    }
    if let Some(st) = egs_hit {
        out.push(MetaCandidate {
            source: "egs".to_string(),
            key: egs_title.to_string(),
            title: egs_title.to_string(),
            original: None,
            year: None,
            score: 60,
            summary: None,
            thumb: None,
            egs: Some(st),
            subject: None,
            article: None,
            kungal: None,
        });
    }
    if out.is_empty() {
        return match first_err {
            Some(e) => Err(e),
            None => Ok(out),
        };
    }
    Ok(out)
}

fn bangumi_candidates(
    s: &Settings,
    kws: &[String],
    company: Option<&str>,
    limit: usize,
) -> Result<Vec<MetaCandidate>, AppError> {
    let mut out: Vec<MetaCandidate> = Vec::new();
    for kw in kws {
        let list = net::search(s, kw)?;
        for (rank, sub) in list.iter().enumerate() {
            let key = sub.id.to_string();
            if out.iter().any(|c| c.key == key) {
                continue;
            }
            out.push(MetaCandidate {
                source: "bangumi".to_string(),
                key,
                title: sub
                    .name_cn
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| sub.name.clone()),
                original: Some(sub.name.clone()),
                year: sub.year,
                score: net::score(kw, sub, rank, company),
                summary: sub.summary.clone(),
                thumb: None,
                egs: None,
                subject: Some(sub.clone()),
                article: None,
                kungal: None,
            });
        }
        if out.len() >= limit {
            break;
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.score));
    out.truncate(limit);
    Ok(out)
}

fn moegirl_candidates(
    s: &Settings,
    kws: &[String],
    limit: usize,
) -> Result<Vec<MetaCandidate>, AppError> {
    if !s.network.moegirl_fallback {
        return Ok(Vec::new());
    }
    let mut best: Vec<moegirl::Article> = Vec::new();
    for kw in kws {
        if let Some(a) = moegirl::lookup(s, kw)? {
            match best.iter().position(|b| b.title == a.title) {
                Some(i) if a.score > best[i].score => best[i] = a,
                Some(_) => {}
                None => best.push(a),
            }
        }
    }
    best.sort_by_key(|a| std::cmp::Reverse(a.score));
    best.truncate(limit);
    Ok(best
        .into_iter()
        .map(|a| MetaCandidate {
            source: "moegirl".to_string(),
            key: a.title.clone(),
            title: a.title.clone(),
            original: None,
            year: a.year,
            score: a.score,
            summary: a.summary.clone(),
            thumb: None,
            egs: None,
            subject: None,
            article: Some(a),
            kungal: None,
        })
        .collect())
}

/// 鲲 Galgame 候选：先搜索，再对前 N 条取详情补简介 / 时长。
/// 详情失败时退回搜索结果（没有简介），至少还能让用户选择绑定。
fn kungal_candidates(
    s: &Settings,
    kws: &[String],
    limit: usize,
) -> Result<Vec<MetaCandidate>, AppError> {
    let mut hits: Vec<kungal::Work> = Vec::new();
    let mut first_err: Option<AppError> = None;
    for kw in kws {
        match kungal::search(s, kw, limit.max(2)) {
            Ok(list) => {
                for w in list {
                    if hits.iter().any(|x| x.id == w.id) {
                        continue;
                    }
                    hits.push(w);
                    if hits.len() >= limit {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::warn!("鲲 Galgame 搜索失败（{kw}）：{}", e.message);
                first_err.get_or_insert(e);
            }
        }
        if hits.len() >= limit {
            break;
        }
    }
    if hits.is_empty() {
        return match first_err {
            Some(e) => Err(e),
            None => Ok(Vec::new()),
        };
    }
    let mut out = Vec::new();
    for hit in hits.into_iter().take(limit) {
        // 搜索结果不含简介，补一次详情；失败就退回搜索数据
        let work = match kungal::lookup(s, &hit.id) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("鲲 Galgame 详情跳过《{}》：{}", hit.id, e.message);
                hit
            }
        };
        // 多个关键词（中文 / 原名 / 罗马字）取最高相似度，避免用日文原名搜到时反而排后面
        let score = kws
            .iter()
            .map(|k| kungal::title_score(k, &work))
            .max()
            .unwrap_or(60);
        out.push(MetaCandidate {
            source: "kungal".to_string(),
            key: work.id.clone(),
            title: work.title.clone(),
            original: work.original.clone(),
            year: work.year,
            score,
            summary: work.summary.clone(),
            thumb: None,
            egs: None,
            subject: None,
            article: None,
            kungal: Some(work),
        });
    }
    Ok(out)
}

/// Bangumi 候选封面：复用现有候选缓存与并发下载，再按条目 id 写回统一候选。
fn fill_meta_thumbs(store: &Store, s: &Settings, out: &mut [MetaCandidate]) {
    // 萌娘百科候选：页面主图按标题哈希缓存，与 Bangumi 候选共用 `cand-` 淘汰策略
    let moe: Vec<(usize, String, String)> = out
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let a = c.article.as_ref()?;
            Some((i, a.title.clone(), a.cover.clone()?))
        })
        .collect();
    let mut got: Vec<(usize, String)> = Vec::new();
    for chunk in moe.chunks(4) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(i, title, url)| {
                    let (i, title, url) = (*i, title.clone(), url.clone());
                    scope.spawn(move || -> Option<(usize, String)> {
                        match net::fetch_image_direct(s, &url, "候选封面") {
                            Ok((bytes, _)) => thumb::candidate_thumb_keyed(store, &title, &bytes)
                                .map(|p| (i, p.to_string_lossy().to_string())),
                            Err(e) => {
                                tracing::debug!("萌娘候选封面跳过《{title}》：{}", e.message);
                                None
                            }
                        }
                    })
                })
                .collect();
            for h in handles {
                if let Ok(Some(r)) = h.join() {
                    got.push(r);
                }
            }
        });
    }
    for (i, p) in got {
        out[i].thumb = Some(p);
    }

    // 鲲 Galgame 候选：作品 id 直接做缓存名，封面走图片 CDN，不占 API 阀门
    let kun: Vec<(usize, String, String)> = out
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let w = c.kungal.as_ref()?;
            Some((i, w.id.clone(), w.cover.clone()?))
        })
        .collect();
    let mut got: Vec<(usize, String)> = Vec::new();
    for chunk in kun.chunks(4) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(i, id, url)| {
                    let (i, id, url) = (*i, id.clone(), url.clone());
                    scope.spawn(move || -> Option<(usize, String)> {
                        match net::fetch_image_direct(s, &url, "鲲 Galgame 候选封面") {
                            Ok((bytes, _)) => thumb::candidate_thumb_kungal(store, &id, &bytes)
                                .map(|p| (i, p.to_string_lossy().to_string())),
                            Err(e) => {
                                tracing::debug!("鲲 Galgame 候选封面跳过《{id}》：{}", e.message);
                                None
                            }
                        }
                    })
                })
                .collect();
            for h in handles {
                if let Ok(Some(r)) = h.join() {
                    got.push(r);
                }
            }
        });
    }
    for (i, p) in got {
        out[i].thumb = Some(p);
    }

    let mut subs: Vec<net::Candidate> = out
        .iter()
        .filter_map(|c| {
            c.subject.as_ref().map(|sub| net::Candidate {
                subject: sub.clone(),
                score: c.score,
                thumb: None,
            })
        })
        .collect();
    if subs.is_empty() {
        return;
    }
    fill_candidate_thumbs(store, s, &mut subs);
    for c in out.iter_mut() {
        let Some(sub) = c.subject.as_ref() else {
            continue;
        };
        if let Some(t) = subs
            .iter()
            .find(|x| x.subject.id == sub.id)
            .and_then(|x| x.thumb.clone())
        {
            c.thumb = Some(t);
        }
    }
}

/// 候选封面补齐：命中缓存直接给路径；没缓存的**最多 4 张并发**下载。
///
/// 图片在 CDN 上，和 API 不是同一套限流：若沿用 `fetch_image` 的 1 req/s 闸门，
/// 5 条候选要多等约 5 秒；这里走 `fetch_image_direct` + 分片并发，最坏两批即可取完。
fn fill_candidate_thumbs(store: &Store, settings: &Settings, out: &mut [net::Candidate]) {
    const CONCURRENCY: usize = 4;
    for chunk in out.chunks_mut(CONCURRENCY) {
        std::thread::scope(|scope| {
            for c in chunk.iter_mut() {
                scope.spawn(move || {
                    let cached = store.thumbs_dir().join(format!("cand-{}.webp", c.subject.id));
                    if cached.exists() {
                        c.thumb = Some(cached.to_string_lossy().to_string());
                        return;
                    }
                    let Some(url) = c.subject.images_large.as_deref() else { return };
                    match net::fetch_image_direct(settings, url, "候选封面") {
                        Ok((bytes, _)) => {
                            if let Some(p) = thumb::candidate_thumb(store, c.subject.id, &bytes) {
                                c.thumb = Some(p.to_string_lossy().to_string());
                            }
                        }
                        Err(e) => tracing::debug!("候选封面跳过《{}》：{}", c.subject.name, e.message),
                    }
                });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(source: &str, key: &str, score: u32) -> MetaCandidate {
        MetaCandidate {
            source: source.to_string(),
            key: key.to_string(),
            title: key.to_string(),
            original: None,
            year: None,
            score,
            summary: None,
            thumb: None,
            egs: None,
            subject: None,
            article: None,
            kungal: None,
        }
    }

    fn offline(msg: &str) -> AppError {
        AppError::new(ErrCode::NetworkOffline, msg)
    }

    #[test]
    fn aggregate_keeps_other_sources_when_one_fails() {
        let out = aggregate_candidates(
            Err(offline("Bangumi 不可达")),
            Ok(vec![cand("moegirl", "装甲恶鬼村正", 88)]),
            Ok(vec![]),
            Some(egs::EgsStat {
                score: Some(78.0),
                votes: Some(120),
                minutes: Some(1500),
            }),
            "装甲恶鬼村正",
        )
        .expect("单源失败不应拖垮其余来源");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].source, "moegirl");
        assert_eq!(out[1].source, "egs");
        assert_eq!(out[1].egs.as_ref().and_then(|s| s.votes), Some(120));
    }

    #[test]
    fn aggregate_only_egs_still_returns_candidate() {
        let out = aggregate_candidates(
            Ok(vec![]),
            Ok(vec![]),
            Ok(vec![]),
            Some(egs::EgsStat::default()),
            "Kanon",
        )
        .expect("有 EGS 命中就算有结果");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, "egs");
        // key 用检索关键词，前端点选时原样回传给 apply_candidate
        assert_eq!(out[0].key, "Kanon");
        assert_eq!(out[0].title, "Kanon");
        assert_eq!(out[0].score, 60);
    }

    #[test]
    fn aggregate_keeps_kungal_when_others_fail() {
        let out = aggregate_candidates(
            Err(offline("Bangumi 不可达")),
            Err(offline("萌娘不可达")),
            Ok(vec![cand("kungal", "4145", 100)]),
            None,
            "甜蜜女友3",
        )
        .expect("鲲 Galgame 单独可用时也要出候选");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, "kungal");
        assert_eq!(out[0].key, "4145");
    }

    #[test]
    fn aggregate_empty_without_errors_is_ok() {
        let out = aggregate_candidates(Ok(vec![]), Ok(vec![]), Ok(vec![]), None, "Kanon")
            .expect("四源都能连上但没结果 = 空列表，不是错误");
        assert!(out.is_empty());
    }

    #[test]
    fn aggregate_returns_first_error_when_everything_empty() {
        let err = aggregate_candidates(
            Err(offline("Bangumi 不可达")),
            Err(offline("萌娘不可达")),
            Err(offline("鲲 Galgame 不可达")),
            None,
            "Kanon",
        )
        .expect_err("全空且全部失败时必须报错");
        // 保留第一个错误，前端提示才不会把网络故障说成「没找到」
        assert_eq!(err.message, "Bangumi 不可达");
    }

    #[test]
    fn meta_candidate_serializes_front_end_contract() {
        let mut c = cand("egs", "装甲悪鬼村正", 60);
        c.egs = Some(egs::EgsStat {
            score: Some(78.0),
            votes: Some(120),
            minutes: Some(1500),
        });
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["source"], "egs");
        assert_eq!(v["key"], "装甲悪鬼村正");
        assert_eq!(v["egs"]["score"], 78.0);
        assert_eq!(v["egs"]["votes"], 120);
        assert_eq!(v["egs"]["minutes"], 1500);
        // 后端内部数据不下发：前端只拿展示字段
        assert!(v.get("subject").is_none());
        assert!(v.get("article").is_none());
    }
}

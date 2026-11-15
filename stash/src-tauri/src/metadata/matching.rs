//! 匹配主流程：关键字、打分、单部 / 全量匹配与结果回写。

use crate::models::{AppError, ErrCode, Game};
use crate::store::{self, Store};
use crate::{egs, moegirl, net};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};

use super::apply::{apply_moegirl, apply_subject, clear_match};
use super::bind::{cover_or_sgdb, egs_for, fetch_cover, reuse_cover};

/// 关键字的候选名（总案 7.1 数据流）：目录名清洗 + PE ProductName。
/// 标题本身若被 meta.json 覆盖过，同时也作为候选（原名命中率更高）。
/// 每个候选再补一个「去装饰 + 砍副标题」的变体——真实库名常带「＊」「～…～」，
/// Bangumi 对这类写法召回很差（实测「千恋＊万花」搜不到正主）。
pub fn keywords(g: &Game) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |out: &mut Vec<String>, s: String| {
        let s = s.trim().to_string();
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    };
    push(&mut out, g.title_original.clone().unwrap_or_default());
    push(&mut out, g.title.clone());
    push(&mut out, g.pe_product.clone().unwrap_or_default());
    // 去装饰 / 砍副标题的变体（「千恋＊万花」→「千恋万花」）
    let extra: Vec<String> = out.iter().filter_map(|s| net::simplify_query(s)).collect();
    for v in extra {
        push(&mut out, v);
    }
    // 剥掉版本号 / 平台后缀的变体（`DDLC-1.1.1-pc` → `DDLC`）：
    // 这类目录名直接搜召回很差，去掉尾巴反而更容易命中正主
    let cleaned: Vec<String> = out.iter().filter_map(|s| net::clean_name(s)).collect();
    for v in cleaned {
        push(&mut out, v);
    }
    out
}

/// 是否该清掉旧绑定：已有绑定且它是机器写的（<80）。人工绑定记 100，永远不动。
pub fn stale_auto_match(has_binding: bool, score: Option<u32>) -> bool {
    has_binding && score.map(|s| s < 80).unwrap_or(true)
}

/// 匹配成品：网络侧算好（含已下载封面），回写时不再碰网络。
/// Bangumi 找不到或不够准时由萌娘百科兜底。两者互斥，只会有一个 Some。
pub struct MatchHit {
    subject: Option<net::Subject>,
    /// 萌娘百科兜底（简介 / 原名 / 开发商 / 年份 / 类型）
    moegirl: Option<moegirl::Article>,
    score: u32,
    pending: bool,
    cover: Option<String>,
    thumb: Option<String>,
    /// 简介择优结果：Bangumi 简介偏英文 / 日文时改用萌娘百科的中文简介。
    /// 只覆盖简介，标题与条目绑定仍以 Bangumi 为准。
    summary: Option<String>,
    /// EGS（批评空间）补充：中央值 / 时长；不可达时为 None
    egs: Option<egs::EgsStat>,
}

/// 全量匹配的取消开关（H3）：每部之间检查一次，不会打断正在进行的那一次请求。
pub static MATCH_CANCEL: AtomicBool = AtomicBool::new(false);
/// 同一时间只允许一轮全量匹配；线程结束（含 panic）自动复位
pub static MATCH_RUNNING: AtomicBool = AtomicBool::new(false);

pub struct MatchRunGuard;

impl Drop for MatchRunGuard {
    fn drop(&mut self) {
        MATCH_RUNNING.store(false, Ordering::Relaxed);
    }
}

/// 取消当前全量匹配（已完成的条目保留）
#[tauri::command]
pub fn cancel_match() {
    MATCH_CANCEL.store(true, Ordering::Relaxed);
}

/// 全量匹配是否仍在进行：前端在 done 事件丢失时用它兜底解卡。
#[tauri::command]
pub fn match_running() -> bool {
    MATCH_RUNNING.load(Ordering::Relaxed)
}

/// 全量匹配：后台串行跑（1req/s，30–80 部约 1–3 分钟），进度与结果走事件。
///
/// 并发约定：**每部先在锁外做网络与封面，再在锁内 load → 改 → save**。
/// 旧实现是「开头 load 一次、结尾 save 一次」，跑了几分钟会把这段时间里用户
/// 点的收藏 / 改的 END 全部覆盖掉。
#[tauri::command]
pub async fn match_all(app: AppHandle, store: State<'_, Store>, force: Option<bool>) -> Result<(), AppError> {
    let s = store.load_settings();
    if !s.network.metadata_enabled {
        // 「开关没开」是配置问题，不是断网：前端提示要指向设置页
        return Err(AppError::new(ErrCode::ConfigInvalid, "在线元数据未开启（设置 · 网络）"));
    }
    let store = store.inner().clone();
    let force = force.unwrap_or(false);
    if MATCH_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_err()
    {
        return Err(AppError::new(ErrCode::AlreadyRunning, "已有全量匹配在进行中"));
    }
    MATCH_CANCEL.store(false, Ordering::Relaxed);
    // 预检：Bangumi 与萌娘百科都不可达时立刻失败，避免每部作品各等一次超时。
    // 探测本身会复位三个源的 offline 标记（等同于用户明确要求重新探测）。
    let probe = match tauri::async_runtime::spawn_blocking(move || super::probe_sources_sync(&s, false)).await
    {
        Ok(p) => p,
        Err(e) => {
            // 预检线程 panic 也必须放开并发锁，否则此后每次都只会报「已有全量匹配在进行中」
            MATCH_RUNNING.store(false, Ordering::Relaxed);
            return Err(AppError::new(ErrCode::IoError, e.to_string()));
        }
    };
    if !probe.usable {
        MATCH_RUNNING.store(false, Ordering::Relaxed);
        return Err(AppError::new(
            ErrCode::NetworkOffline,
            probe.message.unwrap_or_else(|| "元数据源均不可达".to_string()),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _run = MatchRunGuard;
        let ids: Vec<String> = store.load_library().iter().map(|g| g.id.clone()).collect();
        let total = ids.len();
        let mut done = 0usize;

        for id in ids {
            if MATCH_CANCEL.load(Ordering::Relaxed) {
                let _ = app.emit(
                    "match://done",
                    serde_json::json!({ "total": total, "done": done, "cancelled": true }),
                );
                tracing::info!("match cancelled at {done}/{total}");
                return;
            }
            // ① 取快照判断要不要跑（不持锁）
            let Some(snap) = store.load_library().into_iter().find(|g| g.id == id) else {
                continue;
            };
            // 已确认的绑定不重复匹配：Bangumi 有正式条目 id；萌娘百科命中只写 match_score
            // （不写条目 id），漏掉它会让每次「开始匹配」都把这批作品重搜一遍、
            // 重下一遍封面——1req/s 下整轮白等；待确认（pending）的仍要重试
            if !needs_match(&snap, force) {
                done += 1;
                continue;
            }

            // ② 锁外：搜索 / 打分 / 补标签 / 下封面（可能耗时数秒）
            match resolve_hit(&store, &snap) {
                Ok(hit) => {
                    // ③ 锁内：回写「此刻最新」的记录，不覆盖这期间的其它改动
                    let tier = write_hit_locked(&store, &id, hit.as_ref(), force);
                    let _ = app.emit(
                        "match://progress",
                        serde_json::json!({ "done": done + 1, "total": total, "id": id, "tier": tier }),
                    );
                }
                Err(e) => {
                    tracing::warn!("match failed {id}: {}", e.message);
                    // 网络类错误不中断整批：单部失败继续下一部；限流也要让用户看见
                    if matches!(e.code, ErrCode::NetworkOffline | ErrCode::RateLimited) {
                        let _ = app.emit("match://error", &e);
                    }
                }
            }
            done += 1;
        }
        let _ = app.emit("match://done", serde_json::json!({ "total": total, "done": done }));
    });
    Ok(())
}

/// 这条记录是否需要跑一次联网匹配。`force` = 用户主动点「重新匹配」。
///
/// 正式绑定（Bangumi 条目 id）与「已确认的萌娘百科命中」都不再重搜；
/// 萌娘百科命中只写 `match_score`、不写条目 id，只判 id 会让它每轮都被重搜 + 重下封面。
/// 「待确认」（pending）的仍要重试，用户还没确认过。
pub fn needs_match(g: &Game, force: bool) -> bool {
    if force {
        return true;
    }
    !(g.bangumi_id.is_some() || (g.match_score.is_some() && !g.pending))
}

/// 单部重新匹配（前端不阻塞，取回后自行刷新）。
/// `async`：内部要走网络搜索 + 下封面（数秒级），不能占主线程。
#[tauri::command]
pub async fn match_one(store: State<'_, Store>, id: String) -> Result<String, AppError> {
    let snap = store
        .load_library()
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中（可能已移除）"))?;
    let st = store.inner().clone();
    // 搜索 + 下封面都是阻塞网络调用（还有 1req/s 节流等待），不能占 tokio worker
    tauri::async_runtime::spawn_blocking(move || {
        // 用户主动点「重新匹配」：给 Bangumi / 萌娘百科一次重新探测的机会（上一轮可能只是一次超时）
        net::reset_bangumi_offline();
        moegirl::reset_offline();
        let hit = resolve_hit(&st, &snap)?;
        // 单部「重新匹配」是用户明确要求：允许覆盖手改元数据
        Ok::<String, AppError>(write_hit_locked(&st, &id, hit.as_ref(), true).to_string())
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/// 锁内回写一份匹配结果，返回档位字符串。`None` = 低于阈值（可能顺带清掉机器写的旧绑定）。
/// `force` = 用户主动发起的重新匹配：允许覆盖手改过的元数据（清掉 meta_manual）。
pub fn write_hit_locked(store: &Store, id: &str, hit: Option<&MatchHit>, force: bool) -> &'static str {
    let _lock = store::lock_library();
    let mut games = store.load_library();
    let Some(g) = games.iter_mut().find(|g| g.id == id) else {
        return "none"; // 匹配期间被移出库（目录被删）：放弃这次结果
    };
    let tier = match hit {
        Some(h) => {
            if force {
                g.meta_manual = false;
            }
            if let Some(sub) = &h.subject {
                apply_subject(g, sub, h.score, h.pending);
                // 简介择优（萌娘百科的中文简介）覆盖 Bangumi 原文；
                // 与 apply_subject 一致：手改过的简介不覆盖
                if let Some(txt) = &h.summary {
                    if !g.meta_manual {
                        g.summary = Some(txt.clone());
                    }
                }
            } else if let Some(a) = &h.moegirl {
                apply_moegirl(g, a, h.score, h.pending);
            }
            // EGS 的口碑分 / 时长优先级最高：它有最贴合 Galgame 的中央值
            if let Some(e) = &h.egs {
                if let Some(sc) = e.score {
                    g.meta_score = Some(sc);
                    g.meta_score_source = Some("egs".to_string());
                }
                if let Some(v) = e.votes {
                    g.meta_score_count = Some(v);
                }
                if let Some(m) = e.minutes {
                    g.length_minutes = Some(m);
                }
            }
            if let Some(p) = &h.cover {
                g.cover = Some(p.clone());
                g.thumb = h.thumb.clone();
            }
            if h.pending {
                "pending"
            } else {
                "auto"
            }
        }
        None => {
            // 低于阈值：机器自动写的旧结论（<80）清掉，避免「界面显示已匹配、条目其实是错的」；
            // 人工绑定（bind_subject 记 100 分）不动——那是用户明确确认过的。
            if stale_auto_match(g.bangumi_id.is_some() || g.meta_source.is_some(), g.match_score) {
                tracing::info!("match {id}: 低于阈值，清除自动匹配（标题保留）");
                clear_match(g);
            }
            "none"
        }
    };
    // 写盘失败不能静默：否则界面收到 tier=auto、重启后匹配结果全没了
    if let Err(e) = store.save_library(&games) {
        tracing::error!("match {id}: 匹配结果写盘失败：{e}");
    }
    tier
}

/// Bangumi 只回一条结果、但字面相似度低于「待确认」门槛时，给 50 分。
/// 目录名常是「缩写 + 版本号 / 平台后缀」（`DDLC-1.1.1-pc`），编辑距离算不出关系，
/// 但此时唯一命中通常就是正主——降级成「待确认」让用户在界面上一次确认，
/// 比直接判「未匹配」有用得多。
pub fn singleton_hint(list_len: usize, score: u32) -> Option<u32> {
    (list_len == 1 && score < 50).then_some(50)
}

/// 简介语言特征：汉字 / 假名 / 拉丁字母的字符数
fn lang_stats(s: &str) -> (usize, usize, usize) {
    let mut han = 0;
    let mut kana = 0;
    let mut latin = 0;
    for c in s.chars() {
        match c as u32 {
            0x4E00..=0x9FA5 => han += 1,
            0x3040..=0x30FF => kana += 1,
            _ if c.is_ascii_alphabetic() => latin += 1,
            _ => {}
        }
    }
    (han, kana, latin)
}

/// Bangumi 简介「不够中文」：过短，或以日文 / 英文为主。
/// 只有这种情况才值得再花一次请求去萌娘百科找中文简介。
fn summary_poor(s: &str) -> bool {
    let t = s.trim();
    if t.chars().count() < 60 {
        return true;
    }
    let (han, kana, latin) = lang_stats(t);
    kana > han / 2 || latin > han
}

/// 简介择优：两边都有时，只有萌娘明显更中文（且不少于 80 字）才替换。
/// Bangumi 本来就是通顺中文时不换，避免丢掉编辑整理过的行文。
fn pick_summary(bg: Option<&str>, moe: Option<&str>) -> Option<String> {
    let clean = |x: &str| x.trim().to_string();
    let bg = bg.map(clean).filter(|x| !x.is_empty());
    let moe = moe.map(clean).filter(|x| !x.is_empty());
    match (bg, moe) {
        (None, None) => None,
        (Some(b), None) => Some(b),
        (None, Some(m)) => Some(m),
        (Some(b), Some(m)) => {
            let (bh, bk, bl) = lang_stats(&b);
            let (mh, mk, ml) = lang_stats(&m);
            // 假名占比比「汉字占比」更能区分中日文：日文简介里汉字同样很多
            let bq = bk as f32 / (bh + bk + bl + 1) as f32;
            let mq = mk as f32 / (mh + mk + ml + 1) as f32;
            let bg_bad = bk > bh / 2 || bl > bh; // Bangumi 偏日文或英文
            let moe_cn = m.chars().count() >= 80 && mh >= 30 && mq < 0.3;
            if moe_cn && (bg_bad || mq + 0.05 < bq) {
                Some(m)
            } else {
                Some(b)
            }
        }
    }
}

/// 只做「搜索 → 打分 → 补标签 → 下封面」：不持有库锁，可能耗时数秒。
pub fn resolve_hit(store: &Store, g: &Game) -> Result<Option<MatchHit>, AppError> {
    let s = store.load_settings();
    // 会社线索：PE CompanyName 优先，退回 meta.json 的 developer（演示库/手工整理都有）
    let company = g.pe_company.clone().or_else(|| g.developer.clone());
    let mut best: Option<(u32, net::Subject)> = None;
    // 「只回一条结果」的候选：目录名常是缩写 + 版本号（DDLC-1.1.1-pc），
    // 字面相似度算不出来，但唯一命中通常就是正主，留作待确认线索
    let mut hint: Option<(u32, net::Subject)> = None;
    // Bangumi 在部分网络（如国内直连）会整体超时：不能因为主源不可达就放弃萌娘百科兜底
    let mut bgm_err: Option<AppError> = None;

    for kw in keywords(g).iter().take(4) {
        let list = match net::search(&s, kw) {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("bangumi search failed ({kw}): {}", e.message);
                bgm_err = Some(e);
                break;
            }
        };
        for (rank, sub) in list.iter().enumerate() {
            let sc = net::score(kw, sub, rank, company.as_deref());
            if let Some(hs) = singleton_hint(list.len(), sc) {
                if hint.as_ref().map(|(b, _)| hs > *b).unwrap_or(true) {
                    hint = Some((hs, sub.clone()));
                }
            }
            if best.as_ref().map(|(b, _)| sc > *b).unwrap_or(true) {
                best = Some((sc, sub.clone()));
            }
        }
        if best.as_ref().map(|(b, _)| *b >= 80).unwrap_or(false) {
            break; // 已经够准，不再浪费请求
        }
    }

    // 字面分连「待确认」都不到时，把唯一搜索结果抬到 50 分：
    // 用户至少能在列表里看到它并一键确认，而不是完全无提示地判为「未匹配」
    if best.as_ref().map(|(b, _)| *b < 50).unwrap_or(false) {
        if let Some(h) = hint {
            if best.as_ref().map(|(b, _)| h.0 > *b).unwrap_or(true) {
                tracing::info!("match: 唯一搜索结果抬为待确认（{}）", h.1.name);
                best = Some(h);
            }
        }
    }

    // 萌娘百科既做兜底（Bangumi <80 或不可达），也做简介择优（Bangumi 简介偏英文 / 日文）。
    // 两种情况共用同一次查询，避免重复请求。
    let need_fallback = best.as_ref().map(|(b, _)| *b < 80).unwrap_or(true);
    let need_summary = best
        .as_ref()
        .map(|(_, sub)| summary_poor(sub.summary.as_deref().unwrap_or("")))
        .unwrap_or(false);
    tracing::info!(
        "match 简介检查: best={:?} fallback={} summary_poor={}",
        best.as_ref().map(|(b, _)| *b),
        need_fallback,
        need_summary
    );
    let mut mbest: Option<moegirl::Article> = None;
    if s.network.metadata_enabled && s.network.moegirl_fallback && (need_fallback || need_summary) {
        // 中文站按「原名 + 中文名 + 去副标题变体」依次试：带副标题的标题在萌娘
        // 常常搜不到（「樱之诗 −于樱之森上飞舞−」），落到 simplify 变体才命中
        for kw in keywords(g).iter().take(4) {
            match moegirl::lookup(&s, kw) {
                Ok(Some(a)) => {
                    if a.score >= 75 && mbest.as_ref().map(|b| a.score > b.score).unwrap_or(true) {
                        mbest = Some(a);
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!("moegirl fallback failed ({kw}): {}", e.message);
                    break;
                }
            }
            if mbest.as_ref().map(|b| b.score >= 90).unwrap_or(false) {
                break;
            }
        }
    }

    tracing::info!(
        "match 萌娘命中: {:?}",
        mbest
            .as_ref()
            .map(|a| (a.score, a.summary.as_ref().map(|x| x.chars().count())))
    );

    // 兜底：分数必须真的高于 Bangumi 现有候选才接手，
    // 避免把 79 分的待确认结果顶成另一个条目
    let better = mbest
        .as_ref()
        .map(|a| best.as_ref().map(|(b, _)| a.score > *b).unwrap_or(true))
        .unwrap_or(false);
    if need_fallback && better {
        if let Some(a) = mbest.take() {
            let score = a.score;
            let title = a.title.clone();
            // 页面主图是竖版才收；没有就沿用本地封面，再没有才让 SteamGridDB 补
            let pair = match a.cover.as_deref() {
                Some(url) => fetch_cover(store, &g.id, Some(url)),
                None => reuse_cover(store, g).unwrap_or((None, None)),
            };
            let (cover, thumb) = cover_or_sgdb(&s, store, g, pair);
            let egs = egs_for(&s, g, &title);
            return Ok(Some(MatchHit {
                subject: None,
                moegirl: Some(a),
                score,
                pending: score < 80,
                cover,
                thumb,
                summary: None,
                egs,
            }));
        }
    }

    let Some((sc, sub)) = best else {
        // 主源没命中：如果 Bangumi 是「不可达」而不是「没结果」，把网络错误带回 UI，
        // 避免把网络故障伪装成「未找到」
        if let Some(e) = bgm_err {
            return Err(e);
        }
        return Ok(None);
    };
    let tier = net::tier(sc);
    if tier == net::MatchTier::None {
        return Ok(None);
    }
    // 旧版检索不带标签；标签既是分面筛选的数据源，也是会社打分的依据，选中后补一次详情
    let sub = if sub.tags.is_empty() {
        net::subject(&s, sub.id).unwrap_or(sub)
    } else {
        sub
    };
    // 简介择优：Bangumi 简介偏英文 / 日文时，改用刚才查到的萌娘百科中文简介。
    // 只覆盖简介，标题、条目绑定、评分仍以 Bangumi 为准。
    let summary = match mbest.as_ref() {
        Some(a) if need_summary => {
            let picked = pick_summary(sub.summary.as_deref(), a.summary.as_deref());
            // 只有真的选中萌娘那段才覆盖
            let hit = picked.as_deref() == a.summary.as_deref().map(str::trim);
            tracing::info!(
                "match 简介择优: bg={:?} moe={:?} 采用萌娘={}",
                sub.summary.as_ref().map(|x| x.chars().count()),
                a.summary.as_ref().map(|x| x.chars().count()),
                hit
            );
            if hit {
                picked
            } else {
                None
            }
        }
        _ => None,
    };
    let (cover, thumb) = if g.bangumi_id == Some(sub.id) {
        reuse_cover(store, g)
            .unwrap_or_else(|| fetch_cover(store, &g.id, sub.images_large.as_deref()))
    } else {
        fetch_cover(store, &g.id, sub.images_large.as_deref())
    };
    let (cover, thumb) = cover_or_sgdb(&s, store, g, (cover, thumb));
    let egs = egs_for(&s, g, &sub.name);
    Ok(Some(MatchHit {
        subject: Some(sub),
        moegirl: None,
        score: sc,
        pending: tier == net::MatchTier::Pending,
        cover,
        thumb,
        summary,
        egs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 中文简介（约 90 字）
    const CN: &str = "《白色相簿2》是由 Leaf 制作的一部恋爱冒险游戏。故事以冬日为舞台，讲述三名主人公之间的情感纠葛与选择，被视为系列作品中最具代表性的一作，后来还推出了动画等衍生作品。";
    /// 英文简介
    const EN: &str = "This is an English introduction of the game. It tells a story about three characters in winter and the choices they have to make in their daily lives, and it is regarded as the best entry of the series.";
    /// 以日文为主的简介
    const JP: &str = "これは日本語の紹介文です。ゲームの物語について詳しく説明しています。冬の季節を舞台に、三人の登場人物の感情と選択を描いた作品で、シリーズの中でも特に人気のある一作です。";

    #[test]
    fn summary_poor_detects_language() {
        assert!(summary_poor(""), "空简介需要补");
        assert!(summary_poor("Short intro."), "过短需要补");
        assert!(summary_poor(EN), "英文简介需要中文替换");
        assert!(summary_poor(JP), "日文简介需要中文替换");
        assert!(!summary_poor(CN), "中文简介不需要再查萌娘");
    }

    #[test]
    fn pick_summary_prefers_chinese_over_english() {
        assert_eq!(pick_summary(Some(EN), Some(CN)).as_deref(), Some(CN.trim()));
    }

    #[test]
    fn pick_summary_prefers_chinese_over_japanese() {
        // 日文简介里汉字比例不低，必须按假名占比判断
        assert_eq!(pick_summary(Some(JP), Some(CN)).as_deref(), Some(CN.trim()));
    }

    #[test]
    fn pick_summary_keeps_good_chinese() {
        // 两边都偏中文时保留 Bangumi，不因为萌娘更长就替换
        assert_eq!(pick_summary(Some(CN), Some(JP)).as_deref(), Some(CN.trim()));
        // 只有一边有值时直接用那一边
        assert_eq!(pick_summary(None, Some(CN)).as_deref(), Some(CN.trim()));
        assert_eq!(pick_summary(Some(EN), None).as_deref(), Some(EN.trim()));
        assert_eq!(pick_summary(Some("  "), None), None);
    }
}

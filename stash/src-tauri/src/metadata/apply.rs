//! 元数据字段回写：匹配结果 / 人工候选按字段写进 `Game`，以及「取消匹配」的本地回退。

use crate::models::Game;
use crate::{kungal, moegirl, net, scanner, tagzh};

/// 清掉匹配结果（标题保留，不还原目录名——与 unmatch_game 同一语义）
pub fn clear_match(g: &mut Game) {
    g.bangumi_id = None;
    g.kungal_id = None;
    g.match_score = None;
    g.pending = false;
    g.matched = false;
    g.meta_source = None;
}

/// 应用候选时要写入的字段集合。前端不传时按「全部」处理，兼容旧调用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplyFields {
    pub title: bool,
    pub original: bool,
    pub year: bool,
    pub summary: bool,
    pub cover: bool,
    pub score: bool,
    pub length: bool,
}

impl ApplyFields {
    pub fn all() -> Self {
        Self {
            title: true,
            original: true,
            year: true,
            summary: true,
            cover: true,
            score: true,
            length: true,
        }
    }

    /// 字段 id：title / original / year / summary / cover / score / length。
    /// 不传 = 全部；传空数组 = 全部不写（身份字段仍会更新，避免留下待确认）。
    pub fn from_list(list: Option<&[String]>) -> Self {
        let Some(list) = list else { return Self::all() };
        let has = |k: &str| list.iter().any(|x| x == k);
        Self {
            title: has("title"),
            original: has("original"),
            year: has("year"),
            summary: has("summary"),
            cover: has("cover"),
            score: has("score"),
            length: has("length"),
        }
    }
}

/// 把条目写回游戏记录：中文译名作 title（找不到就用原名），并带简介 / 标签 / 年份。
/// 封面由调用方另行赋值（下载在锁外完成）。
pub fn apply_subject(g: &mut Game, sub: &net::Subject, score: u32, pending: bool) {
    apply_subject_fields(g, sub, score, pending, ApplyFields::all());
}

/// `apply_subject` 的字段级版本：手动选择候选时只写用户勾选的字段。
/// 条目身份（bangumi_id / matched / meta_source / pending）始终更新，否则会留下「已选但仍在待确认」。
pub fn apply_subject_fields(
    g: &mut Game,
    sub: &net::Subject,
    score: u32,
    pending: bool,
    f: ApplyFields,
) {
    // 用户改过标题就不覆盖（H1），重匹配只补元数据
    if f.title && g.title_override.is_none() {
        if let Some(cn) = &sub.name_cn {
            g.title = cn.clone();
        } else {
            g.title = sub.name.clone();
        }
    }
    if f.original {
        g.title_original = Some(sub.name.clone());
    }
    g.bangumi_id = Some(sub.id);
    g.match_score = Some(score);
    g.pending = pending;
    g.matched = true;
    g.meta_source = Some("bangumi".to_string());
    // 参考评分不属于「手改元数据」的范围：Bangumi 的 0–10 分归一成 0–100
    if f.score {
        if let Some(sc) = sub.score {
            g.meta_score = Some((sc * 100.0).round() / 10.0);
            g.meta_score_source = Some("bangumi".to_string());
        }
    }
    // 用户手改过的简介 / 标签 / 年份不覆盖：只有主动「重新匹配」时才先清掉 meta_manual
    if !g.meta_manual {
        if f.summary {
            if let Some(s) = &sub.summary {
                g.summary = Some(s.clone());
            }
            if !sub.tags.is_empty() {
                // 标签统一成中文：Bangumi 多为中文标签，但日文 / 英文条目不少，
                // 详情页与卡片上混排很乱，写库时就翻译掉（本地字典，无网络）
                g.tags = tagzh::localize_all(&sub.tags);
            }
        }
        if f.year && sub.year.is_some() {
            g.year = sub.year;
        }
    }
}

/// 萌娘百科兜底回写：中文标题 / 简介 / 年份。
/// 没有正式条目 id（`bangumi_id` 保持空），评分与时长仍由 EGS 决定。
pub fn apply_moegirl(g: &mut Game, a: &moegirl::Article, score: u32, pending: bool) {
    apply_moegirl_fields(g, a, score, pending, ApplyFields::all());
}

pub fn apply_moegirl_fields(
    g: &mut Game,
    a: &moegirl::Article,
    score: u32,
    pending: bool,
    f: ApplyFields,
) {
    // 用户改过标题就不覆盖（与 apply_subject 一致）
    if f.title && g.title_override.is_none() {
        g.title = a.title.clone();
    }
    g.bangumi_id = None;
    g.match_score = Some(score);
    g.pending = pending;
    g.matched = true;
    g.meta_source = Some("moegirl".to_string());
    // 旧版 VNDB / IGDB 留下的参考评分（如 9.02 存成 902）既不是 EGS 也不是 Bangumi 体系，
    // 萌娘百科本身不提供评分；留着会在详情页显示成「Bangumi 902」，故切到萌娘百科时清掉。
    if !matches!(g.meta_score_source.as_deref(), Some("egs") | Some("bangumi")) {
        g.meta_score = None;
        g.meta_score_source = None;
    }
    // 手改过的简介 / 年份不覆盖：只有主动「重新匹配」时才先清掉 meta_manual
    if g.meta_manual {
        return;
    }
    if f.summary {
        if let Some(s) = &a.summary {
            g.summary = Some(s.clone());
        }
    }
    if f.year {
        if let Some(y) = a.year {
            g.year = Some(y);
        }
    }
}

/// 鲲 Galgame 回写：中文标题 / 原名 / 简介 / 年份 / 封面 / 评分 / 时长都可按字段选择。
/// 与萌娘百科一样不写 `bangumi_id`，用 `kungal_id` 记来源作品。
pub fn apply_kungal_fields(
    g: &mut Game,
    w: &kungal::Work,
    score: u32,
    pending: bool,
    f: ApplyFields,
) {
    if f.title && g.title_override.is_none() {
        g.title = w.title.clone();
    }
    if f.original {
        g.title_original = w.original.clone();
    }
    g.kungal_id = Some(w.id.clone());
    g.match_score = Some(score);
    g.pending = pending;
    g.matched = true;
    g.meta_source = Some("kungal".to_string());
    if f.score {
        if let Some(sc) = w.score {
            g.meta_score = Some(sc);
            g.meta_score_source = Some("kungal".to_string());
        }
        if let Some(v) = w.votes {
            g.meta_score_count = Some(v);
        }
    }
    if f.length {
        if let Some(m) = w.minutes {
            g.length_minutes = Some(m);
        }
    }
    // 手改过的简介 / 年份不覆盖：只有主动「重新匹配」时才先清掉 meta_manual
    if g.meta_manual {
        return;
    }
    if f.summary {
        if let Some(x) = &w.summary {
            g.summary = Some(x.clone());
        }
    }
    if f.year {
        if let Some(y) = w.year {
            g.year = Some(y);
        }
    }
}

/// 取消匹配后的回退：清掉联网结论，再读回作品目录的 meta.json（没有就留空）。
/// 单独成函数是为了能单测——命令本身要 `State`，测不了。
pub fn restore_local_meta(g: &mut Game) {
    let meta = scanner::read_meta(std::path::Path::new(&g.dir));
    apply_local_meta(g, meta);
}

/// 回退的锁内半段：meta 已在锁外读完，这里只做纯内存改写 + 清联网字段。
/// 注释承诺「回到本地 meta.json 的兜底信息」：联网写入的简介 / 标签 / 年份 / 参考分
/// 必须一并回退。以前只是清空，没有读回 meta.json，放了自己的 meta.json 的作品在
/// 「取消匹配」后会变成空白（要等下一次重新匹配才回来）。
pub(crate) fn apply_local_meta(g: &mut Game, meta: scanner::LocalMeta) {
    clear_match(g);
    g.summary = meta.summary.filter(|s| !s.trim().is_empty());
    g.tags = meta.tags;
    g.year = meta.year;
    if let Some(d) = meta.developer.filter(|d| !d.trim().is_empty()) {
        g.developer = Some(d);
    }
    g.meta_score = None;
    g.meta_score_source = None;
    g.meta_score_count = None;
    g.length_minutes = None;
    // 手改标记必须一起清掉：老库里 meta_manual=true 的记录取消匹配后，
    // 自动匹配会以为「用户手改过」而永远不再补简介 / 标签 / 年份
    g.meta_manual = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject() -> net::Subject {
        net::Subject {
            id: 42,
            name: "Kanon".to_string(),
            name_cn: Some("雪之少女".to_string()),
            images_large: Some("https://example.invalid/cover.jpg".to_string()),
            summary: Some("简介".to_string()),
            year: Some(1999),
            score: Some(8.5),
            tags: vec!["恋爱".to_string()],
            collection: 100,
        }
    }

    fn kungal_work() -> kungal::Work {
        kungal::Work {
            id: "4145".to_string(),
            title: "甜蜜女友 3".to_string(),
            original: Some("アマカノ３".to_string()),
            year: Some(2025),
            summary: Some("简介".to_string()),
            cover: Some("https://example.invalid/cover.webp".to_string()),
            score: Some(83.0),
            votes: Some(52),
            minutes: Some(1380),
            aliases: vec!["Amakano 3".to_string()],
        }
    }

    #[test]
    fn apply_fields_default_all_and_parse_selected() {
        assert_eq!(ApplyFields::from_list(None), ApplyFields::all());
        let picked = vec!["title".to_string(), "cover".to_string()];
        let f = ApplyFields::from_list(Some(&picked));
        assert!(f.title && f.cover);
        assert!(!f.summary && !f.score && !f.year && !f.length);
        // 空数组 = 一个字段都不写，用于「只确认身份不覆盖元数据」
        let none = ApplyFields::from_list(Some(&[]));
        assert!(!none.title && !none.score);
    }

    #[test]
    fn apply_subject_fields_only_writes_selected_and_keeps_identity() {
        let mut g = Game::default();
        let picked = vec!["score".to_string()];
        apply_subject_fields(&mut g, &subject(), 100, false, ApplyFields::from_list(Some(&picked)));
        // 未勾选的标题 / 原名 / 年份 / 简介都不应写入
        assert_eq!(g.title, "");
        assert_eq!(g.title_original, None);
        assert_eq!(g.year, None);
        assert!(g.summary.is_none());
        assert!(g.tags.is_empty());
        // 勾选的评分写入；身份与待确认状态始终更新
        assert_eq!(g.meta_score, Some(85.0));
        assert_eq!(g.meta_score_source.as_deref(), Some("bangumi"));
        assert_eq!(g.bangumi_id, Some(42));
        assert_eq!(g.match_score, Some(100));
        assert!(g.matched);
        assert!(!g.pending);
    }

    #[test]
    fn apply_moegirl_fields_skips_summary_and_year_when_unchecked() {
        let a = moegirl::Article {
            title: "雪之少女".to_string(),
            summary: Some("简介".to_string()),
            year: Some(1999),
            score: 90,
            cover: None,
        };
        let mut g = Game::default();
        let picked = vec!["title".to_string()];
        apply_moegirl_fields(&mut g, &a, 100, false, ApplyFields::from_list(Some(&picked)));
        assert_eq!(g.title, "雪之少女");
        assert!(g.summary.is_none());
        assert_eq!(g.year, None);
        assert_eq!(g.meta_source.as_deref(), Some("moegirl"));
    }

    /// 字段级应用：只写勾选项，身份仍更新；评分来源标成 kungal
    #[test]
    fn apply_kungal_fields_only_writes_selected() {
        let mut g = Game::default();
        let picked = vec!["score".to_string(), "length".to_string()];
        apply_kungal_fields(
            &mut g,
            &kungal_work(),
            100,
            false,
            ApplyFields::from_list(Some(&picked)),
        );
        assert_eq!(g.title, "");
        assert_eq!(g.title_original, None);
        assert_eq!(g.year, None);
        assert!(g.summary.is_none());
        assert_eq!(g.kungal_id.as_deref(), Some("4145"));
        assert_eq!(g.meta_score, Some(83.0));
        assert_eq!(g.meta_score_source.as_deref(), Some("kungal"));
        assert_eq!(g.meta_score_count, Some(52));
        assert_eq!(g.length_minutes, Some(1380));
        assert_eq!(g.match_score, Some(100));
        assert!(g.matched);
        assert!(!g.pending);
    }
}

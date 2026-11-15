//! 标签中文化：把 Bangumi / 萌娘百科等源里常见的英文、日文标签映射成中文。
//!
//! 纯本地字典（不出网、不调翻译服务）：命中就换，没命中原样保留——
//! 宁可留一个英文标签，也不要为了「全中文」去猜一个错的中文词。

/// 字典：左边是英文（小写）/ 日文原文，右边是中文。命中即替换。
const DICT: &[(&str, &str)] = &[
    // 类型 / 题材
    ("romance", "恋爱"),
    ("love story", "恋爱"),
    ("drama", "剧情"),
    ("comedy", "喜剧"),
    ("school", "校园"),
    ("school life", "校园"),
    ("slice of life", "日常"),
    ("fantasy", "奇幻"),
    ("science fiction", "科幻"),
    ("sci-fi", "科幻"),
    ("mystery", "悬疑"),
    ("suspense", "悬疑"),
    ("horror", "恐怖"),
    ("thriller", "惊悚"),
    ("tragedy", "悲剧"),
    ("action", "动作"),
    ("adventure", "冒险"),
    ("historical", "历史"),
    ("military", "军事"),
    ("psychological", "心理"),
    ("supernatural", "超自然"),
    ("gore", "血腥"),
    ("yuri", "百合"),
    ("bl", "耽美"),
    ("boys love", "耽美"),
    ("yaoi", "耽美"),
    ("harem", "后宫"),
    ("sports", "运动"),
    ("music", "音乐"),
    ("detective", "侦探"),
    ("war", "战争"),
    ("politics", "政治"),
    ("family", "家庭"),
    ("friendship", "友情"),
    ("coming of age", "成长"),
    ("parody", "恶搞"),
    ("dark", "黑暗"),
    ("gothic", "哥特"),
    ("steampunk", "蒸汽朋克"),
    ("post-apocalyptic", "末世"),
    ("magic", "魔法"),
    ("mythology", "神话"),
    ("crime", "犯罪"),
    ("time travel", "时间旅行"),
    ("amnesia", "失忆"),
    ("mecha", "机甲"),
    ("robot", "机器人"),
    ("vampire", "吸血鬼"),
    ("ghost", "幽灵"),
    ("island", "孤岛"),
    // Galgame 特有
    ("visual novel", "视觉小说"),
    ("kinetic novel", "动态小说"),
    ("nakige", "泣系"),
    ("utsuge", "郁系"),
    ("moe", "萌系"),
    ("nukige", "拔作"),
    ("eroge", "18禁"),
    ("adult", "成人"),
    ("multiple endings", "多结局"),
    ("choices", "选项分支"),
    ("fully voiced", "全语音"),
    ("voiced", "全语音"),
    ("netorare", "寝取"),
    ("ntr", "寝取"),
    ("tsundere", "傲娇"),
    ("yandere", "病娇"),
    ("kuudere", "三无"),
    ("loli", "萝莉"),
    ("maid", "女仆"),
    ("idol", "偶像"),
    ("twintails", "双马尾"),
    // 日文常见标签
    ("恋愛", "恋爱"),
    ("純愛", "纯爱"),
    ("学園", "校园"),
    ("学園物", "校园"),
    ("ホラー", "恐怖"),
    ("ミステリー", "悬疑"),
    ("サスペンス", "悬疑"),
    ("ファンタジー", "奇幻"),
    ("コメディ", "喜剧"),
    ("日常", "日常"),
    ("泣きゲー", "泣系"),
    ("鬱ゲー", "郁系"),
    ("萌え", "萌系"),
    ("青春", "青春"),
    ("バトル", "战斗"),
    ("戦争", "战争"),
    ("歴史", "历史"),
    ("推理", "推理"),
    ("伝奇", "传奇"),
    ("オカルト", "神秘"),
    ("抜きゲー", "拔作"),
    ("エロ", "18禁"),
    ("フルボイス", "全语音"),
    ("マルチエンド", "多结局"),
    ("幼馴染", "青梅竹马"),
    ("お嬢様", "大小姐"),
    ("メイド", "女仆"),
    ("巫女", "巫女"),
    ("部活", "社团"),
    ("田舎", "乡下"),
    ("百合", "百合"),
];

/// 单条标签的中文化；没有对应词条返回 None
pub fn localize(raw: &str) -> Option<&'static str> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    let low = t.to_ascii_lowercase();
    DICT.iter()
        .find(|(k, _)| *k == low || *k == t)
        .map(|(_, v)| *v)
}

/// 批量中文化 + 去重（保留首次出现顺序），最多 12 条。
/// 没命中的标签原样保留——混排也比丢掉信息好。
pub fn localize_all(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        let zh = localize(t).map(str::to_string).unwrap_or_else(|| t.to_string());
        if !out.iter().any(|x| x == &zh) {
            out.push(zh);
        }
        if out.len() >= 12 {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn maps_english_and_japanese() {
        assert_eq!(localize("Romance"), Some("恋爱"));
        assert_eq!(localize("visual novel"), Some("视觉小说"));
        assert_eq!(localize("ミステリー"), Some("悬疑"));
        assert_eq!(localize("纯爱"), None, "中文标签没有词条，原样保留");
        assert_eq!(localize("  "), None);
    }

    #[test]
    fn localize_all_dedupes_and_keeps_unknown() {
        // 两个英文标签映射到同一个中文 → 只留一条；未知标签原样保留
        let out = localize_all(&v(&["Romance", "Love Story", "SomeWeirdTag", "学園"]));
        assert_eq!(out, v(&["恋爱", "SomeWeirdTag", "校园"]));
    }

    #[test]
    fn localize_all_caps_at_twelve() {
        let many: Vec<String> = (0..30).map(|i| format!("tag{i}")).collect();
        assert_eq!(localize_all(&many).len(), 12);
    }
}

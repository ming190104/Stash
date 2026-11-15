//! 读取 Windows PE 版本资源。
//!
//! Galgame 的 exe 版本信息里经常直接写着游戏名与会社，
//! 这是本地库识别最可靠的信息来源之一。

pub struct PeInfo {
    pub product: Option<String>,
    pub description: Option<String>,
    pub company: Option<String>,
    pub file_version: Option<String>,
}

/// 清洗版本资源字符串：去控制字符、去首尾空白、过滤无效内容。
fn clean(raw: &str) -> Option<String> {
    let s: String = raw
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    let s = s.trim().trim_matches('\0').trim().to_string();
    if s.is_empty() || s.chars().all(|c| c == '\u{fffd}' || c == '?') {
        return None;
    }
    Some(s)
}

/// 读取 exe 的版本资源，失败返回 None（不是每个 exe 都有）。
pub fn read(exe: &std::path::Path) -> Option<PeInfo> {
    let map = pelite::FileMap::open(exe).ok()?;
    let pe = pelite::PeFile::from_bytes(&map).ok()?;
    let resources = pe.resources().ok()?;
    let version = resources.version_info().ok()?;
    // pelite 0.10：strings() 为回调式；Translation 表列出所有语言块，
    // 只取第一项时，若该语言在 StringFileInfo 里没有对应块（多语言打包的汉化 exe 常见），
    // 三个字段会全空 → 整个版本资源被判成「没有」，主程序打分白丢最多 160 分。
    // 这里遍历全部语言，逐字段取第一个非空值。
    let mut info = PeInfo {
        product: None,
        description: None,
        company: None,
        file_version: None,
    };

    for &lang in version.translation() {
        version.strings(lang, |key, value| {
            // 逐字段取第一个非空值（同一字段命中过就跳过，等价于原先的 is_none 判断）
            match key {
                "ProductName" if info.product.is_none() => info.product = clean(value),
                "FileDescription" if info.description.is_none() => info.description = clean(value),
                "CompanyName" if info.company.is_none() => info.company = clean(value),
                "FileVersion" if info.file_version.is_none() => {
                    info.file_version = clean(value)
                }
                _ => {}
            }
        });
        if info.product.is_some() && info.description.is_some() && info.company.is_some() {
            break;
        }
    }

    if info.product.is_none() && info.description.is_none() && info.company.is_none() {
        return None;
    }
    Some(info)
}

//! 引擎识别。
//!
//! 判断顺序按特征可靠度排序：越明确的特征越先判定，
//! 避免 `*.arc` 这类多引擎共用的扩展名造成误判。

use crate::models::EngineKind;
use std::collections::HashSet;
use std::path::Path;

/// 只关心这些扩展名的文件，避免在 Unity 这种上千文件的目录里做全量遍历。
const WATCHED_EXTS: &[&str] = &[
    "xp3", "rpyc", "nsa", "ns2", "pfs", "pfsx", "mjo", "ypf", "int", "cst", "pack", "pac",
    "arc", "wolf", "lsb", "tbg", "pck", "pak", "lrc",
];

#[derive(Default)]
struct Probe {
    /// 一层目录下的文件名（小写、带扩展名）
    files: HashSet<String>,
    /// 一层 + 二层目录下出现过的关心扩展名
    exts: HashSet<String>,
    /// 一层目录下的子目录名（小写）
    dirs: HashSet<String>,
}

fn probe(dir: &Path) -> Probe {
    let mut p = Probe::default();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return p;
    };

    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if is_dir {
            p.dirs.insert(name);
            // 二层只看关心的扩展名
            if let Ok(rd2) = std::fs::read_dir(entry.path()) {
                for e2 in rd2.flatten() {
                    let n2 = e2.file_name().to_string_lossy().to_lowercase();
                    if let Some(ext) = extension_of(&n2) {
                        if WATCHED_EXTS.contains(&ext) {
                            p.exts.insert(ext.to_string());
                        }
                    }
                }
            }
        } else {
            if let Some(ext) = extension_of(&name) {
                p.exts.insert(ext.to_string());
            }
            p.files.insert(name);
        }
    }
    p
}

fn extension_of(name: &str) -> Option<&str> {
    match name.rfind('.') {
        Some(i) if i + 1 < name.len() => Some(&name[i + 1..]),
        _ => None,
    }
}

/// 返回 (引擎, 判定依据)。依据会显示在详情页，方便排查误判。
pub fn detect(dir: &Path) -> (EngineKind, String) {
    let p = probe(dir);

    // ---- 现代引擎，特征唯一，优先级最高 ----
    if p.files.contains("unityplayer.dll") || p.files.contains("gameassembly.dll") {
        return (EngineKind::Unity, "UnityPlayer.dll".into());
    }

    if p.dirs.contains("www") && (p.files.contains("nw.exe") || p.files.contains("nw.dll")) {
        return (EngineKind::RpgMaker, "www/ + nw.exe".into());
    }

    if p.dirs.contains("game") && (p.dirs.contains("renpy") || p.exts.contains("rpyc")) {
        return (EngineKind::RenPy, "game/ + renpy/".into());
    }
    if p.exts.contains("rpyc") {
        return (EngineKind::RenPy, "*.rpyc".into());
    }

    if p.files.contains("siglusengine.exe") || p.files.contains("scene.pck") {
        return (EngineKind::Siglus, "SiglusEngine".into());
    }

    // ---- 老牌 AVG 引擎 ----
    if p.files.contains("onscripter.exe")
        || p.files.contains("0.txt")
        || p.files.contains("0.utf")
    {
        return (EngineKind::ONScripter, "onscripter".into());
    }

    if p.files.contains("nscript.dat") || p.exts.contains("nsa") || p.exts.contains("ns2") {
        return (EngineKind::NScripter, "nscript.dat".into());
    }

    // ---- 明确的 exe / 特征文件名优先于「扩展名」这类弱证据 ----
    // `*.pack` / `*.pac` / `*.xp3` 在多个引擎的目录里都可能顺带出现（解包残留、补丁包、
    // 汉化组塞的资源），若先按扩展名判定，带 bgi.exe 的 BGI 作品会被认成 QLIE、
    // 带 Data.wolf 的 Wolf 作品会被认成 Cmvs —— 存档目录探测与转区提示都跟着错。
    if p.files.contains("cs2.exe") {
        return (EngineKind::CatSystem2, "cs2.exe".into());
    }

    if p.files.contains("cmvs32.exe") || p.files.contains("cmvs64.exe") {
        return (EngineKind::Cmvs, "CMVS".into());
    }

    if p.files.contains("bgi.exe") {
        return (EngineKind::Bgi, "bgi.exe".into());
    }

    if p.files.contains("data.wolf") {
        return (EngineKind::WolfRpg, "Data.wolf".into());
    }

    // ---- 其余按资源扩展名判定（弱证据，放在最后） ----
    if p.exts.contains("xp3") {
        return (EngineKind::Kirikiri, "*.xp3".into());
    }

    if p.exts.contains("pfs") || p.exts.contains("pfsx") {
        return (EngineKind::Artemis, "*.pfs".into());
    }

    if p.exts.contains("mjo") {
        return (EngineKind::Majiro, "*.mjo".into());
    }

    if p.exts.contains("ypf") || p.dirs.contains("ysbin") {
        return (EngineKind::YuRis, "*.ypf".into());
    }

    if p.exts.contains("int") && p.exts.contains("cst") {
        return (EngineKind::CatSystem2, "*.int".into());
    }

    if p.exts.contains("pac") {
        return (EngineKind::Cmvs, "*.pac".into());
    }

    if p.exts.contains("pack") {
        return (EngineKind::Qlie, "*.pack".into());
    }

    if p.exts.contains("arc") {
        return (EngineKind::Bgi, "*.arc".into());
    }

    (EngineKind::Unknown, "无特征文件".into())
}

/// 传统日文引擎：文本资源是 Shift-JIS，系统 ACP 不是 932 时容易乱码或拒绝启动。
/// Ren'Py / Unity / RPG Maker MV 是 UTF-8 或 Unicode 构建，不在此列。
pub fn shift_jis_engine(k: EngineKind) -> bool {
    matches!(
        k,
        EngineKind::Kirikiri
            | EngineKind::NScripter
            | EngineKind::Artemis
            | EngineKind::Majiro
            | EngineKind::Bgi
            | EngineKind::CatSystem2
            | EngineKind::YuRis
            | EngineKind::Siglus
            | EngineKind::Cmvs
            | EngineKind::Qlie
            | EngineKind::WolfRpg
    )
}

/// 目录名里是否有假名（片假名/平假名）——日文原版目录的常见特征
fn has_kana(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '\u{3040}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}'))
}

/// 系统是不是日文区域（ACP = 932）
pub fn system_is_japanese() -> bool {
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::Globalization::GetACP() == 932
    }
    #[cfg(not(windows))]
    false
}

/// 转区判断：日文系统下永远不需要；非日文系统下，「目录名含假名」或
/// 「引擎本身是 Shift-JIS 老引擎」任一成立即提示。ASCII 目录名的日文游戏
/// （重打包很常见）也能靠引擎表识别出来。
pub fn needs_locale(dir: &Path, engine: EngineKind, system_jp: bool) -> bool {
    if system_jp {
        return false;
    }
    let name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    has_kana(&name) || shift_jis_engine(engine)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kana_is_detected() {
        assert!(has_kana("サクラノ詩"));
        assert!(has_kana("素晴らしき日々"));
        assert!(!has_kana("Sakura no Uta"));
        assert!(!has_kana("千恋万花"), "汉字不算假名，避免误报");
    }

    #[test]
    fn locale_flags_legacy_engines_only_off_jp_system() {
        let ascii = Path::new("/games/Sakura");
        assert!(needs_locale(ascii, EngineKind::Kirikiri, false), "Shift-JIS 引擎 + 非日文系统");
        assert!(!needs_locale(ascii, EngineKind::Kirikiri, true), "日文系统不用转区");
        assert!(!needs_locale(ascii, EngineKind::RenPy, false), "UTF-8 引擎不该提示");
        assert!(!needs_locale(ascii, EngineKind::Unity, false));
        assert!(
            needs_locale(Path::new("/games/サクラ"), EngineKind::Unknown, false),
            "假名目录名兜底"
        );
    }

    /// 明确的 exe / 特征文件名必须压过「扩展名」这类弱证据：
    /// 带 bgi.exe 的目录里同时有补丁包 .pack / .pac / .arc 是常见情况，
    /// 先按扩展名判定会把存档目录与转区提示一起判错
    #[test]
    fn strong_filename_beats_generic_extension() {
        let base = std::env::temp_dir().join(format!("stash-engine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        let bgi = base.join("BgiGame");
        std::fs::create_dir_all(&bgi).unwrap();
        for n in ["bgi.exe", "patch.pack", "voice.pac", "data.arc"] {
            std::fs::write(bgi.join(n), b"x").unwrap();
        }
        assert_eq!(detect(&bgi).0, EngineKind::Bgi, "bgi.exe 强于 *.pack / *.pac");

        let wolf = base.join("WolfGame");
        std::fs::create_dir_all(&wolf).unwrap();
        for n in ["Data.wolf", "extra.pack"] {
            std::fs::write(wolf.join(n), b"x").unwrap();
        }
        assert_eq!(detect(&wolf).0, EngineKind::WolfRpg, "Data.wolf 强于 *.pack");

        // 没有任何强证据时才按扩展名兜底
        let qlie = base.join("QlieGame");
        std::fs::create_dir_all(&qlie).unwrap();
        std::fs::write(qlie.join("game.pack"), b"x").unwrap();
        assert_eq!(detect(&qlie).0, EngineKind::Qlie);

        let _ = std::fs::remove_dir_all(&base);
    }
}

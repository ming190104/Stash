//! 转区启动：内置 Locale Emulator 探测、启动方式选择与前置检查。

use crate::models::{AppError, ErrCode, Game, Settings};
use crate::store::Store;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 安装目录里自带 Locale Emulator 时，把「转区工具」指向它。
/// 只在当前路径为空 / 已失效时写入——用户自己选好的可用工具绝不被覆盖。
pub fn ensure_bundled_tool(app: &AppHandle, store: &Store) {
    let Ok(res) = app.path().resource_dir() else { return };
    let tool = res.join("locale-emulator").join("LEProc.exe");
    if !tool.is_file() {
        return;
    }
    // resource_dir 在 Windows 上带 `\\?\` 前缀：写进设置里既难读，
    // 交给第三方启动器时也不一定认，这里去掉
    let tool = {
        let s = tool.to_string_lossy().into_owned();
        match s.strip_prefix(r"\\?\") {
            Some(rest) => PathBuf::from(rest),
            None => tool,
        }
    };
    let _lock = crate::store::lock_settings();
    let mut s = store.load_settings();
    let cur = s.locale.tool_path.as_deref().map(str::trim).unwrap_or("");
    if !cur.is_empty() && Path::new(cur).is_file() {
        return;
    }
    let p = tool.to_string_lossy().to_string();
    if s.locale.tool_path.as_deref() == Some(p.as_str()) {
        return;
    }
    s.locale.tool_path = Some(p);
    match store.save_settings(&s) {
        Ok(()) => tracing::info!("转区工具：使用安装目录内置的 Locale Emulator"),
        Err(e) => tracing::warn!("写入内置转区工具路径失败：{e}"),
    }
}

/// 转区启动的两种调用方式
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LeMode {
    /// 作品目录里有 `<exe>.le.config`：`-run <exe>` 按作品自己的配置启动
    AppConfig,
    /// 否则用 LEConfig.xml 的第一条全局配置：`-runas <guid> <exe>`
    Profile(String),
}

/// 纯选择逻辑（便于单测）：作品配置优先，其次全局配置；两样都没有就拒启。
fn select_le_mode(has_app_config: bool, profile: Option<String>) -> Option<LeMode> {
    if has_app_config {
        return Some(LeMode::AppConfig);
    }
    profile
        .filter(|g| !g.trim().is_empty())
        .map(LeMode::Profile)
}

/// 转区启动前置检查：工具路径必须真实存在，且至少有一种可用的启动方式。
/// 这些问题的共同点是「用户必须去设置页改点什么」——静默直启或退回 `-run`
/// 只会让日文老游戏乱码 / 闪退 / 弹出 LEGUI，看起来像应用坏了。
pub(super) fn plan_locale(settings: &Settings, game: &Game) -> Result<(PathBuf, LeMode), AppError> {
    let tool = settings
        .locale
        .tool_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            AppError::new(
                ErrCode::LaunchFailed,
                "需要转区启动，但还没有选择转区工具：设置 → 启动 → 转区工具 → 选择 LEProc.exe",
            )
        })?;
    if !tool.is_file() {
        return Err(AppError::new(
            ErrCode::LaunchFailed,
            format!(
                "转区工具不可用：{}。请到 设置 → 启动 → 转区工具 重新选择 LEProc.exe",
                tool.display()
            ),
        ));
    }
    let conf = PathBuf::from(format!("{}.le.config", game.exe));
    let mode = select_le_mode(conf.is_file(), first_le_profile(&tool)).ok_or_else(|| {
        AppError::new(
            ErrCode::LaunchFailed,
            format!(
                "转区工具尚未初始化：{} 下没有 LEConfig.xml，作品目录也没有对应的 .le.config。\
                 请先手动运行一次 Locale Emulator 保存配置，再回 设置 → 启动 重试",
                tool.parent().unwrap_or(&tool).display()
            ),
        )
    })?;
    Ok((tool, mode))
}

/// LEConfig.xml 的第一个配置（默认「Run in Japanese」：ja-JP / Tokyo）。
/// `-runas <guid> <exe>` 用它启动；读不到配置时返回 None（此时由前置检查报错）。
fn first_le_profile(tool: &Path) -> Option<String> {
    let xml = std::fs::read_to_string(tool.parent()?.join("LEConfig.xml")).ok()?;
    le_profile_guid(&xml)
}

/// 从 LEConfig.xml 文本取第一条 `<Profile>` 的 Guid（纯字符串解析，便于单测）。
fn le_profile_guid(xml: &str) -> Option<String> {
    let start = xml.find("<Profile ")? + "<Profile ".len();
    // 只在标签内部找 Guid，避免配置正文里出现同名属性时串到别的配置上
    let tag = &xml[start..start + xml[start..].find('>')?];
    let g = tag.find("Guid=\"")? + "Guid=\"".len();
    let guid = &tag[g..g + tag[g..].find('"')?];
    if guid.trim().is_empty() {
        None
    } else {
        Some(guid.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 作品自带 le.config 优先；没有时退回 LEConfig.xml 第一条配置；两样都没有就不启动
    #[test]
    fn locale_mode_prefers_app_config() {
        assert_eq!(select_le_mode(true, Some("guid-a".into())), Some(LeMode::AppConfig));
        assert_eq!(
            select_le_mode(false, Some("guid-a".into())),
            Some(LeMode::Profile("guid-a".into()))
        );
        assert_eq!(select_le_mode(false, None), None);
        assert_eq!(select_le_mode(false, Some("   ".into())), None, "空 guid 不能当成可用配置");
    }
    /// 只取第一条配置的 Guid，且不能把后面配置的 Guid 串进来
    #[test]
    fn reads_first_profile_guid() {
        let xml = r#"<?xml version="1.0"?>
<LEConfig>
  <Profiles>
    <Profile Name="Run in Japanese" Guid="ec9b28ba-1113-4a9a-a4a5-e931819c7720" />
    <Profile Name="Run in Japanese (Admin)" Guid="00000000-1111-2222-3333-444444444444" />
  </Profiles>
</LEConfig>"#;
        assert_eq!(
            le_profile_guid(xml).as_deref(),
            Some("ec9b28ba-1113-4a9a-a4a5-e931819c7720")
        );
        // 未初始化（还没跑过 LEInstaller / LEGUI）与属性不全的配置都不能当成可用
        assert_eq!(le_profile_guid("<LEConfig><Profiles></Profiles></LEConfig>"), None);
        assert_eq!(le_profile_guid(r#"<Profile Name="x" />"#), None);
        assert_eq!(le_profile_guid(r#"<Profile Guid="" />"#), None);
    }
}

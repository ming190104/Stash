//! 数据源可达性探测：设置页的「测试连接」与匹配前的预检。

use crate::models::{AppError, ErrCode, Settings};
use crate::store::Store;
use crate::{egs, kungal, moegirl, net};
use tauri::State;

/// 一轮探测的总预算（见 `probe_sources_sync`）：超出的源标 skipped，不再逐个等超时。
const PROBE_BUDGET: std::time::Duration = std::time::Duration::from_secs(45);

/// 网络连通性自检（设置 · 网络页的「测试连接」）：一个真实搜索请求的最简路径。
/// `async`：同步命令跑在主线程，而这里要等网络（Bangumi 不可达时单次 10s 超时 ×2）。
#[tauri::command]
pub async fn test_network(store: State<'_, Store>) -> Result<String, AppError> {
    let s = store.load_settings();
    if !s.network.metadata_enabled {
        // 与 search / match_all 一致：开关没开是配置问题，不报「断网」
        return Err(AppError::new(ErrCode::ConfigInvalid, "在线元数据未开启"));
    }
    // 用户点「测试连接」= 明确要求重新探测，复位上一轮的 Bangumi / EGS / 萌娘百科 离线标记
    net::reset_bangumi_offline();
    egs::reset_offline();
    moegirl::reset_offline();
    // 搜索本身是阻塞网络调用（含 1req/s 节流等待），别占 tokio worker
    tauri::async_runtime::spawn_blocking(move || match net::search(&s, "CLANNAD") {
        Ok(list) => Ok(format!("连接正常 · Bangumi 返回 {} 条", list.len())),
        Err(e) if s.network.moegirl_fallback => {
            // Bangumi 在部分网络下不可达：只要萌娘百科还能用，元数据功能就算可用
            match moegirl::lookup(&s, "CLANNAD") {
                Ok(Some(a)) => Ok(format!("Bangumi 不可达；萌娘百科兜底可用（{}）", a.title)),
                Ok(None) => Err(AppError::new(
                    ErrCode::NetworkOffline,
                    format!("Bangumi 不可达（{}）；萌娘百科无结果", e.message),
                )),
                Err(me) => Err(AppError::new(
                    ErrCode::NetworkOffline,
                    format!(
                        "Bangumi 不可达（{}）；萌娘百科也不可用（{}）",
                        e.message, me.message
                    ),
                )),
            }
        }
        Err(e) => Err(e),
    })
    .await
    .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

/* ============ 数据源可达性探测（设置 · 元数据 / 匹配前预检） ============ */

/// 单个数据源的探测结论。`status` 是固定枚举值，前端直接映射文案。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    /// "ok" | "offline" | "limited" | "error" | "disabled" | "skipped"
    pub status: &'static str,
    pub message: String,
}

/// 一次探测的完整结果。Bangumi 与萌娘百科决定匹配能否进行，EGS 只补评分。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProbe {
    pub bangumi: SourceStatus,
    pub moegirl: SourceStatus,
    pub egs: SourceStatus,
    pub kungal: SourceStatus,
    /// 当前生效的系统代理（Windows 设置里读取）；None = 直连
    pub proxy: Option<String>,
    /// Bangumi / 萌娘百科 / 鲲 Galgame 任一可用即可跑匹配
    pub usable: bool,
    /// 给用户看的结论 / 引导文案
    pub message: Option<String>,
}

/// 把错误码折成前端可判定的状态串。
/// 注意 ConfigInvalid 在探测语境下是「系统代理格式不支持」，
/// 归到 error 而不是 disabled——否则界面会显示成「未开启」，掩盖真正原因。
fn code_status(c: ErrCode) -> &'static str {
    match c {
        ErrCode::NetworkOffline => "offline",
        ErrCode::RateLimited => "limited",
        _ => "error",
    }
}

/// 逐源探测（阻塞网络，调用方负责放到后台线程）。
/// `with_egs = false` 时跳过 EGS：匹配预检只需要判断主源能否开工，没必要多等一次超时。
/// 探测会复位各源的 offline 标记，等同于一次「用户明确要求重试」。
pub fn probe_sources_sync(s: &Settings, with_egs: bool) -> SourceProbe {
    let proxy = net::system_proxy();

    if !s.network.metadata_enabled {
        // 开关没开是配置问题：不发任何请求，直接告诉前端三个源都未启用
        let off = || SourceStatus {
            status: "disabled",
            message: "在线元数据未开启（设置 · 网络）".to_string(),
        };
        return SourceProbe {
            bangumi: off(),
            moegirl: off(),
            egs: off(),
            kungal: off(),
            proxy,
            usable: false,
            message: Some("在线元数据未开启（设置 · 网络）".to_string()),
        };
    }

    // 用户点「测试」/ 开始匹配 = 明确要求重新探测，上一轮的超时不该继续短路
    net::reset_bangumi_offline();
    moegirl::reset_offline();
    egs::reset_offline();
    kungal::reset_offline();

    // 整轮预算：单个源最坏要等 3 次重试 × 10s，四源串行能拖到两分钟以上，
    // 「测试」按钮不该让人干等；超预算的源标 skipped，由前端显示为「跳过」。
    let started = std::time::Instant::now();
    let budget_over = || started.elapsed() >= PROBE_BUDGET;
    let skipped = |name: &str| SourceStatus {
        status: "skipped",
        message: format!("{name}：整轮探测 45 秒预算已用尽，未探测"),
    };

    let bangumi = if budget_over() {
        skipped("Bangumi")
    } else {
        match net::search(s, "CLANNAD") {
            Ok(list) => SourceStatus {
                status: "ok",
                message: format!("Bangumi 可达（样例返回 {} 条）", list.len()),
            },
            Err(e) => SourceStatus {
                status: code_status(e.code),
                message: format!("Bangumi：{}", e.message),
            },
        }
    };
    // 鲲 Galgame 国内直连，不依赖代理；放在萌娘 / EGS 之前：它是 usable 的三个判定源之一，
    // 预算用尽时也必须拿到它的结论，否则会把「只有鲲可用」误报成全部不可达
    let kungal = if budget_over() {
        skipped("鲲 Galgame")
    } else {
        match kungal::probe(s) {
            Ok(_) => SourceStatus {
                status: "ok",
                message: "鲲 Galgame 可达（标题 / 简介 / 评分 / 时长）".to_string(),
            },
            Err(e) => SourceStatus {
                status: code_status(e.code),
                message: format!("鲲 Galgame：{}", e.message),
            },
        }
    };
    // 萌娘百科只在开着兜底时才有意义；关闭时不必浪费一次请求
    let moegirl = if !s.network.moegirl_fallback {
        SourceStatus {
            status: "disabled",
            message: "萌娘百科兜底未开启".to_string(),
        }
    } else if budget_over() {
        skipped("萌娘百科")
    } else {
        match moegirl::lookup(s, "CLANNAD") {
            // 有结果 / 无结果都算可达：连不上才会走到 Err
            Ok(_) => SourceStatus {
                status: "ok",
                message: "萌娘百科可达".to_string(),
            },
            Err(e) => SourceStatus {
                status: code_status(e.code),
                message: format!("萌娘百科：{}", e.message),
            },
        }
    };
    let egs = if !with_egs {
        SourceStatus {
            status: "skipped",
            message: "匹配预检不探测".to_string(),
        }
    } else if budget_over() {
        skipped("EGS")
    } else {
        match egs::lookup(s, "CLANNAD") {
            Ok(_) => SourceStatus {
                status: "ok",
                message: "EGS 可达（仅补评分 / 时长）".to_string(),
            },
            Err(e) => SourceStatus {
                status: code_status(e.code),
                message: format!("EGS：{}", e.message),
            },
        }
    };

    let bangumi_ok = bangumi.status == "ok";
    let moegirl_ok = moegirl.status == "ok";
    let kungal_ok = kungal.status == "ok";
    let usable = bangumi_ok || moegirl_ok || kungal_ok;
    // 预算耗尽导致跳过的源不能算进「都不可达」：结论要指向超时，而不是让用户去查网络
    let timed_out = bangumi.status == "skipped"
        || moegirl.status == "skipped"
        || kungal.status == "skipped";
    let message = if !usable {
        if timed_out {
            Some("探测超时（网络较慢或代理不可用），请稍后重试".to_string())
        } else if bangumi.status == "limited" {
            // 429 冷却不是「不可达」：等一分钟或换代理都能恢复，不能误导用户去查网络
            Some("Bangumi 触发限流（约 60 秒冷却），请稍后重试；长期如此建议在 Windows 设置里启用系统代理".to_string())
        } else if moegirl.status == "disabled" {
            Some("Bangumi 不可达且萌娘百科兜底未开启；可在 Windows 设置里启用系统代理，或检查鲲 Galgame 是否可达".to_string())
        } else {
            Some("Bangumi / 萌娘百科 / 鲲 Galgame 都不可达；Bangumi 需要代理，请在 Windows 设置里启用系统代理".to_string())
        }
    } else if !bangumi_ok && !moegirl_ok {
        Some("Bangumi 与萌娘百科不可达，本轮仅用鲲 Galgame 数据源".to_string())
    } else if !bangumi_ok {
        Some("Bangumi 不可达，本轮用萌娘百科 / 鲲 Galgame 兜底；可在 Windows 设置里启用系统代理".to_string())
    } else {
        None
    };

    SourceProbe {
        bangumi,
        moegirl,
        egs,
        kungal,
        proxy,
        usable,
        message,
    }
}

/// 数据源探测（设置 · 元数据页的「测试」）：结构化返回每个源的状态 + 当前系统代理。
/// `async`：内部要真实发请求（含 1req/s 节流与超时），不能占主线程。
#[tauri::command]
pub async fn probe_sources(store: State<'_, Store>) -> Result<SourceProbe, AppError> {
    let s = store.load_settings();
    tauri::async_runtime::spawn_blocking(move || probe_sources_sync(&s, true))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_status_maps_network_errors() {
        assert_eq!(code_status(ErrCode::NetworkOffline), "offline");
        assert_eq!(code_status(ErrCode::RateLimited), "limited");
        // 系统代理格式不支持属于配置错误，界面要显示「异常」而不是「未开启」
        assert_eq!(code_status(ErrCode::ConfigInvalid), "error");
        assert_eq!(code_status(ErrCode::ServerError), "error");
        assert_eq!(code_status(ErrCode::IoError), "error");
    }

    #[test]
    fn probe_short_circuits_when_metadata_disabled() {
        let mut s = Settings::default();
        s.network.metadata_enabled = false;
        // 未开启时不发任何请求：四源都是 disabled，且 with_egs 不改变结论
        for with_egs in [true, false] {
            let p = probe_sources_sync(&s, with_egs);
            assert!(!p.usable);
            assert_eq!(p.bangumi.status, "disabled");
            assert_eq!(p.moegirl.status, "disabled");
            assert_eq!(p.egs.status, "disabled");
            assert_eq!(p.kungal.status, "disabled");
            assert!(p.message.is_some());
        }
    }

    /// 预检要跟随「鲲 Galgame 直连」这一独立通道：主源不可达时不能整体判死，
    /// 只有全部不可达才 usable=false。系统代理是否可用由环境决定，这里不假设。
    #[test]
    fn probe_treats_kungal_as_independent_fallback() {
        let mut s = Settings::default();
        s.network.metadata_enabled = true;
        s.network.moegirl_fallback = true;

        let p = probe_sources_sync(&s, false);
        assert_eq!(p.egs.status, "skipped", "预检不探测 EGS");
        let msg = p.message.clone().unwrap_or_default();
        if p.kungal.status == "ok" {
            // 鲲 Galgame 直连、不走系统代理：主源坏掉时仍可单独开工
            assert!(p.usable);
            assert!(
                p.bangumi.status == "ok" || msg.contains("鲲 Galgame"),
                "文案要说明兜底来源：{msg}"
            );
        } else {
            assert!(!p.usable);
        }

        // 探到的不可达会留下 offline 标记：本轮后续请求直接短路，不再逐个等超时
        net::reset_bangumi_offline();
        moegirl::reset_offline();
        kungal::reset_offline();
    }
}

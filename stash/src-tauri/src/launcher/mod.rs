//! 启动器（总案第 8 章）：工作目录 + Job Object 进程树管理 + 退出回报。
//!
//! Job Object 挂 KILL_ON_JOB_CLOSE：游戏本体拉起的任何子进程（启动器、转码器、
//! 汉化补丁壳）都收进同一 Job；Stash 自己退出或 stop_game 时整树回收，
//! 杜绝「游戏退了，后台进程还在」。
//!
//! 子模块：
//! - `job`：Job Object 创建 / 挂载 / 等待与进程枚举（Windows）
//! - `locale`：转区工具探测与启动方式选择
//! - `run`：启动 / 停止 / 运行态与游玩记录收尾
#[cfg(windows)]
mod job;
mod locale;
mod run;

pub use locale::*;
pub use run::*;

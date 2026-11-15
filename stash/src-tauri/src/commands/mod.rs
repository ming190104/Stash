//! IPC 命令按主题分组：lib.rs 只保留 builder、状态装配与 generate_handler 列表。
//!
//! 分组依据是「命令做什么」而不是「代码原来在哪」：
//! - library：读取 / 手动添加（含 asset 白名单登记）
//! - game：启动 / 停止 / 运行中查询 / 手柄
//! - settings：设置读写、开机自启、全屏、锁 60Hz
//! - records：library.json 的单条记录读写（收藏 / 标签 / END / 移除）
//! - fs：只读文件浏览（列盘符 / 列目录 / 定位）
//! - update：GitHub Release 版本检查 / 打开下载页

pub mod fs;
pub mod game;
pub mod library;
pub mod records;
pub mod settings;
pub mod update;

//! Bangumi 元数据客户端（总案 7.1–7.3）。
//!
//! 硬约束（社区 API 无 SLA，礼貌为先）：
//! - 每个站点并发 1、间隔 ≥1s（`TICK`）；不同站点之间并行，互不阻塞
//! - 可识别 UA（Bangumi 硬要求，缺了就 403）
//! - 连接 5s / 整请求 10s 超时，失败指数退避最多 3 次
//! - **reqwest 不读 Windows 系统代理**：设置里填了才走代理，默认直连
//! - 全链路 Result<_, AppError>，错误码给前端按 code 分支（禁止字符串匹配）
//!
//! 子模块：
//! - `client`：串行阀门、限流冷却、超时 / 代理 / 响应大小上限
//! - `bangumi`：检索、结果重排与相似度打分
//! - `image`：图片下载与落盘
mod bangumi;
mod client;
mod image;

pub use bangumi::*;
pub use client::*;
pub use image::*;

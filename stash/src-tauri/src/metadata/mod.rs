//! 元数据匹配流水线（总案第 7 章）：Bangumi → 萌娘百科 的检索、打分与回写。
//!
//! 并发约定：每部先在锁外做网络与封面下载，再在锁内 load → 改 → save；
//! 所有请求都过 net 的串行阀门（1 req/s + 429 冷却）。
//!
//! 子模块：
//! - `matching`：关键字、打分、单部 / 全量匹配
//! - `apply`：字段级回写与「取消匹配」的本地回退
//! - `candidates`：四源并行候选
//! - `bind`：人工绑定 / 取消匹配命令与封面下载
//! - `probe`：数据源可达性探测
mod apply;
mod bind;
mod candidates;
mod matching;
mod probe;

pub use apply::*;
pub use bind::*;
pub use candidates::*;
pub use matching::*;
pub use probe::*;

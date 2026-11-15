//! 游戏运行命令：启动 / 停止 / 运行中查询、手柄状态。

use crate::models::{AppError, ErrCode, Game};
use crate::store::Store;
use crate::{input, launcher};
use tauri::{AppHandle, State};

/// 启动游戏。必须是 `async`：同步命令跑在主线程，而这里要等转区工具接管进程
/// （最长 8 秒），会直接把整个界面冻住。
#[tauri::command]
pub async fn launch_game(app: AppHandle, store: State<'_, Store>, id: String) -> Result<(), AppError> {
    let games = store.load_library();
    let game = games
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中（可能已移除）"))?;
    // 转区接管最长 8 秒：放在 tokio worker 上会占住其它 async 命令
    // （导入 / 代理 / 匹配），必须挪到阻塞线程池
    let st = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || launcher::launch(app, st, game))
        .await
        .map_err(|e| AppError::new(ErrCode::IoError, e.to_string()))?
}

#[tauri::command]
pub fn stop_game(id: String) -> Result<(), AppError> {
    launcher::stop(&id)
}

/// 当前运行中的游戏（启动后对账 / 截图热键用；没在运行则 None）
#[tauri::command]
pub fn running_game(store: State<'_, Store>) -> Option<Game> {
    let id = launcher::running_id()?;
    store.load_library().into_iter().find(|g| g.id == id)
}

/// 当前手柄连接状态。前端启动时补查一次：手柄线程起得比页面早，
/// `pad://status` 事件在页面就绪前发出去就丢了，底栏会一直停在键盘键位。
#[tauri::command]
pub fn pad_status() -> serde_json::Value {
    let st = input::pad_status();
    serde_json::json!({
        "connected": st.connected,
        "name": st.name,
        "kind": st.kind,
        "power": st.power,
        "ff": st.ff,
    })
}

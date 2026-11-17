//! 游戏运行命令：启动 / 停止 / 运行中查询、手柄状态。

use crate::models::{AppError, ErrCode, Game};
use crate::store::Store;
use crate::{input, launcher};
use tauri::{AppHandle, State};

/// 启动游戏。必须是 `async`：同步命令跑在主线程，而这里要等转区工具接管进程
/// （最长 8 秒），会直接把整个界面冻住。
#[tauri::command]
pub async fn launch_game(app: AppHandle, store: State<'_, Store>, id: String) -> Result<(), AppError> {
    // 读也取库锁：保存瞬间主文件正被 rename，无锁读可能拿到上一代库（拿到已被移除的条目）
    let games = {
        let _lock = crate::store::lock_library();
        store.load_library()
    };
    let game = games
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| AppError::new(ErrCode::NotFound, "游戏不在库中（可能已移除）"))?;
    // library.json 在用户目录下，手工改一行就能把 exe 换到任何位置；
    // 启动前再校验一次「主程序仍在该作品目录内」，让篡改只换来一条报错。
    crate::guard_game_exe(
        std::path::Path::new(&game.exe),
        std::path::Path::new(&game.dir),
    )?;
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

/// 当前运行中的游戏（启动后对账用；没在运行则 None）
#[tauri::command]
pub async fn running_game(store: State<'_, Store>) -> Result<Option<Game>, AppError> {
    // 读整库 + 枚举进程都是阻塞操作：放主线程会冻界面（云同步盘尤其明显）
    let st = store.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        launcher::running_id().and_then(|id| {
            let games = {
                let _lock = crate::store::lock_library();
                st.load_library()
            };
            games.into_iter().find(|g| g.id == id)
        })
    })
    .await
    .ok()
    .flatten())
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

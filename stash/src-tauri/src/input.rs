//! 手柄输入：gilrs 轮询 → NavIntent 语义事件（总案 6.1）。
//!
//! 死区 / 迟滞 / 重复速率 / 斜向锁存只在这里实现一次，
//! 前端只消费 `nav://intent` 事件，零输入逻辑。
//! 键盘路径由前端监听后汇入同一分发函数（dev 无手柄也能完整操作）。

use gilrs::{Axis, Button, Gilrs, PowerInfo};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 游戏运行期间把手柄当鼠标用（P3）。由启动器按设置打开/关闭；
/// 打开时不再向库界面发 NavIntent——手柄属于游戏，不属于后台的库。
static MOUSE_MODE: AtomicBool = AtomicBool::new(false);

/// 手柄键位映射（设置页可改）：动作 → 物理键名，默认 Xbox 布局。
/// 手柄线程每帧读一次，改键即时生效，不需要重启线程。
static PAD_MAP: std::sync::Mutex<Option<crate::models::PadMap>> = std::sync::Mutex::new(None);

pub fn set_map(m: crate::models::PadMap) {
    if let Ok(mut g) = PAD_MAP.lock() {
        *g = Some(m);
    }
}

fn current_map() -> crate::models::PadMap {
    PAD_MAP
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

/// 手柄手感（死区 / 重复率 / 鼠标速度）。与键位表一样每帧读一次：
/// 设置页改完即时生效，不需要重启手柄线程。
static PAD_TUNING: std::sync::Mutex<Option<crate::models::PadTuning>> = std::sync::Mutex::new(None);

pub fn set_tuning(t: crate::models::PadTuning) {
    if let Ok(mut g) = PAD_TUNING.lock() {
        *g = Some(t);
    }
}

fn current_tuning() -> crate::models::PadTuning {
    PAD_TUNING.lock().ok().and_then(|g| *g).unwrap_or_default()
}

/// 物理键名 → gilrs 按键。方向键与摇杆是固定导航输入，不参与改键；
/// `lt` / `rt` 是 XInput 的两个扳机（LeftTrigger2 / RightTrigger2），
/// 掌机的背键常被驱动映射成这两颗，因此一并开放给改键。
fn named_button(name: &str) -> Option<Button> {
    Some(match name {
        "south" => Button::South,
        "east" => Button::East,
        "west" => Button::West,
        "north" => Button::North,
        "start" => Button::Start,
        "select" => Button::Select,
        "mode" => Button::Mode,
        "lb" => Button::LeftTrigger,
        "rb" => Button::RightTrigger,
        "lt" => Button::LeftTrigger2,
        "rt" => Button::RightTrigger2,
        _ => return None,
    })
}

/// 某个物理键是否按住。LB / RB 在个别后端会落在 `*2` 上（与旧的肩键检测一致），两个都认。
fn pressed_named(pad: &gilrs::Gamepad, name: &str) -> bool {
    let down = |b: Button| pad.button_data(b).is_some_and(|d| d.is_pressed());
    match name {
        "lb" => down(Button::LeftTrigger) || down(Button::LeftTrigger2),
        "rb" => down(Button::RightTrigger) || down(Button::RightTrigger2),
        other => named_button(other).is_some_and(down),
    }
}

pub fn set_mouse_mode(on: bool) {
    MOUSE_MODE.store(on, Ordering::Relaxed);
}

/// 退出信号：让手柄线程自己收尾（gilrs 的 Drop 会在句柄仍被轮询时卡住，
/// 进程退出前主动停掉，比直接结束进程干净）。
static STOP: AtomicBool = AtomicBool::new(false);

pub fn stop() {
    STOP.store(true, Ordering::Relaxed);
    // 退出瞬间虚拟左右键可能还按着。不能只等线程醒来收尾：RunEvent::Exit 之后
    // 进程马上结束，线程来不及跑下一轮，系统就会一直认为左键按着。
    // 无条件补 UP（本来没按过也是空操作）。
    mouse::release_all();
}

/// 手柄连接状态：`pad://status` 事件可能在页面就绪前就发出去了（丢了就收不到），
/// 前端启动时用 `pad_status` 命令补查一次，底栏才能立刻显示手柄键位。
static PAD_CONNECTED: AtomicBool = AtomicBool::new(false);
static PAD_NAME: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static PAD_KIND: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static PAD_POWER: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static PAD_FF: AtomicBool = AtomicBool::new(false);

/// 给键位页「手柄信息」用的快照：名称 / 布局 / 电量 / 力反馈。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PadStatus {
    pub connected: bool,
    pub name: String,
    pub kind: String,
    pub power: String,
    pub ff: bool,
}

pub fn pad_status() -> PadStatus {
    PadStatus {
        connected: PAD_CONNECTED.load(Ordering::Relaxed),
        name: PAD_NAME.lock().map(|s| s.clone()).unwrap_or_default(),
        kind: PAD_KIND.lock().map(|s| s.clone()).unwrap_or_default(),
        power: PAD_POWER.lock().map(|s| s.clone()).unwrap_or_default(),
        ff: PAD_FF.load(Ordering::Relaxed),
    }
}

/// 名称 → 布局。Windows 上 DualSense 也常显示为 "Wireless Controller"。
fn pad_kind(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if [
        "dualsense",
        "dualshock",
        "playstation",
        "wireless controller",
    ]
    .iter()
    .any(|k| n.contains(k))
        || n == "ps4"
        || n == "ps5"
    {
        "playstation"
    } else if ["switch", "joy-con", "joycon", "pro controller", "nintendo"]
        .iter()
        .any(|k| n.contains(k))
    {
        "nintendo"
    } else {
        "xbox"
    }
}

/// gilrs 电量 → 前端可直接显示的一小段文本（未知就显示未知，不编造）。
/// `PowerInfo::Charging/Discharging` 是 0–100 的整数百分比，不再乘 100。
fn pad_power(pad: &gilrs::Gamepad) -> String {
    match pad.power_info() {
        PowerInfo::Wired => "wired".into(),
        PowerInfo::Charging(v) => format!("charging:{v}"),
        PowerInfo::Discharging(v) => format!("discharging:{v}"),
        PowerInfo::Charged => "charged".into(),
        PowerInfo::Unknown => "unknown".into(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "intent", rename_all = "camelCase")]
pub enum NavIntent {
    Move {
        dir: Dir,
    },
    Accept,
    Back,
    Menu,
    /// X / West：各屏语义键（库屏停止游戏或批量、网格批量）
    ActionX,
    /// Y / North：各屏语义键（库屏详情、详情结局清单）
    ActionY,
    /// LB / 左肩：网格屏右上角分类 chips 左移（库 / 详情 / 设置不响应）
    ActionL,
    /// RB / 右肩：详情屏 = 收藏（KeyR）；网格屏 = 分类 chips 右移；其余屏不响应
    ActionR,
}

/// 首按立即；260ms 起速；之后按设置里的重复率重复（默认 60ms，推满 ×3/4）。
const REPEAT_DELAY: Duration = Duration::from_millis(260);
/// 摇杆 → 鼠标的响应曲线：死区外二次方加速，中心慢、边缘快（速度由设置里的 mouseSpeed 决定）
const MOUSE_DEAD: f32 = 0.18;
/// 长按 Start+Select 回书架：纯手柄用户唯一的「退出游戏 / 叫回窗口」手势。
const CHORD_HOLD: Duration = Duration::from_millis(1200);

/// 纯函数，便于单测：0 附近不动，满推给满速，中间按二次方过渡。
pub fn stick_curve(v: f32) -> f32 {
    let a = v.abs();
    if a <= MOUSE_DEAD {
        return 0.0;
    }
    let t = ((a - MOUSE_DEAD) / (1.0 - MOUSE_DEAD)).min(1.0);
    v.signum() * t * t
}

struct MoveRepeater {
    held: Option<Dir>,
    since: Instant,
    last: Instant,
    fast: bool,
}

impl MoveRepeater {
    fn new() -> Self {
        Self {
            held: None,
            since: Instant::now(),
            last: Instant::now(),
            fast: false,
        }
    }

    /// 输入当前按住的方向（None = 无）。`repeat` 是设置里的重复间隔；
    /// 摇杆推满时用 3/4 间隔加速（默认 60ms → 45ms），不低于 30ms。
    fn update(&mut self, pressed: Option<Dir>, stick_mag: f32, repeat: Duration) -> Option<Dir> {
        match (self.held, pressed) {
            (None, Some(d)) => {
                // 新按下：立即发射并计时
                self.held = Some(d);
                self.since = Instant::now();
                self.last = Instant::now();
                self.fast = stick_mag > 0.85;
                Some(d)
            }
            (Some(prev), Some(d)) if d != prev => {
                // 按住期间换向（D-Pad 反向 / 摇杆反向超过阈值）：立刻改向并重新计时。
                // 旧实现把第二个参数丢掉，方向会锁在旧值，直到全部松开才「解锁」，
                // 体感就是「按住右再按左，没反应」
                self.held = Some(d);
                self.since = Instant::now();
                self.last = Instant::now();
                self.fast = stick_mag > 0.85;
                Some(d)
            }
            (Some(prev), Some(_)) => {
                // 持续按住：锁存方向，到点重复
                let fast = Duration::from_millis((repeat.as_millis() as u64 * 3 / 4).max(30));
                let interval = if stick_mag > 0.85 || self.fast {
                    fast
                } else {
                    repeat
                };
                if self.since.elapsed() >= REPEAT_DELAY && self.last.elapsed() >= interval {
                    self.last = Instant::now();
                    self.fast = stick_mag > 0.85;
                    Some(prev)
                } else {
                    None
                }
            }
            (Some(_), None) => {
                self.held = None;
                None
            }
            (None, None) => None,
        }
    }
}

/// 摇杆迟滞状态机：进入 >0.28 激活，回到 <0.16 释放；激活期间锁存主轴方向。
struct StickGate {
    active: bool,
    dir: Dir,
}

impl StickGate {
    fn new() -> Self {
        Self {
            active: false,
            dir: Dir::Right,
        }
    }

    /// `deadzone` / `hysteresis` 来自设置：进入阈值与释放阈值分开，避免边缘抖动。
    fn update(&mut self, x: f32, y: f32, deadzone: f32, hysteresis: f32) -> Option<Dir> {
        let mag = x.abs().max(y.abs());
        if !self.active {
            if mag >= deadzone {
                self.active = true;
                self.dir = if x.abs() > y.abs() {
                    if x < 0.0 {
                        Dir::Left
                    } else {
                        Dir::Right
                    }
                } else if y < 0.0 {
                    Dir::Up
                } else {
                    Dir::Down
                };
                Some(self.dir)
            } else {
                None
            }
        } else if mag <= hysteresis {
            self.active = false;
            None
        } else {
            // 激活期间允许「滚到另一个方向」：只有另一个轴明显压过当前轴（差值超过迟滞）
            // 才换向，斜推时不会左右抖。旧实现把初始方向一路锁到松开为止——
            // 玩家把摇杆从右直接滚到下，界面毫无反应，必须回中一次才认
            let (ax, ay) = (x.abs(), y.abs());
            if (ax - ay).abs() > hysteresis {
                let next = if ax > ay {
                    if x < 0.0 {
                        Dir::Left
                    } else {
                        Dir::Right
                    }
                } else if y < 0.0 {
                    Dir::Up
                } else {
                    Dir::Down
                };
                if next != self.dir {
                    self.dir = next;
                    return Some(next);
                }
            }
            Some(self.dir)
        }
    }
}

/* ============ P3：手柄 → 鼠标（游戏运行时） ============ */

#[cfg(windows)]
mod mouse {
    use gilrs::{Axis, Gamepad};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
        MOUSEINPUT,
    };

    /// 一格滚轮 = 120（WHEEL_DELTA，windows-sys 未导出该常量）
    const WHEEL_DELTA: i32 = 120;

    /// 最近一次 SendInput 是否被系统拒绝（UIPI）。主循环取走后提示前端一次。
    pub static REJECTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    pub fn take_rejected() -> bool {
        REJECTED.swap(false, std::sync::atomic::Ordering::Relaxed)
    }

    /// 滚轮连发间隔：太快会淹没游戏自己的滚动逻辑
    const WHEEL_REPEAT: Duration = Duration::from_millis(70);

    pub struct State {
        a: bool,
        b: bool,
        next_wheel: Instant,
    }

    impl State {
        pub fn new() -> Self {
            Self {
                a: false,
                b: false,
                next_wheel: Instant::now(),
            }
        }
    }

    fn send(flags: u32, dx: i32, dy: i32, data: i32) {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe {
            // UIPI：目标游戏以管理员权限运行时注入会被静默丢弃，提示一次即可
            let n = SendInput(1, &input, std::mem::size_of::<INPUT>() as i32);
            if n != 1 {
                REJECTED.store(true, std::sync::atomic::Ordering::Relaxed);
                static WARNED: std::sync::atomic::AtomicBool =
                    std::sync::atomic::AtomicBool::new(false);
                if !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    tracing::warn!(
                        "input: SendInput 被系统拒绝（多为游戏以管理员权限运行），手柄映射鼠标将无效"
                    );
                }
            }
        }
    }

    /// 左摇杆移光标、确认/返回当左右键、右摇杆与 LB/RB 滚轮。按键走边沿，避免连发。
    /// 确认 / 返回跟随自定义键位（设置页改键后，游戏里的鼠标左右键也跟着换）。
    /// `speed` 来自设置页的「鼠标速度」，改完下一帧就生效。
    pub fn inject(pad: &Gamepad, st: &mut State, map: &crate::models::PadMap, speed: f32) {
        let lx = pad.axis_data(Axis::LeftStickX).map_or(0.0, |d| d.value());
        let ly = pad.axis_data(Axis::LeftStickY).map_or(0.0, |d| d.value());
        let dx = (super::stick_curve(lx) * speed).round() as i32;
        let dy = (-super::stick_curve(ly) * speed).round() as i32;
        if dx != 0 || dy != 0 {
            send(MOUSEEVENTF_MOVE, dx, dy, 0);
        }

        let a = super::pressed_named(pad, &map.accept);
        if a != st.a {
            send(
                if a {
                    MOUSEEVENTF_LEFTDOWN
                } else {
                    MOUSEEVENTF_LEFTUP
                },
                0,
                0,
                0,
            );
            st.a = a;
        }
        let b = super::pressed_named(pad, &map.back);
        if b != st.b {
            send(
                if b {
                    MOUSEEVENTF_RIGHTDOWN
                } else {
                    MOUSEEVENTF_RIGHTUP
                },
                0,
                0,
                0,
            );
            st.b = b;
        }

        let ry = pad.axis_data(Axis::RightStickY).map_or(0.0, |d| d.value());
        // 肩键在 XInput 后端是 Button::LeftTrigger / RightTrigger（旧的 *2 是扳机轴，
        // 永远读不到按下），走 pressed_named 才能真的滚轮。
        // 但 pressed_named 把 lb/lt、rb/rt 当成同一组：菜单若映射到 lt（背键常见），
        // 按一下会同时触发菜单与滚轮——肩键被菜单占用时就别再当滚轮
        let shoulder_taken = |k: &str| matches!(k, "lb" | "lt" | "rb" | "rt");
        let wheel = !shoulder_taken(&map.menu);
        let lb = wheel && super::pressed_named(pad, "lb");
        let rb = wheel && super::pressed_named(pad, "rb");
        let now = Instant::now();
        if (lb || rb || ry.abs() > 0.35) && now >= st.next_wheel {
            let notches = if lb {
                1
            } else if rb {
                -1
            } else if ry > 0.0 {
                1
            } else {
                -1
            };
            send(MOUSEEVENTF_WHEEL, 0, 0, notches * WHEEL_DELTA);
            st.next_wheel = now + WHEEL_REPEAT;
        }
    }

    /// 进入鼠标模式时按当前物理状态预置 a/b（不发事件）：
    /// 否则「按确认启动游戏、手还没松开」会被当成一次新的左键点击灌进游戏
    pub fn prime(pad: &Gamepad, st: &mut State, map: &crate::models::PadMap) {
        st.a = super::pressed_named(pad, &map.accept);
        st.b = super::pressed_named(pad, &map.back);
        st.next_wheel = Instant::now();
        // 每个游戏会话最多提示一次「模拟输入被拒」
        REJECTED.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    /// 离开鼠标模式（游戏退出 / 手柄断开）时补发 UP：
    /// 否则按住 A/B 退出游戏后，系统会一直认为左/右键按着，移动鼠标变成拖拽
    pub fn release(st: &mut State) {
        if st.a {
            send(MOUSEEVENTF_LEFTUP, 0, 0, 0);
            st.a = false;
        }
        if st.b {
            send(MOUSEEVENTF_RIGHTUP, 0, 0, 0);
            st.b = false;
        }
    }

    /// 进程退出前的无条件兜底：不看本地状态，直接补 UP。重复补发无害。
    pub fn release_all() {
        send(MOUSEEVENTF_LEFTUP, 0, 0, 0);
        send(MOUSEEVENTF_RIGHTUP, 0, 0, 0);
    }
}

#[cfg(not(windows))]
mod mouse {
    use gilrs::Gamepad;

    pub struct State;

    impl State {
        pub fn new() -> Self {
            Self
        }
    }

    pub fn inject(_pad: &Gamepad, _st: &mut State, _map: &crate::models::PadMap, _speed: f32) {}

    pub fn prime(_pad: &Gamepad, _st: &mut State, _map: &crate::models::PadMap) {}

    pub fn take_rejected() -> bool {
        false
    }

    pub fn release(_st: &mut State) {}

    pub fn release_all() {}
}

/// 长按 Start+Select：结束前台游戏、把主窗口叫回前台，再通知前端回书架。
/// 游戏运行时会独占屏幕且主窗口可能被最小化，纯手柄用户没有别的出口。
fn pad_home(app: &AppHandle) {
    if let Some(id) = crate::launcher::running_id() {
        if let Err(e) = crate::launcher::stop(&id) {
            tracing::warn!("手柄回书架：结束游戏失败：{}", e.message);
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let _ = app.emit("pad://home", ());
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut gilrs = match Gilrs::new() {
            Ok(g) => g,
            Err(e) => {
                tracing::warn!("gilrs init failed: {e}（无手柄支持，仅键盘）");
                return;
            }
        };
        tracing::info!("gilrs ready");
        let mut repeat = MoveRepeater::new();
        let mut stick = StickGate::new();
        let mut btn_prev = [false; 7]; // accept / back / menu / X / Y / RB / LB
                                       // 物理键上一帧状态：设置页「改键捕获」靠 pad://button 原始事件，
                                       // 不依赖当前映射，否则改键时按下的键会先触发语义动作。
                                       // 顺序与 raw_names 一致：south/east/west/north/start/select/mode/lb/rb/lt/rt
        let mut raw_prev = [false; 11];
        let mut mouse_state = mouse::State::new();
        let mut last_pad: Option<gilrs::GamepadId> = None;
        // 上一帧是否处于鼠标模式：进出切换要预置按键表，避免「仍按住的键」被当成新按下
        let mut mouse_mode_prev = false;
        // Start+Select 长按计时：进入鼠标模式也要检测，否则游戏中退不出去
        let mut chord_since: Option<Instant> = None;
        let mut chord_fired = false;
        // 电量变化很慢，30 秒采一次就够，避免每帧读驱动
        let mut power_at = Instant::now();

        loop {
            if STOP.load(Ordering::Relaxed) {
                tracing::info!("gilrs thread stopped");
                break;
            }
            // 吞掉事件（连接/断开等），状态统一用轮询读；按键事件只记 debug，
            // 排查「某个键没反应」时把日志级别调到 debug 即可看到 ButtonPressed/Released
            while let Some(ev) = gilrs.next_event() {
                if matches!(
                    ev.event,
                    gilrs::EventType::ButtonPressed(..) | gilrs::EventType::ButtonReleased(..)
                ) {
                    tracing::debug!("手柄按键事件：{:?}", ev.event);
                }
            }

            let pad_id = gilrs
                .gamepads()
                .find(|(_, g)| g.is_connected())
                .map(|(id, _)| id);

            // 连接 / 断开只报一次，方便用户与日志确认手柄是否被识别
            if pad_id != last_pad {
                let name = pad_id
                    .map(|id| gilrs.gamepad(id).name().to_string())
                    .unwrap_or_default();
                if pad_id.is_some() {
                    tracing::info!("手柄已连接：{name}");
                } else {
                    tracing::info!("手柄已断开，回退键盘");
                    // 断线后不能把「已经长按过」的状态带回来
                    chord_since = None;
                    chord_fired = false;
                }
                PAD_CONNECTED.store(pad_id.is_some(), Ordering::Relaxed);
                if let Ok(mut n) = PAD_NAME.lock() {
                    n.clone_from(&name);
                }
                let (kind, power, ff) = pad_id
                    .map(|id| {
                        let g = gilrs.gamepad(id);
                        (
                            pad_kind(g.name()).to_string(),
                            pad_power(&g),
                            g.is_ff_supported(),
                        )
                    })
                    .unwrap_or_else(|| (String::new(), String::new(), false));
                if let Ok(mut k) = PAD_KIND.lock() {
                    k.clone_from(&kind);
                }
                if let Ok(mut p) = PAD_POWER.lock() {
                    p.clone_from(&power);
                }
                PAD_FF.store(ff, Ordering::Relaxed);
                let _ = app.emit("pad://status", serde_json::json!(pad_status()));
                last_pad = pad_id;
            }

            if let Some(id) = pad_id {
                let pad = gilrs.gamepad(id);
                // Start+Select 长按：必须在鼠标模式分支之前判定，游戏抢走手柄时也能退出
                let chord = pad
                    .button_data(Button::Start)
                    .is_some_and(|d| d.is_pressed())
                    && pad
                        .button_data(Button::Select)
                        .is_some_and(|d| d.is_pressed());
                if chord {
                    if chord_since.is_none() {
                        chord_since = Some(Instant::now());
                    }
                    if !chord_fired && chord_since.is_some_and(|t| t.elapsed() >= CHORD_HOLD) {
                        chord_fired = true;
                        pad_home(&app);
                    }
                } else {
                    chord_since = None;
                    chord_fired = false;
                }
                // 电量：变化时推一次，键位页的「手柄信息」不用轮询
                if power_at.elapsed() >= Duration::from_secs(30) {
                    power_at = Instant::now();
                    let p = pad_power(&pad);
                    let changed = PAD_POWER
                        .lock()
                        .map(|mut cur| {
                            if *cur == p {
                                false
                            } else {
                                *cur = p;
                                true
                            }
                        })
                        .unwrap_or(false);
                    if changed {
                        let _ = app.emit("pad://status", serde_json::json!(pad_status()));
                    }
                }
                // 游戏运行且用户开了「手柄映射鼠标」：这条线程改做鼠标注入，
                // 不再发 NavIntent，也不保留按键边沿（回到库界面时不会误触发）
                if MOUSE_MODE.load(Ordering::Relaxed) {
                    let map = current_map();
                    let tuning = current_tuning();
                    if !mouse_mode_prev {
                        // 刚进鼠标模式：按物理状态预置 a/b，免得「按 A 启动游戏、手还没松」
                        // 被当成一次新的左键点击灌进游戏
                        mouse::prime(&pad, &mut mouse_state, &map);
                        mouse_mode_prev = true;
                    }
                    mouse::inject(&pad, &mut mouse_state, &map, tuning.mouse_speed as f32);
                    // UIPI 拒绝注入：前端只提示一次，别让用户以为「摇杆坏了」
                    if mouse::take_rejected() {
                        let _ = app.emit("pad://mouse-blocked", ());
                    }
                    btn_prev = [false; 7];
                    raw_prev = [false; 11];
                    std::thread::sleep(Duration::from_millis(8));
                    continue;
                }
                // 刚退出鼠标模式：把之前按下的虚拟左右键补发 UP（无按住时是空操作）
                let mut prime_buttons = false;
                if mouse_mode_prev {
                    mouse::release(&mut mouse_state);
                    mouse_mode_prev = false;
                    prime_buttons = true;
                }

                // ---- 方向：D-Pad 边沿 + 摇杆迟滞，合成「当前按住方向」 ----
                let pressed_opt = |b: Button| pad.button_data(b).is_some_and(|d| d.is_pressed());
                let dpad = if pressed_opt(Button::DPadLeft) {
                    Some(Dir::Left)
                } else if pressed_opt(Button::DPadRight) {
                    Some(Dir::Right)
                } else if pressed_opt(Button::DPadUp) {
                    Some(Dir::Up)
                } else if pressed_opt(Button::DPadDown) {
                    Some(Dir::Down)
                } else {
                    None
                };

                let lx = pad.axis_data(Axis::LeftStickX).map_or(0.0, |d| d.value());
                let ly = pad.axis_data(Axis::LeftStickY).map_or(0.0, |d| d.value());
                // 手感每帧读一次：设置页改死区 / 重复率，下一帧就生效
                let tuning = current_tuning();
                let dz = tuning.deadzone as f32;
                let hyst = (dz * 0.55).clamp(0.08, 0.22);
                let stick_dir = stick.update(lx, -ly, dz, hyst); // gilrs Y 向上为正
                let stick_mag = lx.abs().max(ly.abs());

                let pressed = dpad.or(stick_dir);
                let repeat_iv = Duration::from_millis(tuning.repeat_ms as u64);
                if let Some(d) = repeat.update(pressed, stick_mag, repeat_iv) {
                    let _ = app.emit("nav://intent", NavIntent::Move { dir: d });
                }

                // ---- 按钮：边沿触发 ----
                // 键位来自设置页的映射表（默认 Xbox 布局）：确认/返回/菜单/X/Y/帮助/RB/LB。
                // 肩键不切屏：RB = 收藏 / 分类右，LB = 分类左；切屏只走快捷菜单或键盘。
                // 键位表每帧读一次：设置页改键即时生效
                let map = current_map();
                // 原始按键事件（设置页改键捕获用）：不经过映射，按什么报什么
                let raw_names = [
                    "south", "east", "west", "north", "start", "select", "mode", "lb", "rb", "lt",
                    "rt",
                ];
                for (i, name) in raw_names.iter().enumerate() {
                    let down = pressed_named(&pad, name);
                    if down && !raw_prev[i] {
                        let _ = app.emit("pad://button", serde_json::json!({ "button": name }));
                    }
                    raw_prev[i] = down;
                }
                let now = [
                    pressed_named(&pad, &map.accept),
                    pressed_named(&pad, &map.back),
                    pressed_named(&pad, &map.menu),
                    pressed_named(&pad, &map.x),
                    pressed_named(&pad, &map.y),
                    pressed_named(&pad, &map.r),
                    pressed_named(&pad, &map.lb),
                ];
                let intents = [
                    NavIntent::Accept,
                    NavIntent::Back,
                    NavIntent::Menu,
                    NavIntent::ActionX,
                    NavIntent::ActionY,
                    NavIntent::ActionR,
                    NavIntent::ActionL,
                ];
                if prime_buttons {
                    // 退出游戏瞬间仍按住的键不能算「新按下」：否则 A 会在库屏直接 Accept，
                    // 把刚退出的那部（或焦点作品）又启动一遍
                    btn_prev = now;
                }
                for i in 0..intents.len() {
                    if now[i] && !btn_prev[i] {
                        // debug 级别：排查「一次按键触发两次」时打开日志即可看到每次投递
                        tracing::debug!("手柄意图：{:?}", intents[i]);
                        let _ = app.emit("nav://intent", intents[i].clone());
                    }
                    btn_prev[i] = now[i];
                }
                std::thread::sleep(Duration::from_millis(2));
            } else {
                // 无手柄连接：先补发 UP（可能在鼠标模式中途拔线），再降频轮询等插入。
                // mouse_mode_prev 必须一起复位：否则重连后跳过 prime，玩家正按着 A 时
                // 会立刻注入一次「凭空左键」，在游戏里误点/误推进。
                mouse::release(&mut mouse_state);
                mouse_mode_prev = false;
                btn_prev = [false; 7];
                raw_prev = [false; 11];
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按住期间换向必须立刻生效（旧实现会把方向锁在旧值，直到全部松开）
    #[test]
    fn repeater_switches_direction_immediately() {
        let mut r = MoveRepeater::new();
        let ms = Duration::from_millis(60);
        assert_eq!(r.update(Some(Dir::Right), 0.0, ms), Some(Dir::Right));
        assert_eq!(r.update(Some(Dir::Left), 0.0, ms), Some(Dir::Left));
        assert_eq!(r.update(None, 0.0, ms), None);
    }

    /// 摇杆不回中直接滚到另一个方向也必须换向；斜推（两轴接近）保持当前方向不抖。
    /// 约定与调用方一致：y 为正 = 向下（gilrs 的 Y 向上为正，调用处已取反）。
    #[test]
    fn stick_switches_direction_while_tilted() {
        let mut g = StickGate::new();
        assert_eq!(
            g.update(0.9, 0.0, 0.28, 0.16),
            Some(Dir::Right),
            "推右立即导航"
        );
        assert_eq!(
            g.update(0.2, 0.9, 0.28, 0.16),
            Some(Dir::Down),
            "滚到下方必须换向"
        );
        assert_eq!(
            g.update(0.2, -0.9, 0.28, 0.16),
            Some(Dir::Up),
            "再滚到上方必须换向"
        );
        assert_eq!(g.update(0.7, -0.8, 0.28, 0.16), Some(Dir::Up), "斜推不换向");
        assert_eq!(g.update(0.05, 0.0, 0.28, 0.16), None, "回中释放");
        assert_eq!(
            g.update(0.0, 0.9, 0.28, 0.16),
            Some(Dir::Down),
            "重新推下立即触发"
        );
    }

    /// 死区来自设置：0.38 时 0.30 不该触发，0.18 时同一输入应触发
    #[test]
    fn stick_gate_respects_custom_deadzone() {
        let mut wide = StickGate::new();
        assert_eq!(wide.update(0.30, 0.0, 0.38, 0.21), None);
        let mut narrow = StickGate::new();
        assert_eq!(narrow.update(0.30, 0.0, 0.18, 0.10), Some(Dir::Right));
    }

    /// 重复率来自设置：120ms 的重复次数必须明显少于 30ms
    #[test]
    fn repeater_uses_tuning_interval() {
        fn repeats_after(mut r: MoveRepeater, interval: Duration) -> usize {
            let _ = r.update(Some(Dir::Right), 0.0, interval);
            // 手动把起速点提前到「已过 260ms」，只比较重复间隔本身
            r.since = Instant::now() - Duration::from_millis(300);
            let mut n = 0;
            let until = Instant::now() + Duration::from_millis(260);
            while Instant::now() < until {
                if r.update(Some(Dir::Right), 0.0, interval).is_some() {
                    n += 1;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            n
        }
        let slow = repeats_after(MoveRepeater::new(), Duration::from_millis(120));
        let fast = repeats_after(MoveRepeater::new(), Duration::from_millis(30));
        assert!(fast > slow, "30ms 重复应比 120ms 更频繁：{fast} vs {slow}");
    }

    #[test]
    fn tuning_defaults_match_documented_values() {
        let t = crate::models::PadTuning::default();
        assert!((t.deadzone - 0.28).abs() < f64::EPSILON);
        assert_eq!(t.repeat_ms, 60);
        assert!((t.mouse_speed - 11.0).abs() < f64::EPSILON);
    }
}

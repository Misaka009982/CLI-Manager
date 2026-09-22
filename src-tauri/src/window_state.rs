// CLI-Manager 主窗口状态记忆（fork 独立模块）。
//
// 上游不提供“下次启动恢复上次窗口大小和位置”的能力，也没有引入官方
// tauri-plugin-window-state。为便于后续同步上游，本能力做成一个自包含模块：
//   - 只依赖 crate 已有的 serde/serde_json/tauri，Cargo.toml 不新增依赖；
//   - 状态与“是否启用”都存在 fork 独立文件 window-state.json，不碰上游的
//     settingsStore / i18n / 设置页；
//   - 对 lib.rs 的侵入仅两行：顶部 `mod window_state;` 与 setup 里的一次
//     `window_state::install(...)` 调用。
//
// 记忆范围：窗口大小、屏幕位置、是否最大化。全屏是临时态，另有独立切换逻辑，
// 不在此持久化。

use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, WindowEvent,
};

// 主窗口 label（tauri.conf.json app.windows 里未显式指定，Tauri 默认即 "main"）。
const MAIN_WINDOW_LABEL: &str = "main";
const STATE_FILE_NAME: &str = "window-state.json";

// 与 tauri.conf.json 的 minWidth/minHeight 对齐，避免恢复出无法操作的窗口。
const MIN_WIDTH: u32 = 350;
const MIN_HEIGHT: u32 = 600;
// 上限用于挡住异常/损坏的巨大值（远大于任何常见多屏总分辨率）。
const MAX_DIMENSION: u32 = 30_000;

// 恢复位置时要求窗口与某显示器至少有这么大的可见交叠，保证有一块能抓取、
// 能看见的区域，防止窗口落到已拔掉的显示器或完全离屏。
const MIN_VISIBLE_PX: i64 = 64;

// 窗口移动/缩放会高频触发事件，静默这么久之后才写盘，避免频繁写文件。
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MainWindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for MainWindowState {
    fn default() -> Self {
        // 与 tauri.conf.json 主窗口初始尺寸一致；位置 0,0 仅作最大化态兜底，
        // 首次运行不会走恢复分支。
        Self {
            width: 1200,
            height: 800,
            x: 0,
            y: 0,
            maximized: false,
        }
    }
}

// 纯几何矩形，供边界可见性判断的纯函数使用（便于单测，不触碰 Tauri 运行时）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn state_file_path() -> Option<PathBuf> {
    crate::app_paths::cli_manager_data_dir()
        .ok()
        .map(|dir| dir.join(STATE_FILE_NAME))
}

fn load_state() -> Option<MainWindowState> {
    let path = state_file_path()?;
    let contents = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn save_state(state: &MainWindowState) {
    let Some(path) = state_file_path() else {
        return;
    };
    let Ok(serialized) = serde_json::to_string_pretty(state) else {
        return;
    };
    // 原子写：先写临时文件再 rename，避免进程被杀时留下半截 JSON。
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, serialized.as_bytes()).is_err() {
        return;
    }
    if fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

// 一维交叠长度：两个区间 [a0,a1) 与 [b0,b1) 的重叠像素数（可能为负，表示不相交）。
fn overlap_len(a0: i32, a1: i32, b0: i32, b1: i32) -> i64 {
    let lo = a0.max(b0) as i64;
    let hi = (a1.min(b1)) as i64;
    hi - lo
}

// 窗口矩形是否与任一显示器有足够大的可见交叠。
fn rect_visible_on_monitors(win: Rect, monitors: &[Rect]) -> bool {
    if win.width <= 0 || win.height <= 0 {
        return false;
    }
    monitors.iter().any(|monitor| {
        let horizontal = overlap_len(
            win.x,
            win.x.saturating_add(win.width),
            monitor.x,
            monitor.x.saturating_add(monitor.width),
        );
        let vertical = overlap_len(
            win.y,
            win.y.saturating_add(win.height),
            monitor.y,
            monitor.y.saturating_add(monitor.height),
        );
        horizontal >= MIN_VISIBLE_PX && vertical >= MIN_VISIBLE_PX
    })
}

fn sanitize_dimension(value: u32, min: u32) -> u32 {
    value.clamp(min, MAX_DIMENSION)
}

// 读取当前窗口几何。最大化时不覆盖普通态尺寸/位置（否则取消最大化会得到
// 一个全屏大小的普通窗口），只在已存档基础上把 maximized 标记为 true。
fn capture<R: Runtime>(window: &WebviewWindow<R>) -> Option<MainWindowState> {
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        let mut previous = load_state().unwrap_or_default();
        previous.maximized = true;
        return Some(previous);
    }
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    Some(MainWindowState {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized: false,
    })
}

fn monitor_rects<R: Runtime>(window: &WebviewWindow<R>) -> Vec<Rect> {
    let Ok(monitors) = window.available_monitors() else {
        return Vec::new();
    };
    monitors
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            Rect {
                x: position.x,
                y: position.y,
                width: size.width as i32,
                height: size.height as i32,
            }
        })
        .collect()
}

fn restore<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(state) = load_state() else {
        return;
    };

    let width = sanitize_dimension(state.width, MIN_WIDTH);
    let height = sanitize_dimension(state.height, MIN_HEIGHT);
    let _ = window.set_size(PhysicalSize::new(width, height));

    // 位置只在能落到某个当前显示器的可见区域时才恢复，否则保留 Tauri 的居中，
    // 避免窗口恢复到已断开的显示器或屏幕外。
    let win_rect = Rect {
        x: state.x,
        y: state.y,
        width: width as i32,
        height: height as i32,
    };
    let monitors = monitor_rects(window);
    if monitors.is_empty() || rect_visible_on_monitors(win_rect, &monitors) {
        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    }

    if state.maximized {
        let _ = window.maximize();
    }
}

// 后台去抖线程：收到窗口变更信号后，等待一段静默期再落盘当前几何。
fn run_saver<R: Runtime>(app: AppHandle<R>, rx: mpsc::Receiver<()>) {
    loop {
        // 阻塞等待第一个变更信号；发送端全部释放则退出。
        if rx.recv().is_err() {
            return;
        }
        // 持续吸收后续信号，直到静默 SAVE_DEBOUNCE。
        loop {
            match rx.recv_timeout(SAVE_DEBOUNCE) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            if let Some(state) = capture(&window) {
                save_state(&state);
            }
        }
    }
}

/// 安装主窗口状态记忆：先按上次记录恢复几何，再监听移动/缩放/最大化并去抖落盘。
/// 在 setup 中调用一次即可；主窗口不存在时安全地什么都不做。
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    restore(&window);

    let (tx, rx): (Sender<()>, mpsc::Receiver<()>) = mpsc::channel();
    let saver_app = app.clone();
    thread::Builder::new()
        .name("cli-manager-window-state".into())
        .spawn(move || run_saver(saver_app, rx))
        .ok();

    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let _ = tx.send(());
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trips_through_json() {
        let state = MainWindowState {
            width: 1440,
            height: 900,
            x: -120,
            y: 48,
            maximized: true,
        };
        let json = serde_json::to_string(&state).unwrap();
        let parsed: MainWindowState = serde_json::from_str(&json).unwrap();
        assert_eq!(state, parsed);
    }

    #[test]
    fn missing_maximized_field_defaults_to_false() {
        let parsed: MainWindowState =
            serde_json::from_str(r#"{"width":1200,"height":800,"x":10,"y":20}"#).unwrap();
        assert!(!parsed.maximized);
        assert_eq!(parsed.width, 1200);
        assert_eq!(parsed.x, 10);
    }

    #[test]
    fn window_fully_inside_a_monitor_is_visible() {
        let monitors = [Rect { x: 0, y: 0, width: 1920, height: 1080 }];
        let win = Rect { x: 100, y: 100, width: 1200, height: 800 };
        assert!(rect_visible_on_monitors(win, &monitors));
    }

    #[test]
    fn window_off_screen_is_not_visible() {
        let monitors = [Rect { x: 0, y: 0, width: 1920, height: 1080 }];
        // 完全落在右侧屏幕之外。
        let win = Rect { x: 5000, y: 100, width: 1200, height: 800 };
        assert!(!rect_visible_on_monitors(win, &monitors));
    }

    #[test]
    fn window_barely_peeking_is_not_visible() {
        let monitors = [Rect { x: 0, y: 0, width: 1920, height: 1080 }];
        // 只剩 32px 露在屏内，低于可抓取阈值。
        let win = Rect { x: 1920 - 32, y: 100, width: 1200, height: 800 };
        assert!(!rect_visible_on_monitors(win, &monitors));
    }

    #[test]
    fn window_on_secondary_monitor_is_visible() {
        // 第二显示器接在主屏右侧（含负坐标主屏场景亦可）。
        let monitors = [
            Rect { x: 0, y: 0, width: 1920, height: 1080 },
            Rect { x: 1920, y: 0, width: 2560, height: 1440 },
        ];
        let win = Rect { x: 2200, y: 200, width: 1200, height: 800 };
        assert!(rect_visible_on_monitors(win, &monitors));
    }

    #[test]
    fn no_monitor_means_not_visible() {
        let win = Rect { x: 0, y: 0, width: 1200, height: 800 };
        assert!(!rect_visible_on_monitors(win, &[]));
    }

    #[test]
    fn dimensions_are_clamped_to_supported_range() {
        assert_eq!(sanitize_dimension(0, MIN_WIDTH), MIN_WIDTH);
        assert_eq!(sanitize_dimension(100, MIN_WIDTH), MIN_WIDTH);
        assert_eq!(sanitize_dimension(1200, MIN_WIDTH), 1200);
        assert_eq!(sanitize_dimension(99_999, MIN_WIDTH), MAX_DIMENSION);
        assert_eq!(sanitize_dimension(10, MIN_HEIGHT), MIN_HEIGHT);
    }
}

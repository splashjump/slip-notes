//! 画布窗口管理器（spike 版）
//!
//! 五项验证对应的实现位置：
//! 1. 透明        -> create_canvas（WebviewWindowBuilder transparent/decorations/shadow）
//! 2. 置底        -> push_all_bottom + WS_EX_NOACTIVATE（watchdog 定时回压）
//! 3. 区域穿透    -> apply_region（SetWindowRgn，区域 = 便签矩形并集）
//! 4. 多显示器    -> enumerate_monitors + rebuild_if_needed（每显示器一个画布窗口）
//! 5. 全屏检测    -> SetWinEventHook(EVENT_SYSTEM_FOREGROUND) + is_fullscreen_on
//!
//! 注：windows crate 0.61 里 tauri 的 hwnd() 返回同一个 crate 的 HWND 类型，直接使用。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, EnumDisplayMonitors, GetMonitorInfoW, HDC,
    HGDIOBJ, HMONITOR, HRGN, MONITORINFOEXW, SetWindowRgn, RGN_OR,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowLongPtrW,
    GetWindowRect, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage,
    EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GWL_STYLE,
    HWND_BOTTOM, MSG, SET_WINDOW_POS_FLAGS, SW_HIDE, SW_SHOWNOACTIVATE,
    SWP_NOACTIVATE, SWP_NOZORDER, SWP_NOMOVE, SWP_NOSIZE, WINEVENT_OUTOFCONTEXT,
    WS_CAPTION, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 便签（spike 假数据，坐标 = 物理像素 / 虚拟屏坐标系）
#[derive(Clone, Serialize, Debug)]
pub struct Note {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub color: String,
    pub kind: String, // "text" | "checklist"
    pub text: String,
    #[serde(default)]
    pub items: Vec<CheckItem>,
}

#[derive(Clone, Serialize, Debug)]
pub struct CheckItem {
    pub text: String,
    pub done: bool,
}

/// 显示器信息（物理像素，虚拟屏坐标）
#[derive(Clone, Debug)]
pub(crate) struct MonitorSlot {
    rect: RECT,
    dpi: u32,
}

/// 管理器内部状态（Arc<Mutex<Inner>> 挂在 app state 上）
pub struct Inner {
    pub monitors: Vec<MonitorSlot>,
    pub virtual_rect: RECT,
    pub notes: Vec<Note>,
    pub editing: Option<String>,          // 正在编辑的画布窗口 label
    pub editing_since: Option<std::time::Instant>, // 编辑开始时间（失焦判定宽容期用）
    pub fullscreen_hidden: Vec<String>,   // 因全屏而隐藏的画布 label
    /// 每画布窗口当前 DPR（由前端 canvas-init 上报）
    pub canvas_dpr: HashMap<String, f64>,
    /// app.listen 的 EventId：必须持有否则监听器立即注销（Tauri v2 语义）
    pub event_ids: Vec<tauri::EventId>,
}

/// WinEvent 回调里用的 AppHandle
static HOOK_APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

const WATCHDOG_INTERVAL: Duration = Duration::from_millis(800);
const HOOK_EVENT_FG: u32 = EVENT_SYSTEM_FOREGROUND;
const HOOK_EVENT_LOC: u32 = EVENT_OBJECT_LOCATIONCHANGE;

// ---------------------------------------------------------------------------
// 窗口创建 / 销毁
// ---------------------------------------------------------------------------

pub fn canvas_label(i: usize) -> String {
    format!("canvas-{i}")
}

fn create_canvas_window(app: &AppHandle, label: &str, rect: &RECT) -> tauri::Result<()> {
    let w = (rect.right - rect.left) as f64;
    let h = (rect.bottom - rect.top) as f64;
    // 注意：WebviewWindowBuilder 的 position/inner_size 的 f64 版本按 **logical** 像素解释，
    // 而 rect 是物理像素。100% DPI 下两者相等（spike 实测机），非 100% 缩放下会错位/超屏。
    // 因此 build 后必须用物理 API 强制修正（窗口透明 + 初始空 Rgn，修正前不可见）。
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("slip-canvas")
        .position(rect.left as f64, rect.top as f64)
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_bottom(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .resizable(false)
        .focused(false)
        .on_page_load(|w, payload| {
            log::info!("[spike] 页面加载 label={} url={}", w.label(), payload.url());
        })
        .build()?;
    let _ = win.set_position(tauri::PhysicalPosition::new(rect.left, rect.top));
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    apply_desk_style(&win);
    // 立即设空区域：页面加载完成前窗口不拦截任何鼠标事件
    apply_region(&win, &[], 1.0);
    Ok(())
}

/// WS_EX_TOOLWINDOW —— 无任务栏图标。
/// 注意：不加 WS_EX_NOACTIVATE！WebView2 在 NOACTIVATE 窗口上不处理鼠标输入，
/// 卡片点击/拖动全靠鼠标事件，因此允许点击卡片时正常激活（= 编辑模式），
/// 失焦后由 WinEvent 检测并回压底部。
fn apply_desk_style(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | WS_EX_TOOLWINDOW.0 as isize,
            );
        }
    }
}

fn remove_noactivate(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_NOACTIVATE.0 as isize));
        }
    }
}

// ---------------------------------------------------------------------------
// 显示器枚举
// ---------------------------------------------------------------------------

unsafe extern "system" fn monitor_enum_proc(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rc: *mut RECT,
    lparam: LPARAM,
) -> windows_core::BOOL {
    let out = &mut *(lparam.0 as *mut Vec<MonitorSlot>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(hmonitor, &mut info.monitorInfo).as_bool() {
        let mut dpi_x = 96u32;
        let mut dpi_y = 96u32;
        let _ = GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        out.push(MonitorSlot {
            rect: info.monitorInfo.rcMonitor,
            dpi: dpi_x,
        });
    }
    windows_core::BOOL(1)
}

pub fn enumerate_monitors() -> Vec<MonitorSlot> {
    let mut v: Vec<MonitorSlot> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_enum_proc),
            LPARAM(&mut v as *mut _ as isize),
        );
    }
    v
}

fn virtual_bounds(monitors: &[MonitorSlot]) -> RECT {
    let mut r = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    for (i, m) in monitors.iter().enumerate() {
        if i == 0 {
            r = m.rect;
        } else {
            r.left = r.left.min(m.rect.left);
            r.top = r.top.min(m.rect.top);
            r.right = r.right.max(m.rect.right);
            r.bottom = r.bottom.max(m.rect.bottom);
        }
    }
    r
}

// ---------------------------------------------------------------------------
// 区域穿透：SetWindowRgn
// ---------------------------------------------------------------------------

/// rects: CSS 像素（前端 getBoundingClientRect）；dpr: 该窗口缩放比
/// 区域 = 便签矩形并集；无便签处鼠标天然穿透到桌面。
/// rects 为空 → 设一个空区域（窗口完全不拦截鼠标，用于窗口刚建/便签清空的过渡态）
pub fn apply_region(win: &tauri::WebviewWindow, rects: &[(f64, f64, f64, f64)], dpr: f64) {
    let hwnd = match win.hwnd() {
        Ok(h) => h,
        Err(_) => return,
    };
    unsafe {
        if rects.is_empty() {
            let empty = CreateRectRgn(0, 0, 0, 0);
            let _ = SetWindowRgn(hwnd, Some(empty), true);
            return;
        }
        let mut combined: HRGN = HRGN(std::ptr::null_mut());
        for (x, y, w, h) in rects {
            let (l, t, r, b) = (
                (x * dpr).round() as i32,
                (y * dpr).round() as i32,
                ((x + w) * dpr).round() as i32,
                ((y + h) * dpr).round() as i32,
            );
            let one = CreateRectRgn(l, t, r, b);
            if combined.0.is_null() {
                combined = one;
            } else {
                let _ = CombineRgn(Some(combined), Some(combined), Some(one), RGN_OR);
                let _ = DeleteObject(HGDIOBJ(one.0));
            }
        }
        // SetWindowRgn 成功后系统接管 hrgn，不要再 DeleteObject
        let _ = SetWindowRgn(hwnd, Some(combined), true);
    }
}

/// 清除区域：恢复整个窗口矩形（用于拖拽期间捕获鼠标）
pub fn clear_region(win: &tauri::WebviewWindow) {
    let hwnd = match win.hwnd() {
        Ok(h) => h,
        Err(_) => return,
    };
    unsafe {
        let _ = SetWindowRgn(hwnd, None, true);
    }
}

// ---------------------------------------------------------------------------
// 置底回压 / 拖拽期间窗口放大
// ---------------------------------------------------------------------------

fn set_pos(hwnd: HWND, insert_after: Option<HWND>, x: i32, y: i32, cx: i32, cy: i32, flags: SET_WINDOW_POS_FLAGS) {
    unsafe {
        let _ = SetWindowPos(hwnd, insert_after, x, y, cx, cy, flags);
    }
}

pub fn push_bottom(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        set_pos(
            hwnd,
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// 编辑激活：取消 tao 的 always_on_bottom（否则 z-order 会被 tao 强制压回），
/// 移除 NOACTIVATE，取得焦点。
pub fn activate_editing(win: &tauri::WebviewWindow) {
    remove_noactivate(win);
    let _ = win.set_always_on_bottom(false);
    let _ = win.set_focus();
}

/// 编辑结束：恢复 always_on_bottom + 回压底部
pub fn deactivate_editing(win: &tauri::WebviewWindow) {
    let _ = win.set_always_on_bottom(true);
    apply_desk_style(win);
    push_bottom(win);
}

/// 拖拽期间：窗口放大到虚拟屏包围盒，Rgn 清空（保证卡片拖动全程可见、鼠标被捕获）
pub fn expand_for_drag(win: &tauri::WebviewWindow, vrect: &RECT) {
    if let Ok(hwnd) = win.hwnd() {
        set_pos(
            hwnd,
            None,
            vrect.left,
            vrect.top,
            vrect.right - vrect.left,
            vrect.bottom - vrect.top,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

/// 拖拽结束：窗口缩回所属显示器
pub fn shrink_back(win: &tauri::WebviewWindow, rect: &RECT) {
    if let Ok(hwnd) = win.hwnd() {
        set_pos(
            hwnd,
            None,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

pub fn hide_win(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

pub fn show_win_noactivate(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }
}

// ---------------------------------------------------------------------------
// 全屏检测
// ---------------------------------------------------------------------------

fn window_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    unsafe {
        let n = GetClassNameW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

/// 桌面自身（Progman/WorkerW/SHELLDLL_DefView）的前台事件要排除，否则误判全屏
fn is_desktop_window(hwnd: HWND) -> bool {
    matches!(
        window_class(hwnd).as_str(),
        "Progman" | "WorkerW" | "SHELLDLL_DefView"
    )
}

/// 前台窗口是否在显示器 m 上处于全屏（窗口矩形覆盖整个 rcMonitor，含任务栏区域）
fn is_fullscreen_on(hwnd: HWND, m: &MonitorSlot) -> bool {
    if hwnd.0.is_null() || is_desktop_window(hwnd) {
        return false;
    }
    // 带标题栏（WS_CAPTION）的普通可缩放窗口不算全屏——即使矩形覆盖显示器（如最大化、
    // 拖到屏幕边缘吸附），也非"全屏应用"，避免误判隐藏画布。
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
    if style & (WS_CAPTION.0 as isize) != 0 {
        return false;
    }
    let mut wr = RECT::default();
    unsafe {
        if GetWindowRect(hwnd, &mut wr).is_ok() {
            wr.left <= m.rect.left
                && wr.top <= m.rect.top
                && wr.right >= m.rect.right
                && wr.bottom >= m.rect.bottom
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// 管理器主体
// ---------------------------------------------------------------------------

/// 默认假便签（spike 数据，物理像素 / 虚拟屏坐标）
pub fn default_notes() -> Vec<Note> {
    vec![
        Note {
            id: "n1".into(),
            x: 250.0,
            y: 180.0,
            w: 220.0,
            h: 170.0,
            color: "#fff3b0".into(),
            kind: "text".into(),
            text: "买牛奶和鸡蛋 🥛🥚".into(),
            items: vec![],
        },
        Note {
            id: "n2".into(),
            x: 620.0,
            y: 340.0,
            w: 240.0,
            h: 200.0,
            color: "#d8f3dc".into(),
            kind: "checklist".into(),
            text: "周末清单".into(),
            items: vec![
                CheckItem { text: "洗车".into(), done: false },
                CheckItem { text: "交电费".into(), done: false },
                CheckItem { text: "给花浇水".into(), done: true },
            ],
        },
        Note {
            id: "n3".into(),
            x: 1080.0,
            y: 140.0,
            w: 260.0,
            h: 180.0,
            color: "#ffd6e0".into(),
            kind: "text".into(),
            text: "灵感：让纸筏把纸条送到每台设备".into(),
            items: vec![],
        },
        Note {
            id: "n4".into(),
            x: 200.0,
            y: 150.0,
            w: 260.0,
            h: 160.0,
            color: "#caf0f8".into(),
            kind: "text".into(),
            text: "跨屏拖动测试卡：把我拖到另一个屏幕".into(),
            items: vec![],
        },
    ]
}

impl Inner {
    pub fn new(app: &AppHandle) -> Self {
        let monitors = enumerate_monitors();
        let virtual_rect = virtual_bounds(&monitors);
        let mut inner = Inner {
            monitors,
            virtual_rect,
            notes: default_notes(),
            editing: None,
            editing_since: None,
            fullscreen_hidden: Vec::new(),
            canvas_dpr: Default::default(),
            event_ids: Vec::new(),
        };
        inner.rebuild_canvases(app);
        inner
    }

    /// 每显示器一个画布窗口
    fn rebuild_canvases(&mut self, app: &AppHandle) {
        // 关掉所有旧画布窗口（不能按 monitors.len() 推断：显示器数量减少时
        // 旧索引的窗口不在新拓扑里，按 len 关会残留幽灵画布窗口）
        let old: Vec<String> = app
            .webview_windows()
            .values()
            .filter(|w| w.label().starts_with("canvas-"))
            .map(|w| w.label().to_string())
            .collect();
        for label in old {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
        }
        self.fullscreen_hidden.clear();
        self.editing = None;
        // 重建
        for (i, m) in self.monitors.iter().enumerate() {
            let label = canvas_label(i);
            if let Err(e) = create_canvas_window(app, &label, &m.rect) {
                log::warn!("创建画布窗口 {label} 失败: {e}");
            }
        }
    }

    /// 每显示器内属于它的便签（按中心点归属，物理坐标）
    fn notes_for_monitor(&self, mi: usize) -> Vec<Note> {
        let m = &self.monitors[mi];
        self.notes
            .iter()
            .filter(|n| {
                let cx = n.x + n.w / 2.0;
                let cy = n.y + n.h / 2.0;
                cx >= m.rect.left as f64
                    && cx < m.rect.right as f64
                    && cy >= m.rect.top as f64
                    && cy < m.rect.bottom as f64
            })
            .cloned()
            .collect()
    }

    fn emit_notes(&self, app: &AppHandle, labels: &[String]) {
        for (i, _) in self.monitors.iter().enumerate() {
            let label = canvas_label(i);
            if !labels.contains(&label) {
                continue;
            }
            if let Some(w) = app.get_webview_window(&label) {
                let notes = self.notes_for_monitor(i);
                let _ = w.emit("notes-for-canvas", notes);
            }
        }
    }

    fn emit_state(&self, app: &AppHandle) {
        let _ = app.emit(
            "state-updated",
            serde_json::json!({
                "monitors": self.monitors.iter().map(|m| {
                    serde_json::json!({
                        "rect": [m.rect.left, m.rect.top, m.rect.right, m.rect.bottom],
                        "dpi": m.dpi,
                    })
                }).collect::<Vec<_>>(),
                "virtualRect": [self.virtual_rect.left, self.virtual_rect.top,
                                self.virtual_rect.right, self.virtual_rect.bottom],
                "editing": self.editing,
                "fullscreenHidden": self.fullscreen_hidden,
                "notes": self.notes.iter().map(|n| serde_json::json!({
                    "id": n.id, "x": n.x, "y": n.y, "w": n.w, "h": n.h,
                })).collect::<Vec<_>>(),
            }),
        );
    }

    /// 前台窗口变化 → 全屏检测 + 编辑失焦检测（在主线程消息泵里执行）
    pub fn on_foreground_change(&mut self, app: &AppHandle, is_location_change: bool) {
        let fg = unsafe { GetForegroundWindow() };

        // 编辑失焦 + 回压只在"前台切换"事件里做；LOCATIONCHANGE（窗口移动/缩放，事件密集）
        // 不做这两件事，否则拖动其他窗口时会频繁 SetWindowPos 回压，导致便签 z-order 抖动闪烁。
        if !is_location_change {
            // 1) 编辑失焦：前台不再是编辑中的画布 → 结束编辑态
            //    注意：set_focus 是异步消息，编辑开始后短暂窗口期内前台可能仍是旧窗口，
            //    用 1.5s 宽容期等待前台切换完成，避免误杀。
            //    宽容期只跳过"编辑失焦判定"，不 return——全屏检测必须照常执行
            //    （否则编辑开始后 1.5s 内进入全屏，画布不会隐藏）。
            let in_grace = self
                .editing_since
                .map(|t| t.elapsed() < Duration::from_millis(1500))
                .unwrap_or(false);
            if let Some(editing_label) = self.editing.clone() {
                if !in_grace {
                    let still_focused = app
                        .get_webview_window(&editing_label)
                        .and_then(|w| w.hwnd().ok())
                        .map(|h| h.0 == fg.0)
                        .unwrap_or(false);
                    if !still_focused {
                        if let Some(w) = app.get_webview_window(&editing_label) {
                            deactivate_editing(&w);
                        }
                        self.editing = None;
                        self.editing_since = None;
                        if let Some(w) = app.get_webview_window(&editing_label) {
                            let _ = w.emit("edit-end", ());
                        }
                        self.emit_state(app);
                    }
                }
            }

            // 1.5) 前台已切走：所有非编辑、且非前台的画布统一回压
            //      （覆盖"误点卡片后点别处"的场景；跳过前台画布——点击卡片会激活画布，
            //       若此时压回底部，Windows 会把前台切走，连锁触发编辑失焦误杀）
            if self.editing.is_none() {
                for i in 0..self.monitors.len() {
                    let label = canvas_label(i);
                    if let Some(w) = app.get_webview_window(&label) {
                        if let Ok(h) = w.hwnd() {
                            if h.0 == fg.0 {
                                continue;
                            }
                        }
                        push_bottom(&w);
                    }
                }
            }
        }

        // 2) 全屏检测：逐显示器比较前台窗口
        //    排除画布窗口自身：拖动时画布窗口会放大到虚拟屏包围盒（单屏下即全屏尺寸），
        //    若前台是画布自身会被误判为"全屏应用"而隐藏自己。
        let fg_is_canvas = (0..self.monitors.len()).any(|i| {
            app.get_webview_window(&canvas_label(i))
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 == fg.0)
                .unwrap_or(false)
        });
        if fg_is_canvas {
            return;
        }
        for (i, m) in self.monitors.iter().enumerate() {
            let label = canvas_label(i);
            let full = is_fullscreen_on(fg, m);
            let hidden_now = self.fullscreen_hidden.contains(&label);
            if full && !hidden_now {
                if let Some(w) = app.get_webview_window(&label) {
                    hide_win(&w);
                    self.fullscreen_hidden.push(label.clone());
                }
            } else if !full && hidden_now {
                if let Some(w) = app.get_webview_window(&label) {
                    show_win_noactivate(&w);
                    push_bottom(&w);
                }
                self.fullscreen_hidden.retain(|l| l != &label);
            }
        }
        if !self.fullscreen_hidden.is_empty() || self.editing.is_some() {
            self.emit_state(app);
        }
    }

    /// watchdog 线程：拓扑检测 + 置底回压（幂等）
    pub fn watchdog_tick(&mut self, app: &AppHandle) {
        // 拓扑签名变化 → 重建
        let now = enumerate_monitors();
        let same_topology = now.len() == self.monitors.len()
            && now.iter().zip(&self.monitors).all(|(a, b)| {
                a.rect.left == b.rect.left
                    && a.rect.top == b.rect.top
                    && a.rect.right == b.rect.right
                    && a.rect.bottom == b.rect.bottom
                    && a.dpi == b.dpi
            });
        if !same_topology {
            self.monitors = now;
            self.virtual_rect = virtual_bounds(&self.monitors);
            self.rebuild_canvases(app);
            self.emit_state(app);
            return;
        }

        // 回压：非编辑中、且非前台的画布窗口压回底部
        // （窗口刚被点击激活的瞬间 editing 尚未设置，跳过避免打断点击/焦点；
        //   之后 card-focus 会将其提升，前台切换会统一回压）
        let fg = unsafe { GetForegroundWindow() };
        for i in 0..self.monitors.len() {
            let label = canvas_label(i);
            if self.editing.as_deref() == Some(label.as_str()) {
                continue;
            }
            if let Some(w) = app.get_webview_window(&label) {
                if let Ok(h) = w.hwnd() {
                    if h.0 == fg.0 {
                        continue;
                    }
                }
                push_bottom(&w);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// WinEvent hook
// ---------------------------------------------------------------------------

unsafe extern "system" fn foreground_hook(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // 只关心：前台切换 + 前台窗口的尺寸/位置变化（全屏进入/退出会触发 LOCATIONCHANGE）
    if event == HOOK_EVENT_FG {
        // FOREGROUND：正常处理
    } else if event == HOOK_EVENT_LOC && id_object == 0 {
        // OBJID_WINDOW 的位置/尺寸变化；只处理前台窗口，过滤噪音
        let fg = GetForegroundWindow();
        if hwnd != fg {
            return;
        }
    } else {
        return;
    }
    let is_location_change = event == HOOK_EVENT_LOC;
    let Some(lock) = HOOK_APP.get() else { return };
    let Ok(guard) = lock.lock() else { return };
    let Some(app) = guard.clone() else {
        return;
    };
    if let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() {
        let inner = state.inner();
        if let Ok(mut g) = inner.lock() {
            g.on_foreground_change(&app, is_location_change);
        }
    }
}

fn install_hook(app: &AppHandle) {
    let lock = HOOK_APP.get_or_init(|| Mutex::new(None));
    if let Ok(mut g) = lock.lock() {
        *g = Some(app.clone());
    }
    // out-of-context hook 的回调依赖"注册线程的消息泵"。
    // tao 主线程消息循环对线程消息分发不可靠，因此用专用线程跑独立消息泵。
    let hook_app = app.clone();
    thread::spawn(move || {
        unsafe {
            let hook_fg = SetWinEventHook(
                HOOK_EVENT_FG,
                HOOK_EVENT_FG,
                None,
                Some(foreground_hook),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            let hook_loc = SetWinEventHook(
                HOOK_EVENT_LOC,
                HOOK_EVENT_LOC,
                None,
                Some(foreground_hook),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            log::info!(
                "[spike] WinEvent hooks 已注册（专用消息泵线程） fg=0x{:x} loc=0x{:x}",
                hook_fg.0 as usize,
                hook_loc.0 as usize
            );
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWinEvent(hook_fg);
            let _ = UnhookWinEvent(hook_loc);
            log::info!("[spike] WinEvent hook 消息泵线程退出");
        }
        let _ = hook_app;
    });
}

/// 启动 watchdog 线程（拓扑 + 回压）
pub fn start_watchdog(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(WATCHDOG_INTERVAL);
        let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
            break;
        };
        let inner = state.inner();
        if let Ok(mut g) = inner.lock() {
            g.watchdog_tick(&app);
        }
    });
}

/// 初始化入口（在 tauri setup 里调用）
pub fn setup(app: &AppHandle) {
    let state = Arc::new(Mutex::new(Inner::new(app)));
    app.manage(state);
    install_hook(app);
    start_watchdog(app.clone());
    // 初始全屏检查 + 初始状态广播
    if let Some(s) = app.try_state::<Arc<Mutex<Inner>>>() {
        if let Ok(mut g) = s.inner().lock() {
            g.on_foreground_change(app, false);
            g.emit_state(app);
        }
    }
}

// ---------------------------------------------------------------------------
// IPC payloads
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CanvasInitPayload {
    pub label: String,
    pub dpr: f64,
}

#[derive(Deserialize)]
pub struct RegionRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Deserialize)]
pub struct UpdateRegionsPayload {
    pub label: String,
    pub rects: Vec<RegionRect>,
}

#[derive(Deserialize)]
pub struct DragEndPayload {
    pub label: String,
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Deserialize)]
pub struct LabelPayload {
    pub label: String,
}

/// 前端 canvas-init：登记 DPR 并下发本屏便签
pub fn handle_canvas_init(app: &AppHandle, p: CanvasInitPayload) {
    let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
        return;
    };
    let inner = state.inner();
    if let Ok(mut g) = inner.lock() {
        g.canvas_dpr.insert(p.label.clone(), p.dpr);
        g.emit_notes(app, &[p.label]);
        g.emit_state(app);
    }
}

/// 前端 update-regions：重算窗口区域（SetWindowRgn）
pub fn handle_update_regions(app: &AppHandle, p: UpdateRegionsPayload) {
    let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
        return;
    };
    let inner = state.inner();
    let Ok(g) = inner.lock() else {
        return;
    };
    let dpr = g.canvas_dpr.get(&p.label).copied().unwrap_or(1.0);
    if let Some(w) = app.get_webview_window(&p.label) {
        let rects: Vec<(f64, f64, f64, f64)> =
            p.rects.iter().map(|r| (r.x, r.y, r.w, r.h)).collect();
        apply_region(&w, &rects, dpr);
    }
}

/// 前端 drag-start：窗口放大到虚拟屏 + 清空 Rgn
pub fn handle_drag_start(app: &AppHandle, p: LabelPayload) {
    let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
        return;
    };
    let inner = state.inner();
    let Ok(g) = inner.lock() else {
        return;
    };
    let vrect = g.virtual_rect;
    if let Some(w) = app.get_webview_window(&p.label) {
        expand_for_drag(&w, &vrect);
        clear_region(&w);
    }
}

/// 前端 drag-end：更新便签坐标 + 按落点分发到显示器 + 窗口缩回
pub fn handle_drag_end(app: &AppHandle, p: DragEndPayload) {
    let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
        return;
    };
    let inner = state.inner();
    let Ok(mut g) = inner.lock() else {
        return;
    };
    if let Some(n) = g.notes.iter_mut().find(|n| n.id == p.id) {
        n.x = p.x;
        n.y = p.y;
        n.w = p.w;
        n.h = p.h;
    }
    // 源窗口缩回自己的显示器
    if let Some(w) = app.get_webview_window(&p.label) {
        if let Some(i) = canvas_index(&p.label) {
            if let Some(m) = g.monitors.get(i) {
                shrink_back(&w, &m.rect);
            }
        }
    }
    // 全量重发（简单可靠：每窗口拿自己屏内的便签，按中心点自动跨屏归属）
    let labels: Vec<String> = (0..g.monitors.len()).map(canvas_label).collect();
    g.emit_notes(app, &labels);
    g.emit_state(app);
}

/// 前端 card-focus：进入编辑态（临时激活窗口）
pub fn handle_card_focus(app: &AppHandle, p: LabelPayload) {
    let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
        return;
    };
    let inner = state.inner();
    let Ok(mut g) = inner.lock() else {
        return;
    };
    // 跨画布切换编辑（多屏：在 A 屏编辑中点 B 屏卡片）：
    // 必须先退出旧编辑窗口，否则旧窗口保持 always_on_bottom(false) 置顶不回压。
    // 失焦 FOREGROUND 事件只清理 editing 指向的窗口，不会管旧窗口。
    if let Some(prev) = g.editing.clone() {
        if prev != p.label {
            if let Some(w) = app.get_webview_window(&prev) {
                deactivate_editing(&w);
            }
        }
    }
    if let Some(w) = app.get_webview_window(&p.label) {
        activate_editing(&w);
    }
    g.editing = Some(p.label.clone());
    g.editing_since = Some(std::time::Instant::now());
    g.emit_state(app);
}

/// 前端 card-blur：结束编辑态
pub fn handle_card_blur(app: &AppHandle, p: LabelPayload) {
    let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
        return;
    };
    let inner = state.inner();
    let Ok(mut g) = inner.lock() else {
        return;
    };
    if g.editing.as_deref() == Some(p.label.as_str()) {
        if let Some(w) = app.get_webview_window(&p.label) {
            deactivate_editing(&w);
        }
        g.editing = None;
        g.editing_since = None;
        g.emit_state(app);
    }
}

/// 调试台：强制重建画布
pub fn handle_rebuild(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
        return;
    };
    let inner = state.inner();
    if let Ok(mut g) = inner.lock() {
        g.monitors = enumerate_monitors();
        g.virtual_rect = virtual_bounds(&g.monitors);
        g.rebuild_canvases(app);
        g.emit_state(app);
    }
}

/// 调试台：重置便签到初始位置
pub fn handle_reset_notes(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() else {
        return;
    };
    let inner = state.inner();
    let Ok(mut g) = inner.lock() else {
        return;
    };
    g.notes = default_notes();
    let labels: Vec<String> = (0..g.monitors.len()).map(canvas_label).collect();
    g.emit_notes(app, &labels);
    g.emit_state(app);
}

/// 存储 listen 返回的 EventId（防止监听器被注销），返回全部 id
pub fn push_event_id(app: &AppHandle, id: tauri::EventId) {
    if let Some(state) = app.try_state::<Arc<Mutex<Inner>>>() {
        let inner = state.inner();
        if let Ok(mut g) = inner.lock() {
            g.event_ids.push(id);
        }
    }
}

fn canvas_index(label: &str) -> Option<usize> {
    label.strip_prefix("canvas-").and_then(|s| s.parse::<usize>().ok())
}

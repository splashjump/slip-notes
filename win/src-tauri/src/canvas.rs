//! 窗口管理器（Q31 重构版，FORM-PLAN §4/§15）
//!
//! 窗口结构：主屏 = 边栏窗口(sidebar) + 画布窗口(canvas-i)；副屏 = 画布窗口；
//! 全局 = 拖拽层窗口(drag-layer)；控制台 = main（普通窗口）。
//! 窗口常态 = 全屏透明（画布）/ 边栏矩形（sidebar），**不再 SetWindowRgn**——
//! 显示层永不裁剪（Q31：Rgn 与 DOM 异步同步必然产生消失/缺块/被裁 bug）。
//! 穿透改为 WM_NCHITTEST 命中判定：顶层窗口子类化，命中矩形内返回 HTCLIENT
//! （系统再询问 WebView2 子窗口 → 正常收点击），空白处返回 HTTRANSPARENT
//! （消息落到桌面/下层窗口）。命中矩形由前端 update-regions 上报（语义 = 旧 Rgn）。
//! 视图打开：画布窗口抬升到顶（SWP_NOACTIVATE）+ 命中全屏 + 窗口内遮罩（前端）。
//! 保底（Q31）：dismiss-all 事件隐藏全部窗口 + 任务栏托盘图标恢复；无自动安全阀。
//!
//! ⚠️ 锁纪律（重要）：AppState 锁内只做数据操作；任何 Win32 窗口调用
//! （SetWindowPos / ShowWindow / SetWindowRgn）必须离开锁执行——
//! 否则后台线程持锁 + SendMessage 到主线程 + 主线程等锁 = 互相等待（整窗未响应）。
//! 实现方式：锁内计算 → 返回 WinOp 列表 → 释放锁 → exec_win_ops。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DispatchMessageW, GetClassNameW,
    GetForegroundWindow, GetMessageW, GetWindowLongPtrW, GetWindowRect,
    LoadIconW, SetWindowLongPtrW, SetWindowPos, TranslateMessage,
    EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GWL_STYLE,
    GWLP_WNDPROC, HTCLIENT, HTTRANSPARENT, HWND_BOTTOM, HWND_TOP, IDI_APPLICATION,
    MSG, SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOZORDER,
    SWP_NOMOVE, SWP_NOSIZE, WINEVENT_OUTOFCONTEXT, WM_APP, WM_LBUTTONUP,
    WM_NCHITTEST, MONITORINFOF_PRIMARY, HICON,
    WS_CAPTION, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};
use windows::Win32::UI::Shell::{
    NIM_ADD, NIF_ICON, NIF_MESSAGE, NIF_TIP, NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows::Win32::Foundation::{LRESULT, WPARAM};

use crate::action;
use crate::lock::{register_thread_name, AppLock};
use crate::store::Store;

/// WM_NCHITTEST 命中判定回调（Q31）：窗口子类化 WndProc。
/// ⚠️ 锁纪律：回调内锁内只读命中矩形（无任何 Win32 调用），其余转发旧 WndProc。
unsafe extern "system" fn slip_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // 托盘回调（Q31 保底：点托盘图标恢复全部窗口）
    if msg == TRAY_MSG {
        if lparam.0 == WM_LBUTTONUP as isize {
            if let Some(app) = WND_APP.get().and_then(|m| m.lock().ok().and_then(|g| g.clone())) {
                restore_dismissed(&app);
            }
        }
        return LRESULT(0);
    }
    if msg == WM_NCHITTEST {
        // lParam 低 16 位 = 屏幕 x，高 16 位 = 屏幕 y（物理像素）
        let sx = (lparam.0 & 0xFFFF) as i16 as i32;
        let sy = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
        let hit = hit_test(hwnd, sx as f64, sy as f64);
        return LRESULT(if hit { HTCLIENT as isize } else { HTTRANSPARENT as isize });
    }
    let old = OLD_WNDPROCS
        .lock()
        .ok()
        .and_then(|m| m.get(&(hwnd.0 as usize)).copied())
        .unwrap_or(0);
    // isize → fn 指针（非 Option 转换；保留调用约定，再包 Some）
    let proc: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT =
        unsafe { std::mem::transmute::<isize, unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT>(old) };
    CallWindowProcW(Some(proc), hwnd, msg, wparam, lparam)
}

/// 命中判定（锁内只读）：当前窗口命中矩形（屏幕物理像素）是否包含该屏幕坐标点。
/// 命中矩形 = 前端上报 CSS 矩形 × dpr + 窗口屏幕原点（handle_update_regions 换算）。
/// 视图打开时由 Rust 置为全屏（handle_view_open）；关闭后前端重报恢复。
fn hit_test(hwnd: HWND, sx: f64, sy: f64) -> bool {
    let Some(app) = WND_APP.get().and_then(|m| m.lock().ok().and_then(|g| g.clone())) else {
        return true; // 未就绪：默认可点（视图未初始化，安全兜底）
    };
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return true;
    };
    let rects = {
        let g = state.lock();
        let label = g
            .hwnds
            .iter()
            .find(|(_, h)| **h == hwnd.0 as usize)
            .map(|(l, _)| l.clone());
        let Some(label) = label else { return true };
        g.hit_rects.get(&label).cloned().unwrap_or_default()
    };
    rects.iter().any(|(x, y, w, h)| sx >= *x && sy >= *y && sx < x + w && sy < y + h)
}

/// 旧 WndProc 注册表（hwnd → 旧 WndProc 指针）
static OLD_WNDPROCS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<usize, isize>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// WndProc 回调用 AppHandle（同 HOOK_APP 模式）
static WND_APP: std::sync::OnceLock<std::sync::Mutex<Option<AppHandle>>> = std::sync::OnceLock::new();

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct MonitorSlot {
    pub rect: RECT,
    pub dpi: u32,
    pub primary: bool,
}

impl MonitorSlot {
    pub fn scale(&self) -> f64 {
        self.dpi as f64 / 96.0
    }
}

#[derive(Clone, Serialize, Debug)]
pub struct ViewInfo {
    pub name: String,  // "recent" | "timeline"
    pub label: String, // 被抬升的画布窗口
}

/// 管理器内部状态（Arc<AppLock> 挂在 app state 上）
pub struct AppState {
    pub monitors: Vec<MonitorSlot>,
    pub virtual_rect: RECT,
    pub primary: usize, // 边栏所在显示器
    pub store: Store,
    pub view: Option<ViewInfo>,
    pub sidebar_collapsed: bool,
    pub sidebar_rect: Option<(f64, f64, f64, f64)>, // 物理像素
    pub console_visible: bool,
    pub editing: Option<String>,
    pub editing_since: Option<std::time::Instant>,
    /// 按显示器跟踪的全屏隐藏状态（Y7）：true = 该屏全屏时窗口已隐藏
    pub fullscreen_hidden: Vec<bool>,
    pub canvas_dpr: HashMap<String, f64>,
    /// 窗口 hwnd 缓存（usize；创建时记录；hook 线程锁内只读，避免锁内调 tauri API）
    /// （也经 state 广播，供 Q31 验收脚本定位窗口）
    pub hwnds: HashMap<String, usize>,
    /// 命中矩形（屏幕物理像素；Q31：update-regions 前端上报，供 WM_NCHITTEST 判定）
    pub hit_rects: HashMap<String, Vec<(f64, f64, f64, f64)>>,
    /// 收起态（Q31 保底：dismiss-all 隐藏全部窗口后为 true；托盘点击恢复）
    pub dismissed: bool,
    pub drag_layer_ready: bool,
    pub drag_layer_shown: bool,
    pub drag_layer_dpr: Option<f64>,
    /// 本轮拖拽源窗口（drag-layer-rendered ack 转发目标）
    pub drag_src: Option<String>,
    /// 视图关闭动画序列号（defer_lower 超时与 view-anim-done 竞态仲裁）
    pub view_close_seq: u64,
    /// state 事件序号（诊断用：前端日志对比可定位丢失的广播）
    pub state_seq: std::cell::Cell<u64>,
    pub event_ids: Vec<tauri::EventId>,
}

/// Win32 窗口操作（锁外执行；锁内只负责生成）
#[derive(Debug)]
pub(crate) enum WinOp {
    PushBottom(String),
    Hide(String),
    Show(String),
    RaiseTop(String),
}

fn exec_win_ops(app: &AppHandle, ops: Vec<WinOp>) {
    for op in ops {
        match op {
            WinOp::PushBottom(l) => {
                if let Some(w) = app.get_webview_window(&l) {
                    push_bottom(&w);
                }
            }
            WinOp::Hide(l) => {
                if let Some(w) = app.get_webview_window(&l) {
                    hide_win(&w);
                }
            }
            WinOp::Show(l) => {
                if let Some(w) = app.get_webview_window(&l) {
                    show_win_noactivate(&w);
                }
            }
            WinOp::RaiseTop(l) => {
                if let Some(w) = app.get_webview_window(&l) {
                    if let Ok(hwnd) = w.hwnd() {
                        set_pos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    }
                }
            }
        }
    }
}

/// WinEvent 回调里用的 AppHandle
static HOOK_APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

#[allow(dead_code)]
const WATCHDOG_INTERVAL: Duration = Duration::from_millis(800); // 预留（原 watchdog 已移除）
const AUTO_ARCHIVE_INTERVAL: Duration = Duration::from_secs(30);
const HOOK_EVENT_FG: u32 = EVENT_SYSTEM_FOREGROUND;
const HOOK_EVENT_LOC: u32 = EVENT_OBJECT_LOCATIONCHANGE;
const HOOK_EVENT_DISPLAYCHANGE: u32 = 0x8010; // EVENT_DISPLAYCHANGE
/// 托盘回调消息（WM_APP + 1；注册到 main 窗口）
const TRAY_MSG: u32 = WM_APP + 1;

// ---------------------------------------------------------------------------
// 窗口创建 / 销毁
// ---------------------------------------------------------------------------

pub fn canvas_label(i: usize) -> String {
    format!("canvas-{i}")
}

fn window_scale(hwnd: HWND) -> f64 {
    unsafe {
        let dpi = GetDpiForWindow(hwnd);
        if dpi > 0 {
            dpi as f64 / 96.0
        } else {
            1.0
        }
    }
}

fn create_canvas_window(app: &AppHandle, label: &str, rect: &RECT) -> tauri::Result<()> {
    let w = (rect.right - rect.left) as f64;
    let h = (rect.bottom - rect.top) as f64;
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
        .build()?;
    let _ = win.set_position(tauri::PhysicalPosition::new(rect.left, rect.top));
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    apply_desk_style(&win);
    record_win(app, label, &win);
    Ok(())
}

/// 记录窗口 hwnd + 子类化（WM_NCHITTEST 命中穿透；管理期未到位时由 record_all_windows 补）
fn record_win(app: &AppHandle, label: &str, win: &tauri::WebviewWindow) {
    if let Some(state) = app.try_state::<Arc<AppLock>>() {
        let hwnd = win.hwnd().ok().map(|h| h.0 as usize);
        if let Some(hwnd) = hwnd {
            let mut g = state.lock();
            g.hwnds.insert(label.to_string(), hwnd);
            drop(g);
            // 锁外：子类化（SetWindowLongPtrW 是 Win32 调用）
            subclass_window(win);
        }
    }
}

/// 窗口子类化：替换 WndProc 为 slip_wndproc（Q31 命中穿透）。
/// 保存旧 WndProc 到 OLD_WNDPROCS（WM_NCHITTEST 外的消息转发给旧 proc）。
fn subclass_window(win: &tauri::WebviewWindow) {
    let Ok(hwnd) = win.hwnd() else { return };
    unsafe {
        let old = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        if let Ok(mut m) = OLD_WNDPROCS.lock() {
            m.insert(hwnd.0 as usize, old);
        }
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, slip_wndproc as *const () as isize);
    }
}

/// manage 后补记录所有窗口（Q31：AppState::new 建窗时 state 未 manage，见 setup）
fn record_all_windows(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else { return };
    let monitors = {
        let g = state.lock();
        g.monitors.clone()
    };
    for (i, _m) in monitors.iter().enumerate() {
        let label = canvas_label(i);
        if let Some(w) = app.get_webview_window(&label) {
            record_win(app, &label, &w);
        }
    }
    if let Some(w) = app.get_webview_window("sidebar") {
        record_win(app, "sidebar", &w);
    }
}

fn create_sidebar_window(app: &AppHandle, m: &MonitorSlot) -> tauri::Result<()> {
    let s = m.scale();
    let w = action::SIDEBAR_W_CSS * s;
    let h = (m.rect.bottom - m.rect.top) as f64;
    let x = m.rect.right as f64 - w;
    let y = m.rect.top as f64;
    let win = WebviewWindowBuilder::new(app, "sidebar", WebviewUrl::App("index.html".into()))
        .title("slip-sidebar")
        .position(x, y)
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_bottom(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .resizable(false)
        .focused(false)
        .build()?;
    let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    apply_desk_style(&win);
    record_win(app, "sidebar", &win);
    Ok(())
}

fn apply_desk_style(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);
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
// 托盘图标（Q31 保底：dismiss-all 隐藏全部窗口后，点托盘恢复）
// ---------------------------------------------------------------------------

/// 注册托盘图标到 main 窗口（回调消息 TRAY_MSG → slip_wndproc 处理）
fn init_tray(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    log::info!("[slip] 托盘注册目标 main hwnd=0x{:x}", hwnd.0 as usize);
    // 登记进 hwnds（诊断/测试定位）
    if let Some(state) = app.try_state::<Arc<AppLock>>() {
        let mut g = state.lock();
        g.hwnds.insert("main".into(), hwnd.0 as usize);
    }
    subclass_window(&win);
    unsafe {
        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        nid.uCallbackMessage = TRAY_MSG;
        nid.hIcon = LoadIconW(None, IDI_APPLICATION).unwrap_or(HICON::default());
        let tip: Vec<u16> = "纸筏 slip — 点击恢复便签墙\0".encode_utf16().collect();
        for (i, c) in tip.iter().copied().take(127).enumerate() {
            nid.szTip[i] = c;
        }
        let _ = Shell_NotifyIconW(NIM_ADD, &nid);
    }
    log::info!("[slip] 托盘图标已注册");
}

/// 收起全部（Q31 保底）：隐藏所有画布 + 边栏窗口（拖拽层本就隐藏；main 控制台保留）
/// ⚠️ 锁外 Win32：锁内只收集 labels 列表。
pub fn handle_dismiss(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else { return };
    let labels: Vec<String> = {
        let mut g = state.lock();
        if g.dismissed {
            return;
        }
        g.dismissed = true;
        let mut ls: Vec<String> = (0..g.monitors.len()).map(canvas_label).collect();
        ls.push("sidebar".into());
        ls.push("drag-layer".into());
        ls
    };
    exec_win_ops(app, labels.into_iter().map(WinOp::Hide).collect());
    log::info!("[slip] 收起全部窗口（托盘可恢复）");
}

/// 恢复全部（Q31 保底：托盘点击 / 前端按钮）：显示全部窗口 + 置底
fn restore_dismissed(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else { return };
    let labels: Vec<String> = {
        let mut g = state.lock();
        if !g.dismissed {
            return;
        }
        g.dismissed = false;
        let mut ls: Vec<String> = (0..g.monitors.len()).map(canvas_label).collect();
        ls.push("sidebar".into());
        ls
    };
    let mut ops: Vec<WinOp> = Vec::new();
    for l in &labels {
        ops.push(WinOp::Show(l.clone()));
        ops.push(WinOp::PushBottom(l.clone()));
    }
    exec_win_ops(app, ops);
    // 恢复后视图状态：重新执行一次 region 上报（前端 UI 不动，仅命中缓存可能已过期）
    // —— 视图打开时命中全屏，若收起时正开视图，恢复后由前端 view-anim-done 或重报恢复。
    if let Some(s) = app.try_state::<Arc<AppLock>>() {
        let payload = {
            let g = s.lock();
            state_payload_inner(&g)
        };
        let _ = app.emit("state", payload);
    }
    log::info!("[slip] 恢复全部窗口");
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
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
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
// Q31 注：区域穿透不再用 SetWindowRgn（显示层永不裁剪），改由 WM_NCHITTEST
// 命中判定（slip_wndproc / hit_test）。前端 update-regions 上报的矩形用于
// 更新命中缓存（handle_update_regions），不再设置窗口区域。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// z-order 管理（⚠️ 必须在锁外调用）
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

pub fn activate_editing(win: &tauri::WebviewWindow) {
    remove_noactivate(win);
    let _ = win.set_always_on_bottom(false);
    let _ = win.set_focus();
}

pub fn deactivate_editing(win: &tauri::WebviewWindow) {
    let _ = win.set_always_on_bottom(true);
    apply_desk_style(win);
    push_bottom(win);
}

/// 视图打开：画布窗口抬升到顶（不抢前台）+ Rgn 全屏
pub fn raise_for_view(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let _ = w.set_always_on_bottom(false);
    remove_noactivate(&w);
    exec_win_ops(app, vec![WinOp::RaiseTop(label.to_string())]);
    // Q31：view 打开 → 命中缓存置为该窗口所在显示器全屏矩形
    // （前端遮罩 div 铺满窗口，NCHITTEST 全命中 → 遮罩拦截点击关闭视图）
    if let Some(state) = app.try_state::<Arc<AppLock>>() {
        let rect = {
            let g = state.lock();
            let mon_idx = label
                .strip_prefix("canvas-")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(g.primary);
            g.monitors.get(mon_idx).map(|m| m.rect)
        };
        if let Some(r) = rect {
            let mut g = state.lock();
            g.hit_rects.insert(label.to_string(), vec![(
                r.left as f64,
                r.top as f64,
                (r.right - r.left) as f64,
                (r.bottom - r.top) as f64,
            )]);
        }
    }
}

/// 视图关闭：延迟压回（前端先播放收回动画，view-anim-done 或超时后再执行）。
/// 序列号仲裁：新一次关闭/打开会让旧定时器失效，防陈旧压回打断新视图。
pub fn defer_lower(app: &AppHandle, label: &str) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else { return };
    let seq = {
        let mut g = state.lock();
        g.view_close_seq += 1;
        g.view_close_seq
    };
    let h = app.clone();
    let label = label.to_string();
    let _ = thread::Builder::new()
        .name("view-lower".into())
        .spawn(move || {
            thread::sleep(Duration::from_millis(3000)); // 前端动画约 1.5s，3s 兜底
            let Some(st) = h.try_state::<Arc<AppLock>>() else { return };
            let (cur, has_view) = {
                let g = st.lock();
                (g.view_close_seq, g.view.is_some())
            };
            // 序列号未变（动画仍未完成）+ 当前无视图（新视图未打开）才压回
            if cur == seq && !has_view {
                lower_after_view(&h, &label);
            }
        });
}

/// 前端收回动画完成（view-anim-done）→ 立即压回 + 作废兑底定时器。
/// 陈旧事件保护：若新视图已打开（快速关→开），不得压回新视图的抬升态。
pub fn handle_view_anim_done(app: &AppHandle, p: LabelPayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else { return };
    let has_view = {
        let mut g = state.lock();
        g.view_close_seq += 1;
        g.view.is_some()
    };
    if !has_view {
        lower_after_view(app, &p.label);
    }
}

/// 拖拽层窗口渲染完成 ack → 转发给拖拽源窗口（源窗口收到后才隐藏原卡）
pub fn handle_drag_layer_rendered(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else { return };
    let src = {
        let g = state.lock();
        g.drag_src.clone()
    };
    if let Some(src) = src {
        if let Some(w) = app.get_webview_window(&src) {
            let _ = w.emit("drag-layer-ack", ());
        }
    }
}

/// 视图关闭：压回置底（精确 Rgn 由前端动画结束后重报）
pub fn lower_after_view(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let _ = w.set_always_on_bottom(true);
    apply_desk_style(&w);
    push_bottom(&w);
}

/// 隐藏窗口。⚠️ 必须用 tauri 的 hide() 而非裸 ShowWindow(SW_HIDE)：
/// WebView2 的渲染窗口（Chrome_RenderWidgetHostHWND，msedgewebview2 进程的独立
/// 顶层窗口）跟随宿主可见性由 tauri/tao 管理，裸 ShowWindow 只隐藏 tao 包装窗口，
/// 渲染窗口仍残留屏幕（Q31 实机发现：收起后 WindowFromPoint 仍命中渲染窗口）。
pub fn hide_win(win: &tauri::WebviewWindow) {
    let _ = win.hide();
}

pub fn show_win_noactivate(win: &tauri::WebviewWindow) {
    let _ = win.show();
}

// ---------------------------------------------------------------------------
// 拖拽层窗口
// ---------------------------------------------------------------------------

const DRAG_LAYER_MARGIN: f64 = 30.0; // 卡片阴影边距（CSS px），与 drag-layer.ts 一致

fn create_drag_layer(app: &AppHandle) {
    let r = WebviewWindowBuilder::new(app, "drag-layer", WebviewUrl::App("index.html".into()))
        .title("slip-drag")
        .position(-32000.0, -32000.0)
        .inner_size(10.0, 10.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build();
    match r {
        Ok(w) => {
            apply_desk_style(&w);
            hide_win(&w);
        }
        Err(e) => log::warn!("创建拖拽层窗口失败: {e}"),
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

fn is_desktop_window(hwnd: HWND) -> bool {
    matches!(
        window_class(hwnd).as_str(),
        "Progman" | "WorkerW" | "SHELLDLL_DefView"
    )
}

fn is_fullscreen_on(hwnd: HWND, m: &MonitorSlot) -> bool {
    if hwnd.0.is_null() || is_desktop_window(hwnd) {
        return false;
    }
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
// 状态广播
// ---------------------------------------------------------------------------

fn state_payload_inner(g: &AppState) -> serde_json::Value {
    let seq = g.state_seq.get() + 1;
    g.state_seq.set(seq);
    serde_json::json!({
        "stateSeq": seq,
        "notes": g.store.notes,
        "ephemeral": g.store.ephemeral,
        "monitors": g.monitors.iter().map(|m| serde_json::json!({
            "rect": [m.rect.left, m.rect.top, m.rect.right, m.rect.bottom],
            "dpi": m.dpi,
            "primary": m.primary,
        })).collect::<Vec<_>>(),
        "virtualRect": [g.virtual_rect.left, g.virtual_rect.top,
                        g.virtual_rect.right, g.virtual_rect.bottom],
        "primaryIndex": g.primary,
        "view": g.view,
        "editing": g.editing,
        "fullscreenHidden": g.fullscreen_hidden,
        "sidebarCollapsed": g.sidebar_collapsed,
        // Q31 验收钩子：hwnd 表（测试脚本定位窗口用；正式产品不依赖）
        "hwnds": g.hwnds,
        "sidebarRect": g.sidebar_rect,
        "timeOffset": g.store.time_offset,
        "journal": g.store.journal_meta(30),
    })
}

fn sidebar_physical_rect(m: &MonitorSlot) -> (f64, f64, f64, f64) {
    let s = m.scale();
    let w = action::SIDEBAR_W_CSS * s;
    (
        m.rect.right as f64 - w,
        m.rect.top as f64,
        w,
        (m.rect.bottom - m.rect.top) as f64,
    )
}

impl AppState {
    pub fn new(app: &AppHandle) -> Self {
        let monitors = enumerate_monitors();
        let virtual_rect = virtual_bounds(&monitors);
        let primary = monitors.iter().position(|m| m.primary).unwrap_or(0);
        let mut state = AppState {
            monitors,
            virtual_rect,
            primary,
            store: Store::new(),
            view: None,
            sidebar_collapsed: false,
            sidebar_rect: None,
            console_visible: true,
            editing: None,
            editing_since: None,
            fullscreen_hidden: Vec::new(), // 在窗口创建后按屏数初始化（见下方）
            canvas_dpr: Default::default(),
            hwnds: Default::default(),
            hit_rects: Default::default(),
            dismissed: false,
            drag_layer_ready: false,
            drag_layer_shown: false,
            drag_layer_dpr: None,
            drag_src: None,
            view_close_seq: 0,
            state_seq: std::cell::Cell::new(0),
            event_ids: Vec::new(),
        };
        // 启动窗口创建（此时尚未上锁）
        let monitors = state.monitors.clone();
        let primary = state.primary;
        rebuild_windows(app, &monitors, primary);
        state.sidebar_rect = monitors.get(primary).map(sidebar_physical_rect);
        state.fullscreen_hidden = vec![false; monitors.len()];
        create_drag_layer(app);
        // 启动后 3s 自动收回一次（种子含 40 天旧便签 → 未确认演示）
        let h = app.clone();
        thread::Builder::new()
            .name("auto-archive-start".into())
            .spawn(move || {
                thread::sleep(Duration::from_secs(3));
                if let Some(s) = h.try_state::<Arc<AppLock>>() {
                    let payload = {
                        let mut g = s.lock();
                        let changed = g.store.auto_archive();
                        if changed.is_empty() {
                            None
                        } else {
                            Some(state_payload_inner(&g))
                        }
                    };
                    if let Some(p) = payload {
                        let _ = h.emit("state", p);
                    }
                }
            })
            .ok();
        state
    }

    pub fn state_payload(&self, _app: &AppHandle) -> serde_json::Value {
        state_payload_inner(self)
    }

    /// 前台窗口变化（⚠️ 锁内零 Win32：fg 与全屏判定由调用方锁外算好传入——
    /// GetWindowRect/GetWindowLongPtrW 对外窗口可能阻塞，锁内调用会把 hook
    /// 线程卡成“持锁 + 等对方线程”，饿死全部动作命令（死锁纪律））
    pub fn on_foreground_change(
        &mut self,
        app: &AppHandle,
        is_location_change: bool,
        fg: HWND,
        fulls: &[bool],
    ) -> HookOutcome {
        let mut ops: Vec<WinOp> = Vec::new();
        let mut edit_end: Option<String> = None;

        if !is_location_change {
            let in_grace = self
                .editing_since
                .map(|t| t.elapsed() < Duration::from_millis(1500))
                .unwrap_or(false);
            if let Some(editing_label) = self.editing.clone() {
                if !in_grace {
                    let editing_hwnd = self.hwnds.get(&editing_label).copied();
                    let still_focused = editing_hwnd.map(|h| h == fg.0 as usize).unwrap_or(false);
                    if !still_focused {
                        self.editing = None;
                        self.editing_since = None;
                        ops.push(WinOp::PushBottom(editing_label.clone()));
                        edit_end = Some(editing_label);
                    }
                }
            }

            // 前台已切走：非编辑、非前台、且非视图抬升中的画布 + 边栏统一回压
            let view_label = self.view.as_ref().map(|v| v.label.clone());
            if self.editing.is_none() {
                for i in 0..self.monitors.len() {
                    let label = canvas_label(i);
                    if view_label.as_deref() == Some(label.as_str()) {
                        continue;
                    }
                    let h = self.hwnds.get(&label).copied();
                    if h.map(|h| h == fg.0 as usize).unwrap_or(false) {
                        continue;
                    }
                    ops.push(WinOp::PushBottom(label));
                }
                if view_label.as_deref() != Some("sidebar") {
                    let h = self.hwnds.get("sidebar").copied();
                    if h.map(|h| h != fg.0 as usize).unwrap_or(true) {
                        ops.push(WinOp::PushBottom("sidebar".into()));
                    }
                }
            }
        }

        // 全屏检测：排除画布/边栏/拖拽层自身（缓存 hwnd 比较）
        let fg_u = fg.0 as usize;
        let fg_is_self = (0..self.monitors.len()).any(|i| {
            self.hwnds
                .get(&canvas_label(i))
                .map(|h| *h == fg_u)
                .unwrap_or(false)
        }) || self.hwnds.get("sidebar").map(|h| *h == fg_u).unwrap_or(false)
            || self.hwnds.get("drag-layer").map(|h| *h == fg_u).unwrap_or(false);
        if fg_is_self {
            return HookOutcome { ops, edit_end };
        }

        // Y7：按显示器分别跟踪全屏隐藏。任一屏全屏 → 全部窗口隐藏；
        // 只有最后一屏也退出全屏时才恢复。
        let all_labels: Vec<String> = (0..self.monitors.len())
            .map(canvas_label)
            .chain(std::iter::once("sidebar".to_string()))
            .chain(std::iter::once("drag-layer".to_string()))
            .collect();
        let was_hidden = self.fullscreen_hidden.iter().any(|b| *b);
        for (i, _m) in self.monitors.iter().enumerate() {
            let full = fulls.get(i).copied().unwrap_or(false);
            if full && !self.fullscreen_hidden[i] {
                self.fullscreen_hidden[i] = true;
            } else if !full && self.fullscreen_hidden[i] {
                self.fullscreen_hidden[i] = false;
            }
        }
        let now_hidden = self.fullscreen_hidden.iter().any(|b| *b);
        // Q31：dismissed（手动收起）时全屏退出不得自动恢复（托盘/显式恢复才行）
        let suppressed = self.dismissed;
        if !was_hidden && now_hidden {
            // 进入全屏：全部窗口隐藏（只此一处，避免重复 Hide）
            for label in &all_labels {
                ops.push(WinOp::Hide(label.clone()));
            }
        } else if was_hidden && !now_hidden && !suppressed {
            // 全部屏退出全屏：恢复窗口 + 回压置底
            for label in &all_labels {
                ops.push(WinOp::Show(label.clone()));
                ops.push(WinOp::PushBottom(label.clone()));
            }
        }
        let _ = app;
        HookOutcome { ops, edit_end }
    }
}

/// 前台变化处理结果（锁外执行）
pub(crate) struct HookOutcome {
    pub ops: Vec<WinOp>,
    pub edit_end: Option<String>,
}

fn exec_hook_outcome(app: &AppHandle, o: HookOutcome) {
    if let Some(label) = o.edit_end {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.emit("edit-end", ());
        }
    }
    exec_win_ops(app, o.ops);
}

/// 重建画布 + 边栏窗口（⚠️ 纯窗口操作：锁外调用，绝不持 AppState 锁——
/// WebView2 窗口创建可能阻塞，持锁会饿死主线程/动作命令）
fn rebuild_windows(app: &AppHandle, monitors: &[MonitorSlot], primary: usize) {
    let old: Vec<String> = app
        .webview_windows()
        .values()
        .filter(|w| w.label().starts_with("canvas-") || w.label() == "sidebar")
        .map(|w| w.label().to_string())
        .collect();
    for label in &old {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
    }
    // 清掉已销毁窗口的 hwnd 缓存（新窗口创建时 record_hwnd 会补上）
    if let Some(state) = app.try_state::<Arc<AppLock>>() {
        let mut g = state.lock();
        for l in &old {
            g.hwnds.remove(l);
        }
    }
    for (i, m) in monitors.iter().enumerate() {
        let label = canvas_label(i);
        if let Err(e) = create_canvas_window(app, &label, &m.rect) {
            log::warn!("创建画布窗口 {label} 失败: {e}");
        }
    }
    if let Some(pm) = monitors.get(primary) {
        if let Err(e) = create_sidebar_window(app, pm) {
            log::warn!("创建边栏窗口失败: {e}");
        }
    }
}

impl AppState {
    #[allow(dead_code)]
    fn dismiss_drag_layer(&mut self, app: &AppHandle) {
        if !self.drag_layer_shown {
            return;
        }
        if let Some(dl) = app.get_webview_window("drag-layer") {
            hide_win(&dl);
        }
        self.drag_layer_shown = false;
    }
}

// ---------------------------------------------------------------------------
// WinEvent hook（消息泵线程；回调内先锁后释放，Win32 操作离开锁执行）
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
    if event == HOOK_EVENT_FG {
        // FOREGROUND：正常处理
    } else if event == HOOK_EVENT_LOC && id_object == 0 {
        let fg = GetForegroundWindow();
        if hwnd != fg {
            return;
        }
    } else if event == HOOK_EVENT_DISPLAYCHANGE {
        // 显示器拓扑变化 → 重建（锁外；窗口创建可能阻塞）
        let Some(lock) = HOOK_APP.get() else { return };
        let Ok(guard) = lock.lock() else { return };
        let Some(app) = guard.clone() else { return };
        handle_topology_change(&app);
        return;
    } else {
        return;
    }
    let is_location_change = event == HOOK_EVENT_LOC;
    let Some(lock) = HOOK_APP.get() else { return };
    let Ok(guard) = lock.lock() else { return };
    let Some(app) = guard.clone() else { return };
    if let Some(state) = app.try_state::<Arc<AppLock>>() {
        // ⚠️ 锁外 Win32：GetForegroundWindow（全局读）+ 每屏 is_fullscreen_on
        // （GetWindowRect/GetWindowLongPtrW 对外窗口可能阻塞——绝不能持锁调用）
        let fg = unsafe { GetForegroundWindow() };
        let fulls = {
            let g = state.lock();
            let mons = g.monitors.clone();
            drop(g);
            mons.iter().map(|m| is_fullscreen_on(fg, m)).collect::<Vec<bool>>()
        };
        let outcome = {
            let mut g = state.lock();
            g.on_foreground_change(&app, is_location_change, fg, &fulls)
        };
        // 锁外：emit（需要主线程）+ Win32 操作
        exec_hook_outcome(&app, outcome);
    }
}

fn install_hook(app: &AppHandle) {
    let lock = HOOK_APP.get_or_init(|| Mutex::new(None));
    if let Ok(mut g) = lock.lock() {
        *g = Some(app.clone());
    }
    let hook_app = app.clone();
    thread::Builder::new()
        .name("win-event-hook".into())
        .spawn(move || {
            register_thread_name("win-event-hook");
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
                let hook_disp = SetWinEventHook(
                    HOOK_EVENT_DISPLAYCHANGE,
                    HOOK_EVENT_DISPLAYCHANGE,
                    None,
                    Some(foreground_hook),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                );
                log::info!(
                    "[slip] WinEvent hooks 已注册 fg=0x{:x} loc=0x{:x} disp=0x{:x}",
                    hook_fg.0 as usize,
                    hook_loc.0 as usize,
                    hook_disp.0 as usize
                );
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let _ = UnhookWinEvent(hook_fg);
                let _ = UnhookWinEvent(hook_loc);
                let _ = UnhookWinEvent(hook_disp);
                log::info!("[slip] WinEvent hook 消息泵线程退出");
            }
            let _ = hook_app;
        })
        .ok();
}

/// 自动收回定时器（Rust 宿主，AI 路径同入口）
/// 注：原 watchdog 线程已移除——拓扑检测改由 WinEvent hook（EVENT_DISPLAYCHANGE）
/// 触发，z-order 回压由前台切换 hook 负责；后台线程不再周期调用 Win32/枚举，
/// 杜绝"持锁 + SendMessage 到主线程"的整窗未响应死锁。
pub fn start_auto_archive(app: AppHandle) {
    thread::Builder::new()
        .name("auto-archive".into())
        .spawn(move || {
            register_thread_name("auto-archive");
            loop {
                thread::sleep(AUTO_ARCHIVE_INTERVAL);
                let Some(state) = app.try_state::<Arc<AppLock>>() else {
                    break;
                };
                let payload = {
                    let mut g = state.lock();
                    let changed = g.store.auto_archive();
                    if changed.is_empty() {
                        None
                    } else {
                        Some(state_payload_inner(&g))
                    }
                };
                if let Some(p) = payload {
                    let _ = app.emit("state", p);
                }
            }
        })
        .ok();
}

/// 拓扑变化 → 锁外重建（hook 线程调用；锁内只更新字段）
/// ⚠️ 锁内零 Win32：enumerate_monitors 先锁外枚举，锁内只比较/赋值（R2）
fn handle_topology_change(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let now = enumerate_monitors();
    let (monitors, primary, was_drag_shown) = {
        let mut g = state.lock();
        let same = now.len() == g.monitors.len()
            && now.iter().zip(&g.monitors).all(|(a, b)| {
                a.rect.left == b.rect.left
                    && a.rect.top == b.rect.top
                    && a.rect.right == b.rect.right
                    && a.rect.bottom == b.rect.bottom
                    && a.dpi == b.dpi
                    && a.primary == b.primary
            });
        if same {
            return;
        }
        log::warn!(
            "[slip] 拓扑变化：{} 屏 → {} 屏，重建窗口",
            g.monitors.len(),
            now.len()
        );
        g.monitors = now;
        g.virtual_rect = virtual_bounds(&g.monitors);
        g.primary = g.monitors.iter().position(|m| m.primary).unwrap_or(0);
        g.fullscreen_hidden = vec![false; g.monitors.len()];
        g.editing = None;
        let was = g.drag_layer_shown;
        g.drag_layer_shown = false;
        (g.monitors.clone(), g.primary, was)
    };
    drop_and_rebuild(app, &monitors, primary, was_drag_shown);
    if let Some(s) = app.try_state::<Arc<AppLock>>() {
        let payload = {
            let mut g = s.lock();
            g.sidebar_rect = monitors.get(primary).map(sidebar_physical_rect);
            state_payload_inner(&g)
        };
        let _ = app.emit("state", payload);
    }
}

/// 初始化入口（在 tauri setup 里调用）
pub fn setup(app: &AppHandle) {
    register_thread_name("main-thread"); // G3：主线程注册诊断名
    let _ = WND_APP.get_or_init(|| std::sync::Mutex::new(Some(app.clone())));
    let state = Arc::new(AppLock::new(AppState::new(app)));
    state.start_monitor();
    app.manage(state);
    // Q31 修复（真实 bug）：AppState::new 建窗时 state 未 manage → record_win 的
    // try_state 失败 → hwnds 从未记录 → hook 的 fg_is_self 失效（编辑激活被误判
    // 全屏隐藏，用户反馈的「便签彻底隐藏」疑似来源之一）。manage 后统一补记录。
    record_all_windows(app);
    install_hook(app);
    start_auto_archive(app.clone());
    init_tray(app);
    if let Some(s) = app.try_state::<Arc<AppLock>>() {
        let fg = unsafe { GetForegroundWindow() };
        let fulls = {
            let g = s.lock();
            let mons = g.monitors.clone();
            drop(g);
            mons.iter().map(|m| is_fullscreen_on(fg, m)).collect::<Vec<bool>>()
        };
        let outcome = {
            let mut g = s.lock();
            g.on_foreground_change(app, false, fg, &fulls)
        };
        exec_hook_outcome(app, outcome);
        // 慢工作（WinOp）之后重建 payload，避免陈旧快照（B3 同型）
        let payload = {
            let g = s.lock();
            state_payload_inner(&g)
        };
        let _ = app.emit("state", payload);
    }
}

// ---------------------------------------------------------------------------
// IPC payloads（SPIKE 事件保留；处理器 = 锁内数据 + 锁外 Win32）
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CanvasInitPayload {
    pub label: String,
    pub dpr: f64,
}

#[derive(Deserialize)]
pub struct DragLayerReadyPayload {
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
pub struct DragStartPayload {
    pub label: String,
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Deserialize)]
pub struct DragMovePayload {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Deserialize)]
pub struct DragEndPayload {
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

pub fn handle_canvas_init(app: &AppHandle, p: CanvasInitPayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let payload = {
        let mut g = state.lock();
        g.canvas_dpr.insert(p.label.clone(), p.dpr);
        Some(state_payload_inner(&g))
    };
    if let Some(p) = payload {
        let _ = app.emit("state", p);
    }
}

pub fn handle_drag_layer_ready(app: &AppHandle, p: DragLayerReadyPayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let mut g = state.lock();
    g.drag_layer_ready = true;
    g.drag_layer_dpr = Some(p.dpr);
    log::info!("[slip] 拖拽层就绪 dpr={}", p.dpr);
}

pub fn handle_update_regions(app: &AppHandle, p: UpdateRegionsPayload) {
    // Q31：不再 SetWindowRgn。前端已上报屏幕物理坐标（outerPosition + scaleFactor 换算），
    // 直接存 hit_rects 供 WM_NCHITTEST（lParam = 屏幕物理坐标）判定。
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let rects: Vec<(f64, f64, f64, f64)> = p.rects.iter().map(|r| (r.x, r.y, r.w, r.h)).collect();
    let mut g = state.lock();
    g.hit_rects.insert(p.label.clone(), rects);
}

pub fn handle_drag_start(app: &AppHandle, p: DragStartPayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    // 锁内：取数据
    let (note, dl_dpr) = {
        let g = state.lock();
        if !g.drag_layer_ready {
            return;
        }
        let note = match g.store.notes.iter().find(|n| n.id == p.id).cloned() {
            Some(n) => n,
            None => return,
        };
        (note, g.drag_layer_dpr.unwrap_or(1.0))
    };
    let Some(dl) = app.get_webview_window("drag-layer") else {
        return;
    };
    // 锁外：Win32 + 事件
    let dpr = dl.hwnd().map(window_scale).unwrap_or(dl_dpr);
    let margin = DRAG_LAYER_MARGIN * dpr;
    let _ = dl.emit(
        "drag-layer-show",
        serde_json::json!({ "note": note, "w": p.w, "h": p.h }),
    );
    if let Ok(hwnd) = dl.hwnd() {
        set_pos(
            hwnd,
            Some(HWND_TOP),
            (p.x - margin).round() as i32,
            (p.y - margin).round() as i32,
            (p.w + margin * 2.0).round() as i32,
            (p.h + margin * 2.0).round() as i32,
            SWP_NOACTIVATE,
        );
    }
    show_win_noactivate(&dl);
    let mut g = state.lock();
    g.drag_layer_shown = true;
    g.drag_src = Some(p.label.clone());
    g.store.ephemeral.dragging = Some(p.id.clone());
    drop(g);
    if let Some(src) = app.get_webview_window(&p.label) {
        let _ = src.emit("drag-layer-shown", ());
    }
}

pub fn handle_drag_move(app: &AppHandle, p: DragMovePayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let (shown, virtual_rect, dl_dpr) = {
        let g = state.lock();
        (g.drag_layer_shown, g.virtual_rect, g.drag_layer_dpr.unwrap_or(1.0))
    };
    if !shown {
        return;
    }
    let v = virtual_rect;
    let x = p.x.clamp(v.left as f64, (v.right as f64 - p.w).max(v.left as f64));
    let y = p.y.clamp(v.top as f64, (v.bottom as f64 - p.h).max(v.top as f64));
    if let Some(dl) = app.get_webview_window("drag-layer") {
        let dpr = dl.hwnd().map(window_scale).unwrap_or(dl_dpr);
        let margin = DRAG_LAYER_MARGIN * dpr;
        if let Ok(hwnd) = dl.hwnd() {
            set_pos(
                hwnd,
                None,
                (x - margin).round() as i32,
                (y - margin).round() as i32,
                (p.w + margin * 2.0).round() as i32,
                (p.h + margin * 2.0).round() as i32,
                SWP_NOACTIVATE | SWP_NOZORDER,
            );
        }
    }
}

pub fn handle_drag_end(app: &AppHandle, p: DragEndPayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let v = {
        let g = state.lock();
        g.virtual_rect
    };
    let x = p.x.clamp(v.left as f64, (v.right as f64 - p.w).max(v.left as f64));
    let y = p.y.clamp(v.top as f64, (v.bottom as f64 - p.h).max(v.top as f64));
    let mut g = state.lock();
    if let Some(n) = g.store.notes.iter_mut().find(|n| n.id == p.id) {
        n.x = x;
        n.y = y;
        n.w = p.w;
        n.h = p.h;
    }
    if let Some(pos) = g.store.notes.iter().position(|n| n.id == p.id) {
        let n = g.store.notes.remove(pos);
        g.store.notes.push(n);
    }
    g.store.ephemeral.dragging = None;
    let was_shown = g.drag_layer_shown;
    if was_shown {
        g.drag_layer_shown = false;
    }
    g.drag_src = None;
    drop(g);
    if was_shown {
        if let Some(dl) = app.get_webview_window("drag-layer") {
            hide_win(&dl);
        }
    }
    // 慢工作（hide_win）之后重建 payload：避免陈旧快照回退期间到达的动作
    let payload = {
        let g = state.lock();
        state_payload_inner(&g)
    };
    let _ = app.emit("state", payload);
}

pub fn handle_drag_cancel(app: &AppHandle, _p: LabelPayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let was_shown = {
        let mut g = state.lock();
        g.store.ephemeral.dragging = None;
        let was_shown = g.drag_layer_shown;
        g.drag_layer_shown = false;
        g.drag_src = None;
        was_shown
    };
    if was_shown {
        if let Some(dl) = app.get_webview_window("drag-layer") {
            hide_win(&dl);
        }
    }
    // 慢工作（hide_win）之后重建 payload：避免陈旧快照回退期间到达的动作
    let payload = {
        let g = state.lock();
        state_payload_inner(&g)
    };
    let _ = app.emit("state", payload);
}

pub fn handle_card_focus(app: &AppHandle, p: LabelPayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let prev = {
        let mut g = state.lock();
        let prev = g.editing.clone();
        g.editing = Some(p.label.clone());
        g.editing_since = Some(std::time::Instant::now());
        prev
    };
    // 锁外：跨画布切换编辑先失活旧窗口，再激活新窗口（激活可能阻塞）
    if let Some(prev) = prev {
        if prev != p.label {
            if let Some(w) = app.get_webview_window(&prev) {
                deactivate_editing(&w);
            }
        }
    }
    if let Some(w) = app.get_webview_window(&p.label) {
        activate_editing(&w);
    }
    // 慢工作之后重建 payload：避免陈旧快照回退期间到达的动作
    let payload = {
        let g = state.lock();
        state_payload_inner(&g)
    };
    let _ = app.emit("state", payload);
}

pub fn handle_card_blur(app: &AppHandle, p: LabelPayload) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let matched = {
        let mut g = state.lock();
        if g.editing.as_deref() == Some(p.label.as_str()) {
            g.editing = None;
            g.editing_since = None;
            true
        } else {
            false
        }
    };
    if matched {
        if let Some(w) = app.get_webview_window(&p.label) {
            deactivate_editing(&w);
        }
        // 慢工作（deactivate_editing）之后重建 payload：
        // 此前在锁内快照 payload 再慢工作后 emit，会把期间到达的动作（如 editText
        // 提交）用旧快照回退 UI——冒烟编辑测试偶发超时的根因（B3）
        let payload = {
            let g = state.lock();
            state_payload_inner(&g)
        };
        let _ = app.emit("state", payload);
    }
}

pub fn handle_rebuild(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return;
    };
    let now = enumerate_monitors(); // 锁外枚举（R2）
    let (monitors, primary, was_drag_shown) = {
        let mut g = state.lock();
        g.monitors = now;
        g.virtual_rect = virtual_bounds(&g.monitors);
        g.primary = g.monitors.iter().position(|m| m.primary).unwrap_or(0);
        g.fullscreen_hidden = vec![false; g.monitors.len()];
        g.editing = None;
        let was = g.drag_layer_shown;
        g.drag_layer_shown = false;
        (g.monitors.clone(), g.primary, was)
    };
    drop_and_rebuild(app, &monitors, primary, was_drag_shown);
    let mut g = state.lock();
    g.sidebar_rect = monitors.get(primary).map(sidebar_physical_rect);
    let payload = state_payload_inner(&g);
    drop(g);
    let _ = app.emit("state", payload);
}

/// 锁外重建窗口（拓扑变化 / 手动重建共用；重建前先隐藏拖拽层）
fn drop_and_rebuild(app: &AppHandle, monitors: &[MonitorSlot], primary: usize, was_drag_shown: bool) {
    if was_drag_shown {
        if let Some(dl) = app.get_webview_window("drag-layer") {
            hide_win(&dl);
        }
    }
    rebuild_windows(app, monitors, primary);
}

/// 存储 listen 返回的 EventId（防止监听器被注销）
pub fn push_event_id(app: &AppHandle, id: tauri::EventId) {
    if let Some(state) = app.try_state::<Arc<AppLock>>() {
        let mut g = state.lock();
        g.event_ids.push(id);
    }
}

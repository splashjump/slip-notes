//! 带诊断的互斥锁：记录锁持有线程（thread name），锁等待超阈值时输出线索。
//! 背景：Win32 窗口调用（SetWindowPos/ShowWindow/SetWindowRgn）必须离开锁执行，
//! 否则 DWM 卡顿会饿死所有动作命令——本模块用于第一时间暴露这类问题。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use crate::canvas::AppState;

/// 线程 id → 名字注册表（诊断用；id 由 NAME_COUNTER 分配，0 = 未注册）
static THREAD_NAMES: LazyLock<Mutex<HashMap<u64, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NAME_COUNTER: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static MY_ID: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// 注册当前线程名（返回分配的诊断 id）
pub fn register_thread_name(name: &str) -> u64 {
    let id = NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    MY_ID.with(|v| v.set(id));
    if let Ok(mut m) = THREAD_NAMES.lock() {
        m.insert(id, name.to_string());
    }
    id
}

fn my_id() -> u64 {
    MY_ID.with(|v| v.get())
}

fn thread_name(id: u64) -> String {
    if id == 0 {
        return "（未注册线程）".into();
    }
    THREAD_NAMES
        .lock()
        .ok()
        .and_then(|m| m.get(&id).cloned())
        .unwrap_or_else(|| format!("thread#{id}"))
}

pub struct AppLock {
    inner: Mutex<AppState>,
    holder: AtomicU64,
    wait_warn_ms: u64,
    holder_since: AtomicU64, // epoch ms
    hold_warn_ms: u64,       // 同一线程持锁超过该值 → monitor 告警
    holder_bt: Mutex<Option<String>>, // 持锁时捕获的调用栈（定位卡死点）
}

pub struct AppGuard<'a> {
    guard: MutexGuard<'a, AppState>,
    lock: &'a AppLock,
}

impl<'a> std::ops::Deref for AppGuard<'a> {
    type Target = AppState;
    fn deref(&self) -> &AppState {
        &self.guard
    }
}

impl<'a> std::ops::DerefMut for AppGuard<'a> {
    fn deref_mut(&mut self) -> &mut AppState {
        &mut self.guard
    }
}

impl<'a> Drop for AppGuard<'a> {
    fn drop(&mut self) {
        self.lock.holder.store(0, Ordering::Relaxed);
        self.lock.holder_since.store(0, Ordering::Relaxed);
        if let Ok(mut b) = self.lock.holder_bt.lock() {
            *b = None;
        }
    }
}

impl AppLock {
    pub fn new(s: AppState) -> Self {
        AppLock {
            inner: Mutex::new(s),
            holder: AtomicU64::new(0),
            wait_warn_ms: 2000,
            holder_since: AtomicU64::new(0),
            hold_warn_ms: 10000,
            holder_bt: Mutex::new(None),
        }
    }

    /// 锁监控线程：同一线程持锁超过 hold_warn_ms → 告警（定位持锁卡死）
    pub fn start_monitor(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::Builder::new()
            .name("lock-monitor".into())
            .spawn(move || {
                crate::lock::register_thread_name("lock-monitor");
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let holder = me.holder.load(Ordering::Relaxed);
                    if holder == 0 {
                        continue;
                    }
                    let since = me.holder_since.load(Ordering::Relaxed);
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    let held_ms = now.saturating_sub(since);
                    if held_ms > me.hold_warn_ms {
                        let bt = me
                            .holder_bt
                            .lock()
                            .ok()
                            .and_then(|b| b.clone())
                            .unwrap_or_else(|| "（无栈）".into());
                        log::warn!(
                            "[lock-monitor] 锁被 {}（{}）持续持有 {}s！疑似卡死
持锁栈：
{}",
                            holder,
                            thread_name(holder),
                            held_ms / 1000,
                            bt
                        );
                    }
                }
            })
            .ok();
    }

    pub fn lock(&self) -> AppGuard<'_> {
        let t0 = std::time::Instant::now();
        let guard = match self.inner.try_lock() {
            Ok(g) => g,
            Err(_) => {
                let holder = self.holder.load(Ordering::Relaxed);
                log::warn!(
                    "[lock] 锁被占用：holder={}（{}），等待中…",
                    holder,
                    thread_name(holder)
                );
                match self.inner.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        log::error!("[lock] 锁损坏: {e}");
                        panic!("AppState 锁损坏: {e}");
                    }
                }
            }
        };
        let held = self.holder.load(Ordering::Relaxed);
        if held != 0 && t0.elapsed().as_millis() as u64 > self.wait_warn_ms {
            log::warn!(
                "[lock] 等了 {}ms 才拿到（之前被 {}（{}）持有）",
                t0.elapsed().as_millis(),
                held,
                thread_name(held)
            );
        }
        let id = my_id();
        self.holder.store(id, Ordering::Relaxed);
        // 记录持锁调用栈（仅 dev；定位卡死点；release 零开销——G3）
        #[cfg(debug_assertions)]
        let bt = std::backtrace::Backtrace::force_capture()
            .to_string()
            .lines()
            .take(14)
            .collect::<Vec<_>>()
            .join("\n");
        #[cfg(not(debug_assertions))]
        let bt = String::from("（release 构建不采集）");
        if let Ok(mut b) = self.holder_bt.lock() {
            *b = Some(bt);
        }
        self.holder_since.store(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            Ordering::Relaxed,
        );
        AppGuard { guard, lock: self }
    }
}

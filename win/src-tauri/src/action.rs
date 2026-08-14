//! 动作层 —— 唯一数据入口（FORM-PLAN §5）
//!
//! IPC: invoke("action", { name, args, batch?, author? }) → ActionResponse
//! 手势与 AI 指令同构：任务三 local API(60000) = HTTP 薄包装本模块。
//! UI 动作（expand/collapse/view/confirm）走同一入口但只影响窗口/视图态，不进 journal。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::canvas::{self, AppState, MonitorSlot, ViewInfo};
use crate::lock::AppLock;
use crate::store::{self, JournalMeta, Note, Store};

// ---------------------------------------------------------------------------
// IPC 形状
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ActionRequest {
    pub name: String,
    pub args: serde_json::Value,
    #[serde(default)]
    pub batch: Option<String>,
    #[serde(default)]
    pub author: Option<String>, // "ui"（默认）| "ai"
}

#[derive(Serialize)]
pub struct ActionResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<Note>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal: Option<JournalMeta>,
}

fn err(e: String) -> ActionResponse {
    ActionResponse {
        ok: false,
        notes: None,
        error: Some(e),
        journal: None,
    }
}

// ---------------------------------------------------------------------------
// 几何（AI 方向移动复用 resolveDropRegion；常量与前端 geom.ts 对齐）
// ---------------------------------------------------------------------------

pub const SIDEBAR_W_CSS: f64 = 270.0;
pub const PORTAL_BAND_H_CSS: f64 = 96.0;
pub const PORTAL_SLOT_W_CSS: f64 = 210.0;
pub const PORTAL_SLOT_H_CSS: f64 = 56.0;
pub const PORTAL_GAP_CSS: f64 = 16.0;
pub const PORTAL_PAD_X_CSS: f64 = 14.0;
/// 光带总宽（含左右 padding 14×2；CSS .portal box-sizing:border-box，与 geom.ts 对齐）
pub const PORTAL_TOTAL_W_CSS: f64 = PORTAL_SLOT_W_CSS * 3.0 + PORTAL_GAP_CSS * 2.0 + PORTAL_PAD_X_CSS * 2.0; // 690
/// 传送门光带距屏底偏移（与 CSS .portal { bottom: 14px } 对齐；Y4）
pub const PORTAL_BOTTOM_OFFSET_CSS: f64 = 14.0;

fn scale(m: &MonitorSlot) -> f64 {
    m.dpi as f64 / 96.0
}

/// 显示器上居中的传送门光带（物理坐标；底部距屏底 PORTAL_BOTTOM_OFFSET_CSS）
pub fn portal_band(m: &MonitorSlot) -> (f64, f64, f64, f64) {
    let s = scale(m);
    let w = PORTAL_TOTAL_W_CSS * s;
    let h = PORTAL_BAND_H_CSS * s;
    let x = (m.rect.left as f64 + m.rect.right as f64) / 2.0 - w / 2.0;
    let y = m.rect.bottom as f64 - PORTAL_BOTTOM_OFFSET_CSS * s - h;
    (x, y, w, h)
}

pub fn portal_slots(m: &MonitorSlot) -> [(f64, f64, f64, f64); 3] {
    let s = scale(m);
    let (bx, by, _, bh) = portal_band(m);
    let y = by + (bh - PORTAL_SLOT_H_CSS * s) / 2.0;
    let mut out = [(0.0, 0.0, 0.0, 0.0); 3];
    for i in 0..3 {
        let x = bx + (PORTAL_PAD_X_CSS + i as f64 * (PORTAL_SLOT_W_CSS + PORTAL_GAP_CSS)) * s;
        out[i] = (x, y, PORTAL_SLOT_W_CSS * s, PORTAL_SLOT_H_CSS * s);
    }
    out
}

/// 几何快照（dispatch 内锁定一次后传入，避免重复加锁/死锁）
pub struct Geo {
    pub monitors: Vec<crate::canvas::MonitorSlot>,
    pub sidebar: Option<(f64, f64, f64, f64)>,
}

impl Geo {
    pub fn from_state(g: &AppState) -> Self {
        Geo {
            monitors: g.monitors.clone(),
            sidebar: g.sidebar_rect,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum DropRegion {
    Desk,
    Dock,
    Portal(usize),
}

/// 落点解析（按中心归属；dock > portal 优先级，角落冲突消解）
pub fn resolve_drop(geo: &Geo, cx: f64, cy: f64, view_open: bool) -> DropRegion {
    if let Some(sb) = geo.sidebar {
        if cx >= sb.0 && cx <= sb.0 + sb.2 && cy >= sb.1 && cy <= sb.1 + sb.3 {
            return DropRegion::Dock;
        }
    }
    if !view_open {
        for m in &geo.monitors {
            let (bx, by, bw, bh) = portal_band(m);
            if cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh {
                let slots = portal_slots(m);
                for (i, (sx, _, sw, _)) in slots.iter().enumerate() {
                    if cx >= *sx && cx <= *sx + sw {
                        return DropRegion::Portal(i);
                    }
                }
            }
        }
    }
    DropRegion::Desk
}

/// 本地时区偏差（分钟，UTC = 本地 + bias；Windows 时区 API）
fn local_bias_minutes() -> i64 {
    use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    let mut tz = TIME_ZONE_INFORMATION::default();
    unsafe {
        if GetTimeZoneInformation(&mut tz) != u32::MAX {
            return tz.Bias as i64
                + if tz.DaylightBias != 0 && tz.DaylightDate.wMonth != 0 {
                    tz.DaylightBias as i64
                } else {
                    0
                };
        }
    }
    0 // 失败回退 UTC
}

/// 本地“当日 0 点”epoch ms（与前端 local 时区语义对齐；Y3 修复：不再用 UTC 日界）
fn local_day_start(now: i64) -> i64 {
    let bias_ms = local_bias_minutes() * 60_000;
    let local = now - bias_ms; // 转成假 UTC（以本地日界对齐）
    local - local.rem_euclid(86_400_000)
}

/// 定时标记默认值：今天 18:00（已过 → 明天 10:00），与前端 chips 默认一致
pub fn default_timed(now: i64) -> i64 {
    let day = 86_400_000i64;
    let today_18 = local_day_start(now) + 18 * 3600_000;
    if today_18 > now {
        today_18
    } else {
        local_day_start(now) + day + 10 * 3600_000
    }
}

// ---------------------------------------------------------------------------
// 动作分发
// ---------------------------------------------------------------------------

pub fn dispatch(app: &AppHandle, req: ActionRequest) -> ActionResponse {
    log::info!("[action] 进入 {}", req.name);
    let Some(state) = app.try_state::<Arc<AppLock>>() else {
        return err("应用状态未就绪".into());
    };
    // 几何快照（一次锁定取用；data() 内不再加锁，避免自死锁）
    let geo0 = {
        let g = state.lock();
        Geo::from_state(&g)
    };
    let author = req.author.clone().unwrap_or_else(|| "ui".into());
    // batch 可经 req.batch 或 args.__batch 传递（前端便捷包装用后者）；
    // 提取后从 args 剥离，避免 __batch 噪音进 journal（G9）
    let batch = req
        .batch
        .clone()
        .or_else(|| req.args.get("__batch").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| format!("b{}", store::now_ms()));
    let name = req.name.clone();
    let mut args = req.args.clone();
    if let Some(obj) = args.as_object_mut() {
        obj.remove("__batch");
    }

    let result = match name.as_str() {
        // ---------------- 数据动作（journal 记录） ----------------
        "create" => data(app, &state, author, batch, name, args, |s, a| {
            let x = a.get("x").and_then(|v| v.as_f64());
            let y = a.get("y").and_then(|v| v.as_f64());
            let (px, py) = match (x, y) {
                (Some(x), Some(y)) => (x, y),
                _ => desk_spawn_pos(&geo0, s),
            };
            let text = a
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let color = a
                .get("color")
                .and_then(|v| v.as_str())
                .unwrap_or("#fff3b0")
                .to_string();
            let n = s.create(&text, &color, px, py);
            Ok(vec![n.id])
        }),
        "editText" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            let text = str_arg(a, "text")?;
            s.edit_text(&id, &text)?;
            Ok(vec![id])
        }),
        "check" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            let item = str_arg(a, "itemId")?;
            let done = a.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
            s.check(&id, &item, done)?;
            Ok(vec![id])
        }),
        "move" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            // 方向语义：沿方向找最近区域反查落点（复用 resolveDropRegion）
            if let Some(dir) = a.get("direction").and_then(|v| v.as_str()) {
                let now = s.now();
                let (nx, ny, w, h) = {
                    let n = s.note(&id).ok_or("便签不存在")?;
                    (n.x, n.y, n.w, n.h)
                };
                let m = geo0.monitors.iter().find(|m| {
                    nx >= m.rect.left as f64 && nx < m.rect.right as f64
                        && ny >= m.rect.top as f64 && ny < m.rect.bottom as f64
                });
                let step = store::DIR_STEP * m.map(|m| scale(m)).unwrap_or(1.0);
                let (tx, ty) = match dir {
                    "left" => (nx - step, ny),
                    "right" => (nx + step, ny),
                    "up" => (nx, ny - step),
                    "down" => (nx, ny + step),
                    _ => return Err(format!("未知方向 {dir}")),
                };
                let cx = tx + w / 2.0;
                let cy = ty + h / 2.0;
                match resolve_drop(&geo0, cx, cy, s.ephemeral.borrowing.len() > 0) {
                    DropRegion::Dock => {
                        s.store(&id, None)?;
                        Ok(vec![id])
                    }
                    DropRegion::Portal(slot) => match slot {
                        0 => {
                            s.tag(&id, "urgent", serde_json::json!(true))?;
                            Ok(vec![id])
                        }
                        1 => {
                            s.tag(&id, "timed", serde_json::json!(default_timed(now)))?;
                            Ok(vec![id])
                        }
                        _ => {
                            // 📄 清全部 = 两次 tag 调用
                            s.tag(&id, "urgent", serde_json::json!(false))?;
                            s.tag(&id, "timed", serde_json::Value::Null)?;
                            Ok(vec![id])
                        }
                    },
                    DropRegion::Desk => {
                        s.move_note(&id, tx, ty)?;
                        Ok(vec![id])
                    }
                }
            } else {
                let x = a.get("x").and_then(|v| v.as_f64()).ok_or("缺少 x")?;
                let y = a.get("y").and_then(|v| v.as_f64()).ok_or("缺少 y")?;
                s.move_note(&id, x, y)?;
                Ok(vec![id])
            }
        }),
        "take" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            let (x, y) = match (a.get("x").and_then(|v| v.as_f64()), a.get("y").and_then(|v| v.as_f64())) {
                (Some(x), Some(y)) => (x, y),
                _ => take_default_pos(&geo0, s, &id),
            };
            s.take(&id, x, y)?;
            Ok(vec![id])
        }),
        "store" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            let index = a.get("index").and_then(|v| v.as_u64()).map(|v| v as usize);
            s.store(&id, index)?;
            Ok(vec![id])
        }),
        "joinSlot" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            let slot = str_arg(a, "slotId")?;
            s.join_slot(&id, &slot)?;
            Ok(vec![id])
        }),
        "storeSlot" => data(app, &state, author, batch, name, args, |s, a| {
            let ids = str_list_arg(a, "ids")?;
            s.store_slot(&ids)?;
            Ok(ids)
        }),
        "archiveAll" => data(app, &state, author, batch, name, args, |s, _| {
            Ok(s.archive_all())
        }),
        "tag" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            let tag = str_arg(a, "tag")?;
            let v = a.get("v").cloned().unwrap_or(serde_json::Value::Null);
            s.tag(&id, &tag, v)?;
            Ok(vec![id])
        }),
        "stack" => data(app, &state, author, batch, name, args, |s, a| {
            let ids = str_list_arg(a, "ids")?;
            let x = a.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = a.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            s.stack(&ids, x, y)?;
            Ok(ids)
        }),
        "unstack" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            s.unstack(&id)?;
            Ok(vec![id])
        }),
        "merge" => data(app, &state, author, batch, name, args, |s, a| {
            let ids = str_list_arg(a, "ids")?;
            let x = a.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = a.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let n = s.merge(&ids, x, y)?;
            // 撕裂方向：row = 左右分 / col = 上下分（停靠点决定；默认 grid）
            if let Some(dir) = a.get("dir").and_then(|v| v.as_str()) {
                s.set_merge_dir(&n.id, dir)?;
            }
            Ok(vec![n.id])
        }),
        "unmerge" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            let out = s.unmerge(&id)?;
            Ok(out.iter().map(|n| n.id.clone()).collect())
        }),
        "reorder" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            let to = a.get("toIndex").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            s.reorder(&id, to)?;
            Ok(vec![id])
        }),
        "delete" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            s.delete(&id)?;
            Ok(vec![id])
        }),
        "restore" => data(app, &state, author, batch, name, args, |s, a| {
            let id = str_arg(a, "id")?;
            s.restore(&id)?;
            Ok(vec![id])
        }),
        "undoBatch" => data(app, &state, author, batch, name, args, |s, a| {
            let batch = str_arg(a, "batchId")?;
            s.undo_batch(&batch)?;
            Ok(Vec::new())
        }),

        // ---------------- UI 动作（纯本地，不进 journal） ----------------
        "confirm" => ui(&state, |s| {
            let id = str_arg(&args, "id")?;
            s.store.confirm(&id);
            Ok(Vec::new())
        }),
        "expand" => ui(&state, |s| {
            s.sidebar_collapsed = false;
            Ok(Vec::new())
        }),
        "collapse" => ui(&state, |s| {
            s.sidebar_collapsed = true;
            Ok(Vec::new())
        }),
        "view" => view_action(app, &state, args),
        "toggleConsole" => {
            // ⚠️ 锁内只翻转状态；show/hide（tauri API，可能阻塞等主线程）锁外执行
            let visible = {
                let mut g = state.lock();
                g.console_visible = !g.console_visible;
                g.console_visible
            };
            if let Some(w) = app.get_webview_window("main") {
                if visible {
                    let _ = w.show();
                } else {
                    let _ = w.hide();
                }
            }
            Ok(Vec::new())
        }

        // ---------------- 调试（T3：时间快进 / 手动触发自动收回） ----------------
        "debug.fastForward" => ui(&state, |s| {
            let days = args.get("days").and_then(|v| v.as_i64()).unwrap_or(1);
            s.store.fast_forward(days);
            Ok(s.store.auto_archive())
        }),
        "debug.autoArchive" => ui(&state, |s| Ok(s.store.auto_archive())),
        "debug.reset" => ui(&state, |s| {
            s.store.reset();
            Ok(Vec::new())
        }),

        other => return err(format!("未知动作 {other}")),
    };

    let _ = app; // 上面分支已使用
    let resp = match result {
        Ok(notes) => {
            log::info!("[action] {} → 锁 state（响应段）", req.name);
            let payload = {
                let g = state.lock();
                g.state_payload(app)
            };
            log::info!("[action] {} → emit state", req.name);
            let _ = app.emit("state", payload);
            log::info!("[action] {} → 锁 state（journal）", req.name);
            let journal = {
                let g = state.lock();
                g.store.journal.last().map(|e| e.meta.clone())
            };
            ActionResponse {
                ok: true,
                notes: Some(notes),
                error: None,
                journal,
            }
        }
        Err(e) => err(e),
    };
    log::info!("[action] 完成 {}", req.name);
    resp
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

fn str_arg(a: &serde_json::Value, k: &str) -> Result<String, String> {
    a.get(k)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("缺少参数 {k}"))
}

fn str_list_arg(a: &serde_json::Value, k: &str) -> Result<Vec<String>, String> {
    a.get(k)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .ok_or_else(|| format!("缺少参数 {k}"))
}

/// 数据动作统一包装：journal 记录 + 返回变更便签
fn data<F>(
    app: &AppHandle,
    state: &Arc<AppLock>,
    author: String,
    batch: String,
    name: String,
    args: serde_json::Value,
    f: F,
) -> Result<Vec<Note>, String>
where
    F: FnOnce(&mut Store, &serde_json::Value) -> Result<Vec<String>, String>,
{
    let mut g = state.lock();
    let seq = g.store.next_seq();
    let meta = JournalMeta {
        seq,
        batch,
        author,
        name: name.clone(),
        args: args.clone(),
        time: g.store.now(),
    };
    let changed = g
        .store
        .record(meta, |s| f(s, &args))
        .map_err(|e| format!("{name}: {e}"))?;
    let notes: Vec<Note> = changed
        .iter()
        .filter_map(|id| g.store.note(id).cloned())
        .collect();
    let _ = app;
    Ok(notes)
}

fn ui<F>(state: &Arc<AppLock>, f: F) -> Result<Vec<Note>, String>
where
    F: FnOnce(&mut AppState) -> Result<Vec<String>, String>,
{
    let mut g = state.lock();
    let changed = f(&mut g)?;
    Ok(changed
        .iter()
        .filter_map(|id| g.store.note(id).cloned())
        .collect())
}

/// view 开/关：画布窗口抬升（SWP_NOACTIVATE + Rgn 全屏）+ borrowing 借用态
/// ⚠️ 锁内只改数据；抬升/压回（tauri API + Win32，可能阻塞）一律锁外执行
fn view_action(
    app: &AppHandle,
    state: &Arc<AppLock>,
    args: serde_json::Value,
) -> Result<Vec<Note>, String> {
    let name = str_arg(&args, "name")?;
    if name != "recent" && name != "timeline" {
        return Err(format!("未知视图 {name}"));
    }
    let open = args.get("open").and_then(|v| v.as_bool()).unwrap_or(true);
    let label = {
        let mut g = state.lock();
        if open {
            if g.view.is_some() {
                return Err("已有视图打开".into());
            }
            let label = canvas::canvas_label(g.primary);
            let borrow: Vec<String> = g
                .store
                .notes
                .iter()
                .filter(|n| n.is_desk())
                .map(|n| n.id.clone())
                .collect();
            g.store.ephemeral.borrowing = borrow;
            g.view = Some(ViewInfo { name, label: label.clone() });
            Some(label)
        } else {
            let v = g.view.take();
            g.store.ephemeral.borrowing.clear();
            v.map(|v| v.label)
        }
    };
    // 锁外：窗口抬升/压回。关闭 = 前端先播放收回动画（遮罩淡出 + FLIP 飞回），
    // 动画完成发 view-anim-done 再压回窗口（此前先压回再播放，动画被遮挡基本不可见）；
    // defer_lower 带 3s 超时兜底，前端异常也不残留抬升态。
    if let Some(label) = label {
        if open {
            canvas::raise_for_view(app, &label);
        } else {
            canvas::defer_lower(app, &label);
        }
    }
    Ok(Vec::new())
}

/// 新建落点：主屏桌面空白（避开传送门光带 + 已占用卡位），级联偏移
fn desk_spawn_pos(geo: &Geo, s: &Store) -> (f64, f64) {
    let Some(sb) = geo.sidebar else {
        return (180.0, 120.0);
    };
    // 边栏左侧、避开底部光带；级联偏移避免重叠，且跳过已占用的位置（G10）
    let x0 = (sb.0 - store::CARD_W - 60.0).max(120.0);
    for i in 0..12 {
        let cand = (x0, 100.0 + 36.0 * (i as f64));
        let free = !s
            .notes
            .iter()
            .any(|n| n.is_desk() && (n.x - cand.0).abs() < store::CARD_W * 0.5 && (n.y - cand.1).abs() < store::CARD_H * 0.5);
        if free {
            return cand;
        }
    }
    (x0, 100.0 + 36.0 * (s.notes.len() as f64 % 8.0))
}

/// take 默认落点：lastDeskPos / 边栏左侧空白
fn take_default_pos(geo: &Geo, s: &Store, id: &str) -> (f64, f64) {
    if let Some(n) = s.note(id) {
        if let Some([x, y, ..]) = n.last_desk_pos {
            return (x, y);
        }
    }
    let sb = geo.sidebar.unwrap_or((0.0, 0.0, 0.0, 0.0));
    let x = sb.0 - store::CARD_W - 40.0;
    let y = 80.0 + 30.0 * (s.notes.len() % 6) as f64;
    (x, y)
}

mod action;
mod canvas;
mod lock;
mod store;

use tauri::Listener;
use tauri_plugin_log::{Target, TargetKind};

fn bind_events(app: &tauri::AppHandle) {
    macro_rules! bind {
        ($name:literal, $ty:ty, $handler:expr) => {{
            let h = app.clone();
            let id = app.listen($name, move |e| {
                if let Ok(p) = serde_json::from_str::<$ty>(e.payload()) {
                    $handler(&h, p);
                } else {
                    log::warn!("[slip] {} 解析失败", $name);
                }
            });
            canvas::push_event_id(app, id);
        }};
    }
    bind!("canvas-init", canvas::CanvasInitPayload, canvas::handle_canvas_init);
    bind!("update-regions", canvas::UpdateRegionsPayload, canvas::handle_update_regions);
    bind!("drag-layer-ready", canvas::DragLayerReadyPayload, canvas::handle_drag_layer_ready);
    bind!("drag-start", canvas::DragStartPayload, canvas::handle_drag_start);
    bind!("drag-move", canvas::DragMovePayload, canvas::handle_drag_move);
    // 注：drag-end 已改走同步 invoke("drag_end")（保证动作顺序），不再经事件双通道（G1）
    bind!("drag-cancel", canvas::LabelPayload, canvas::handle_drag_cancel);
    bind!("card-focus", canvas::LabelPayload, canvas::handle_card_focus);
    bind!("card-blur", canvas::LabelPayload, canvas::handle_card_blur);
    let h = app.clone();
    let id = app.listen("rebuild-canvases", move |_| {
        canvas::handle_rebuild(&h);
    });
    canvas::push_event_id(app, id);
}

/// 动作层唯一入口（FORM-PLAN §5）：手势与 AI 指令同构
#[tauri::command]
fn action(app: tauri::AppHandle, req: action::ActionRequest) -> action::ActionResponse {
    action::dispatch(&app, req)
}

/// 拖拽结束（同步版 drag-end 事件）：先更新坐标再回执，保证后续动作顺序
#[tauri::command]
fn drag_end(app: tauri::AppHandle, p: canvas::DragEndPayload) {
    canvas::handle_drag_end(&app, p);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![action, drag_end])
        .setup(|app| {
            let handle = app.handle().clone();
            canvas::setup(&handle);
            bind_events(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

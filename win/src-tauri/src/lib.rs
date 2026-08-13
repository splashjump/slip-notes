mod canvas;

use tauri::Listener;
use tauri_plugin_log::{Target, TargetKind};

fn bind_events(app: &tauri::AppHandle) {
    let h = app.clone();
    let id = app.listen("canvas-init", move |e| {
        log::info!("[spike] canvas-init 原始事件: {}", e.payload());
        if let Ok(p) = serde_json::from_str::<canvas::CanvasInitPayload>(e.payload()) {
            canvas::handle_canvas_init(&h, p);
        } else {
            log::warn!("[spike] canvas-init 解析失败");
        }
    });
    canvas::push_event_id(app, id);
    let h = app.clone();
    let id = app.listen("update-regions", move |e| {
        if let Ok(p) = serde_json::from_str::<canvas::UpdateRegionsPayload>(e.payload()) {
            canvas::handle_update_regions(&h, p);
        }
    });
    canvas::push_event_id(app, id);
    let h = app.clone();
    let id = app.listen("drag-start", move |e| {
        if let Ok(p) = serde_json::from_str::<canvas::LabelPayload>(e.payload()) {
            canvas::handle_drag_start(&h, p);
        }
    });
    canvas::push_event_id(app, id);
    let h = app.clone();
    let id = app.listen("drag-end", move |e| {
        if let Ok(p) = serde_json::from_str::<canvas::DragEndPayload>(e.payload()) {
            canvas::handle_drag_end(&h, p);
        }
    });
    canvas::push_event_id(app, id);
    let h = app.clone();
    let id = app.listen("card-focus", move |e| {
        if let Ok(p) = serde_json::from_str::<canvas::LabelPayload>(e.payload()) {
            canvas::handle_card_focus(&h, p);
        }
    });
    canvas::push_event_id(app, id);
    let h = app.clone();
    let id = app.listen("card-blur", move |e| {
        if let Ok(p) = serde_json::from_str::<canvas::LabelPayload>(e.payload()) {
            canvas::handle_card_blur(&h, p);
        }
    });
    canvas::push_event_id(app, id);
    let h = app.clone();
    let id = app.listen("rebuild-canvases", move |_| {
        canvas::handle_rebuild(&h);
    });
    canvas::push_event_id(app, id);
    let h = app.clone();
    let id = app.listen("reset-notes", move |_| {
        canvas::handle_reset_notes(&h);
    });
    canvas::push_event_id(app, id);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            canvas::setup(&handle);
            bind_events(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

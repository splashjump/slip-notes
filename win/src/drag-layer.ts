// 拖拽层窗口：拖动期间显示被拖便签的副本（跟随鼠标、z-order 最顶）。
// 画布窗口（canvas-*）拖动期间完全不动 → 其他便签保持在桌面层，
// 只有被拖的便签通过本窗口"浮"在所有普通窗口之上。
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { buildCard, type Note } from "./card";

// 卡片阴影边距（CSS px），与 Rust 侧 create_drag_layer/handle_drag_start 的 MARGIN 一致
const MARGIN = 30;

interface DragLayerShow {
  note: Note;
  w: number; // 物理 px（卡片内容宽）
  h: number; // 物理 px
}

const win = getCurrentWindow();
const root = document.getElementById("canvas-root") as HTMLElement;

async function init() {
  await listen<DragLayerShow>("drag-layer-show", async (e) => {
    const { note, w, h } = e.payload;
    const dpr = window.devicePixelRatio || 1;
    // 窗口尺寸 = 卡片 + 阴影边距（物理 px；按本窗口 DPR 换算）
    const winW = Math.round(w + MARGIN * 2 * dpr);
    const winH = Math.round(h + MARGIN * 2 * dpr);
    const cur = await win.outerSize();
    if (cur.width !== winW || cur.height !== winH) {
      await win.setSize(new PhysicalSize(winW, winH));
    }
    // 卡片左上角固定 (MARGIN, MARGIN)（CSS px）
    root.innerHTML = "";
    const el = buildCard(note, {
      left: MARGIN,
      top: MARGIN,
      width: w / dpr,
      height: h / dpr,
    });
    root.appendChild(el);
  });
  // 告知 Rust：拖拽层页面已就绪，可安全显示（未就绪时拖动走降级路径）
  void emit("drag-layer-ready", { dpr: window.devicePixelRatio || 1 });
}

void init();

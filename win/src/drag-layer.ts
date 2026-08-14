// 拖拽层窗口：拖动期间显示被拖便签的副本（跟随鼠标、z-order 最顶）
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { buildCard } from "./card";
import type { Note } from "./state";

const MARGIN = 30; // 与 Rust DRAG_LAYER_MARGIN 一致

interface DragLayerShow {
  note: Note;
  w: number; // 物理 px
  h: number;
}

const win = getCurrentWindow();
const root = document.getElementById("canvas-root") as HTMLElement;

async function init() {
  await listen<DragLayerShow>("drag-layer-show", async (e) => {
    const { note, w, h } = e.payload;
    const dpr = window.devicePixelRatio || 1;
    const winW = Math.round(w + MARGIN * 2 * dpr);
    const winH = Math.round(h + MARGIN * 2 * dpr);
    const cur = await win.outerSize();
    if (cur.width !== winW || cur.height !== winH) {
      await win.setSize(new PhysicalSize(winW, winH));
    }
    root.innerHTML = "";
    const el = buildCard(
      note,
      { left: MARGIN, top: MARGIN, width: w / dpr, height: h / dpr },
      { noShadow: false },
    );
    root.appendChild(el);
  });
  void emit("drag-layer-ready", { dpr: window.devicePixelRatio || 1 });
}

void init();

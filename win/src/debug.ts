// 调试台：显示画布状态 + 控制按钮
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface State {
  monitors: { rect: number[]; dpi: number }[];
  virtualRect: number[];
  editing: string | null;
  fullscreenHidden: string[];
  notes: { id: string; x: number; y: number; w: number; h: number }[];
}

const monitorsEl = document.getElementById("monitors") as HTMLElement;
const notesEl = document.getElementById("notes") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;

function fmtRect(r: number[]) {
  return `${r[2] - r[0]}×${r[3] - r[1]} @ (${r[0]}, ${r[1]})`;
}

function render(s: State) {
  monitorsEl.textContent = s.monitors
    .map(
      (m, i) =>
        `canvas-${i}: ${fmtRect(m.rect)}  dpi=${m.dpi}  scale=${(m.dpi / 96).toFixed(2)}x`,
    )
    .join("\n");
  notesEl.textContent = s.notes
    .map(
      (n) =>
        `${n.id}: (${Math.round(n.x)}, ${Math.round(n.y)}) ${Math.round(n.w)}×${Math.round(n.h)}`,
    )
    .join("\n");
  statusEl.textContent = [
    `虚拟屏: ${fmtRect(s.virtualRect)}`,
    `编辑中: ${s.editing ?? "无"}`,
    `全屏隐藏: ${s.fullscreenHidden.length ? s.fullscreenHidden.join(", ") : "无"}`,
  ].join("\n");
}

async function init() {
  await listen<State>("state-updated", (e) => render(e.payload));
  document.getElementById("btn-rebuild")?.addEventListener("click", () => {
    void emit("rebuild-canvases");
  });
  document.getElementById("btn-reset")?.addEventListener("click", () => {
    void emit("reset-notes");
  });
  document.getElementById("btn-minimize-debug")?.addEventListener("click", () => {
    // 用最小化而不是隐藏：隐藏后没有任何入口能恢复调试台
    void getCurrentWindow().minimize();
  });

}

void init();

import { getCurrentWindow } from "@tauri-apps/api/window";

const label = getCurrentWindow().label;

if (label.startsWith("canvas-")) {
  document.body.classList.add("canvas");
  import("./canvas");
} else if (label === "drag-layer") {
  document.body.classList.add("canvas");
  import("./drag-layer");
} else {
  document.body.classList.add("debug");
  import("./debug");
}

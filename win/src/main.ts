import { getCurrentWindow } from "@tauri-apps/api/window";
import { getState } from "./state";

const label = getCurrentWindow().label;

if (label.startsWith("canvas-")) {
  document.body.classList.add("canvas");
  document.title = `slip-canvas-${label.slice("canvas-".length)}`;
  import("./canvas");
} else if (label === "sidebar") {
  document.body.classList.add("sidebar");
  document.title = "slip-sidebar";
  import("./sidebar");
} else if (label === "drag-layer") {
  document.body.classList.add("canvas");
  document.title = "slip-drag";
  import("./drag-layer");
} else {
  document.body.classList.add("debug");
  document.title = "slip — 控制台";
  import("./debug");
}

// CDP 测试钩子（T1/T2：动作层直接调用 + 状态读取）
declare global {
  interface Window {
    __slip: {
      act: (name: string, args?: Record<string, unknown>, batch?: string) => Promise<unknown>;
      state: () => unknown;
      actRaw: (req: unknown) => Promise<unknown>;
    };
  }
}

import("./api").then(({ act }) => {
  window.__slip = {
    act: (name: string, args?: Record<string, unknown>, batch?: string) => act({ name, args, batch }),
    actRaw: (req) => act(req as never),
    state: () => getState(),
  };
});

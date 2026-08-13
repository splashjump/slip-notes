// 画布窗口前端逻辑：渲染便签、拖动、编辑、区域上报
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";

interface CheckItem {
  text: string;
  done: boolean;
}
interface Note {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  kind: string; // "text" | "checklist"
  text: string;
  items: CheckItem[];
}

const win = getCurrentWindow();
const label = win.label;
const dpr = window.devicePixelRatio;
const canvasEl = document.getElementById("canvas-root") as HTMLElement;

let winPhys = { x: 0, y: 0 }; // 窗口左上角物理坐标（虚拟屏系），拖拽期间窗口会扩到虚拟屏原点
const cards = new Map<string, HTMLElement>();
let editingId: string | null = null;

async function refreshWinPhys() {
  const p = await win.outerPosition(); // PhysicalPosition
  winPhys = { x: p.x, y: p.y };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function buildCard(n: Note): HTMLElement {
  const el = document.createElement("div");
  el.className = "note-card";
  el.style.background = n.color;
  const css = toCss(n);
  el.style.left = `${css.left}px`;
  el.style.top = `${css.top}px`;
  el.style.width = `${css.width}px`;
  el.style.minHeight = `${css.height}px`;

  if (n.kind === "checklist") {
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = n.text;
    el.appendChild(title);
    for (const it of n.items) {
      const row = document.createElement("label");
      row.className = "check-item" + (it.done ? " done" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = it.done;
      // pointerdown 已 preventDefault，click 里手动切换视觉
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        row.classList.toggle("done", cb.checked);
      });
      const span = document.createElement("span");
      span.textContent = it.text;
      row.append(cb, span);
      el.appendChild(row);
    }
  } else {
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = n.text.replace("\\n", "\n");
    el.appendChild(text);
  }
  return el;
}

function toCss(n: Note) {
  return {
    left: (n.x - winPhys.x) / dpr,
    top: (n.y - winPhys.y) / dpr,
    width: n.w / dpr,
    height: n.h / dpr,
  };
}

async function renderNotes(notes: Note[]) {
  // 窗口位置可能刚变过（拖拽结束 Rust 端 shrink_back 回原显示器），
  // 必须重新读取，否则 toCss 用旧 winPhys 导致多屏下卡片错位。
  await refreshWinPhys();
  canvasEl.innerHTML = "";
  cards.clear();
  if (editingId) {
    editingId = null;
    emit("card-blur", { label });
  }
  for (const n of notes) {
    const el = buildCard(n);
    bindPointer(el, n);
    canvasEl.appendChild(el);
    cards.set(n.id, el);
  }
  reportRegions();
}

/// 上报所有卡片矩形（CSS px）→ Rust SetWindowRgn
function reportRegions() {
  requestAnimationFrame(() => {
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const el of cards.values()) {
      const r = el.getBoundingClientRect();
      rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    void emit("update-regions", { label, rects });
  });
}

// ---------------------------------------------------------------------------
// 拖动 / 点击编辑
// ---------------------------------------------------------------------------

interface DragState {
  id: string;
  startX: number;
  startY: number;
  origLeft: number;
  origTop: number;
  moved: boolean;
}

function bindPointer(el: HTMLElement, n: Note) {
  let drag: DragState | null = null;

  el.addEventListener("pointerdown", (e) => {
    if (editingId) return; // 编辑中不允许拖动
    drag = {
      id: n.id,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: el.offsetLeft,
      origTop: el.offsetTop,
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
    e.preventDefault(); // 防文本选择
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      el.classList.add("dragging");
      void emit("drag-start", { label }); // Rust：窗口放大到虚拟屏 + 清 Rgn
    }
    if (drag.moved) {
      // clamp 在窗口内：单屏时窗口=显示器（拖到屏幕边缘卡片完整停住、不被裁剪）；
      // 多屏时 drag-start 后窗口已放大到虚拟屏，卡片可在各屏间自由移动。
      const maxX = Math.max(0, window.innerWidth - el.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - el.offsetHeight);
      const left = Math.min(Math.max(drag.origLeft + dx, 0), maxX);
      const top = Math.min(Math.max(drag.origTop + dy, 0), maxY);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }
  });

  el.addEventListener("pointerup", () => {
    if (!drag) return;
    const wasMoved = drag.moved;
    drag = null;
    el.classList.remove("dragging");
    if (wasMoved) {
      void (async () => {
        await refreshWinPhys(); // 窗口已放大到虚拟屏原点
        const r = el.getBoundingClientRect();
        void emit("drag-end", {
          label,
          id: n.id,
          x: winPhys.x + r.left * dpr,
          y: winPhys.y + r.top * dpr,
          w: r.width * dpr,
          h: r.height * dpr,
        });
      })();
    } else {
      startEdit(el, n);
    }
  });
}

// ---------------------------------------------------------------------------
// 编辑（激活窗口模式）
// ---------------------------------------------------------------------------

function startEdit(el: HTMLElement, n: Note) {
  const editable = el.querySelector<HTMLElement>(".text");
  if (!editable) return; // checklist 卡片无正文可编辑，不进入编辑态（避免勾选时闪激活窗口）
  if (editingId) endEdit();
  editingId = n.id;
  el.classList.add("editing");
  void emit("card-focus", { label }); // Rust：临时激活窗口
  editable.contentEditable = "true";
  editable.focus();
}

function endEdit() {
  if (!editingId) return;
  const el = cards.get(editingId);
  editingId = null;
  if (el) {
    el.classList.remove("editing");
    const ed = el.querySelector<HTMLElement>(".text");
    if (ed) ed.contentEditable = "false";
  }
  void emit("card-blur", { label }); // Rust：回压 + NOACTIVATE
  reportRegions(); // 编辑后尺寸可能变化
}

// 点击编辑卡片外部 → 结束编辑（透明区点击不经过这里，由 Rust WinEvent 兜底）
document.addEventListener("pointerdown", (e) => {
  if (editingId && !(e.target as HTMLElement).closest(".note-card.editing")) {
    endEdit();
  }
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function init() {
  await refreshWinPhys();
  await listen<Note[]>("notes-for-canvas", (e) => {
    void renderNotes(e.payload);
  });
  // Rust 检测到前台切走（编辑失焦）→ 强制退出编辑
  await listen("edit-end", () => {
    if (editingId) endEdit();
  });
  void emit("canvas-init", { label, dpr });
}

void init();

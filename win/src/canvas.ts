// 画布窗口前端逻辑：渲染便签、拖动、编辑、区域上报
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { buildCard, type Note } from "./card";

const win = getCurrentWindow();
const label = win.label;
const dpr = window.devicePixelRatio;
const canvasEl = document.getElementById("canvas-root") as HTMLElement;

let winPhys = { x: 0, y: 0 }; // 窗口左上角物理坐标（虚拟屏系）。拖动不再放大窗口，坐标全程不变
const cards = new Map<string, HTMLElement>();
let editingId: string | null = null;

async function refreshWinPhys() {
  const p = await win.outerPosition(); // PhysicalPosition
  winPhys = { x: p.x, y: p.y };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function toCss(n: Note) {
  return {
    left: (n.x - winPhys.x) / dpr,
    top: (n.y - winPhys.y) / dpr,
    width: n.w / dpr,
    height: n.h / dpr,
  };
}

async function renderNotes(notes: Note[]) {
  await refreshWinPhys();
  canvasEl.innerHTML = "";
  cards.clear();
  if (editingId) {
    editingId = null;
    emit("card-blur", { label });
  }
  for (const n of notes) {
    const el = buildCard(n, toCss(n));
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
// 拖动（拖拽层窗口模式）
// ---------------------------------------------------------------------------
// 拖动流程：pointerdown 记录抓取偏移 → 移动超 4px 后 emit drag-start（带便签
// 当前物理位置）→ Rust 显示"拖拽层窗口"（顶层小窗，内容 = 便签副本）并回执
// drag-layer-shown → 前端隐藏原卡片（视觉移交拖拽层）→ 拖动中每帧 drag-move
// 上报物理位置 → Rust 移动拖拽层窗口 → 松手 drag-end（坐标更新 + 隐藏拖拽层 +
// 重渲染）。画布窗口全程不动 → 其他便签保持在桌面层。

interface DragState {
  id: string;
  grabX: number; // pointerdown 时鼠标在卡片内的偏移（CSS px）
  grabY: number;
  startX: number;
  startY: number;
  moved: boolean;
  w: number; // 卡片物理尺寸（隐藏后 offsetWidth 失效，必须缓存）
  h: number;
}

let drag: DragState | null = null;
let dragLayerShown = false; // Rust 已显示拖拽层（回执到达）→ 可自由移动；否则降级 clamp 在窗口内
let dragMovePending = false;

function bindPointer(el: HTMLElement, n: Note) {
  el.addEventListener("pointerdown", (e) => {
    if (editingId) return; // 编辑中不允许拖动
    drag = {
      id: n.id,
      grabX: e.clientX - el.offsetLeft,
      grabY: e.clientY - el.offsetTop,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      w: el.offsetWidth * dpr,
      h: el.offsetHeight * dpr,
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
      // 便签当前位置（物理）→ Rust 显示拖拽层窗口
      const left = e.clientX - drag.grabX;
      const top = e.clientY - drag.grabY;
      dragLayerShown = false;
      void emit("drag-start", {
        label,
        id: n.id,
        x: winPhys.x + left * dpr,
        y: winPhys.y + top * dpr,
        w: drag.w,
        h: drag.h,
      });
    }
    if (drag.moved) {
      // 自由移动：拖拽层模式下由 Rust 端 clamp 到虚拟屏；
      // 降级（拖拽层未就绪）时 clamp 在窗口内，避免卡片被窗口边缘裁剪。
      const left = e.clientX - drag.grabX;
      const top = e.clientY - drag.grabY;
      if (!dragLayerShown) {
        const maxX = Math.max(0, window.innerWidth - el.offsetWidth);
        const maxY = Math.max(0, window.innerHeight - el.offsetHeight);
        el.style.left = `${Math.min(Math.max(left, 0), maxX)}px`;
        el.style.top = `${Math.min(Math.max(top, 0), maxY)}px`;
      } else {
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
      }
      emitDragMove();
    }
  });

  el.addEventListener("pointerup", () => {
    if (!drag) return;
    const wasMoved = drag.moved;
    const d = drag;
    drag = null;
    el.classList.remove("dragging");
    if (wasMoved) {
      dragLayerShown = false; // 会话结束复位（迟到的回执不会误伤下一次拖动）
      void (async () => {
        await refreshWinPhys();
        // 卡片可能已被拖拽层接管（display:none），getBoundingClientRect 失效，
        // 位置/尺寸一律从缓存读
        const left = parseFloat(el.style.left) || 0;
        const top = parseFloat(el.style.top) || 0;
        void emit("drag-end", {
          id: n.id,
          x: winPhys.x + left * dpr,
          y: winPhys.y + top * dpr,
          w: d.w,
          h: d.h,
        });
      })();
    } else {
      startEdit(el, n);
    }
  });

  // pointercancel（系统夺走指针）：拖拽层可能已显示，必须通知 Rust 隐藏 + 重渲染
  el.addEventListener("pointercancel", () => {
    if (!drag) return;
    const wasMoved = drag.moved;
    drag = null;
    el.classList.remove("dragging");
    dragLayerShown = false; // 会话结束复位
    if (wasMoved) void emit("drag-cancel", { label });
  });
}

/// 拖动中：rAF 节流上报便签物理位置 → Rust 移动拖拽层窗口
function emitDragMove() {
  if (!drag || dragMovePending || !dragLayerShown) return; // 降级时层未显示，发送无意义
  dragMovePending = true;
  const el = cards.get(drag.id);
  const w = drag.w;
  const h = drag.h;
  if (!el) {
    dragMovePending = false;
    return;
  }
  requestAnimationFrame(() => {
    dragMovePending = false;
    const left = parseFloat(el.style.left) || 0;
    const top = parseFloat(el.style.top) || 0;
    void emit("drag-move", {
      x: winPhys.x + left * dpr,
      y: winPhys.y + top * dpr,
      w,
      h,
    });
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
  // Rust 回执：拖拽层窗口已显示 → 隐藏原卡片（视觉移交拖拽层）
  await listen("drag-layer-shown", () => {
    dragLayerShown = true;
    if (drag) {
      const el = cards.get(drag.id);
      if (el) el.style.display = "none";
    }
  });
  void emit("canvas-init", { label, dpr });
}

void init();

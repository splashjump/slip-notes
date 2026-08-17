// 画布窗口（canvas-N）：桌面卡 + 传送门光带 + 拖动/磁吸/叠放/合并 + 聚合视图
// 前端 = 纯渲染 + 手势解析 + 动作调用（无状态）；数据入口唯一 = Rust 动作层
//
// ---------------------------------------------------------------------------
// 拖拽不变量（本模块的硬约束，改动前必读）：
//  1. 被拖卡位置唯一事实源 = drag.curLeft/curTop（一律 canvas-root CSS 空间，
//     物理坐标 = winPhys + css × dpr）；绝不从 DOM 读位置（视图关闭会移除 DOM）。
//  2. 拖拽中：被拖卡不重建、不 FLIP、不进 Rgn；松手落定卡进 skipAnim 集合，
//     一次性跳过 appearFrom 出生动画（否则"卡弹走又从边栏点飞回"）。
//  3. 原卡隐藏仅在拖拽层窗口确认渲染完成（drag-layer-ack）之后，超时兜底隐藏。
//  4. 视图内拖动：viewDrag 时不移动视图卡 el.style、不磁吸、不叠放判定；
//     崩塌/关闭重建桌面卡时位置 = drag.curLeft/curTop（坐标与 1 一致）。
//  5. 桌面卡 grab 用 offsetLeft/offsetTop（layout 坐标，含叠放 margin = 视觉左缘，
//     与落点视觉一致）；视图卡 grab 用 getBoundingClientRect
//     （view-body 是相对定位，offsetLeft 是错的——第一轮"弹到左上角"根因）。
// ---------------------------------------------------------------------------

import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { buildCard } from "./card";
import { actions, act, newBatch, defaultTimed } from "./api";
import {
  onState,
  initState,
  deskNotes,
  isDesk,
  type AppState,
  type Note,
} from "./state";
import {
  inRect,
  portalBandPhys,
  portalSlotsPhys,
  slotSwipe,
  MERGE_HOLD_MS,
  MAGNET_PX,
  TIMELINE_DRAG_PX,
  CARD,
} from "./geom";
import { capture, apply, pulse, skipAnim } from "./flip";

const win = getCurrentWindow();
const label = win.label;
const dpr = window.devicePixelRatio || 1;
const myMon = parseInt(label.slice("canvas-".length), 10);
const canvasEl = document.getElementById("canvas-root") as HTMLElement;

// ---------------------------------------------------------------------------
// 坐标
// ---------------------------------------------------------------------------

let winPhys = { x: 0, y: 0 };
async function refreshWinPhys() {
  const p = await win.outerPosition();
  winPhys = { x: p.x, y: p.y };
}
let st: AppState | null = null;
let renderSeq = 0; // state 事件渲染序号（R3：防旧监听器用旧 winPhys 渲染）
const viewOpen = () => !!st?.view && st!.view.label === label;

// 本地渲染态（不进 Rust）：expanded / 编辑中
const expanded = new Set<string>();
let editingId: string | null = null;
let pendingFocusId: string | null = null; // 新建卡自动聚焦（focus-note 事件）
let pulseId: string | null = null; // 叠放/合并落定后脉冲顶卡

// 视图关闭动画状态（先播收回动画再压回窗口：view-anim-done 通知 Rust）
let closingView = false;
let closingTimer: number | null = null;

// ---------------------------------------------------------------------------
// 拖拽状态机（桌面卡 / 视图卡共用；拖动统一走拖拽层窗口）
// ---------------------------------------------------------------------------

interface DragState {
  id: string;
  pointerId: number; // 视图关闭重建桌面卡后重新捕获指针（capture 随旧元素销毁）
  viewRebuilt: boolean; // 视图拖出后已重建为桌面卡（后续渲染按常规 skip 保留）
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  moved: boolean;
  w: number;
  h: number;
  t0: number;
  overCardId: string | null;
  overCardSince: number;
  mergeArmed: boolean;
  portalTagged: boolean;
  timedPending: boolean;
  clearPending: boolean;
  dock: boolean;
  snap: { left: number; top: number; axis: "v" | "h"; pos: number } | null;
  viewDrag: boolean; // 视图拖出（portal 挂起）
  lastRegion: string;
  batch: string;
  curLeft: number; // 拖动中实时位置（CSS，不依赖 DOM——视图关闭会移除被拖卡 DOM）
  curTop: number;
  srcX: number; // 拖动起始 store 坐标（物理）
  srcY: number;
}

let drag: DragState | null = null;
let dragLayerShown = false;
let dragAcked = false; // 本轮拖拽是否已收到拖拽层渲染 ack
let lastMoveEmit = 0;
let pressedId: string | null = null; // 按下的卡：任何渲染都保留（勾选框点击不创建 drag，同样怕重建吞 click）

function noteGlobalRect(d: DragState): { x: number; y: number; w: number; h: number } {
  return { x: winPhys.x + d.curLeft * dpr, y: winPhys.y + d.curTop * dpr, w: d.w, h: d.h };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render(closing: boolean) {
  if (!st) return;
  const prev = capture(canvasEl);
  if (viewOpen()) {
    renderView();
  } else {
    renderDesk(closing);
  }
  apply(canvasEl, prev, { appearFrom: appearFromPoint() });
  if (!closing) {
    reportRegions();
    // 节流环境下动画播放慢于标称时长，动画结束后重报一次 Rgn（命中区域精确化）
    setTimeout(() => {
      if (st && !viewOpen() && !closingView) reportRegions();
    }, 1700);
  }
  // 叠放/合并落定脉冲（顶卡高亮 = "你的卡在这里"）
  if (pulseId) {
    const el = canvasEl.querySelector<HTMLElement>(`[data-id="${pulseId}"]`);
    if (el) pulse(el);
    pulseId = null;
  }
  // 新建卡自动聚焦（focus-note：边栏 ➕ → 聚焦可打字）
  if (pendingFocusId) {
    const id = pendingFocusId;
    pendingFocusId = null;
    const el = canvasEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
    const note = st.notes.find((n) => n.id === id);
    if (el && note && note.text.trim() === "" && !note.merge_tree) startEdit(el, note);
  }
  if (closing && closingTimer == null) {
    // 收回动画（遮罩淡出 + FLIP 飞回）播完后移除遮罩、通知 Rust 压回窗口
    closingTimer = window.setTimeout(() => {
      closingTimer = null;
      closingView = false;
      canvasEl.querySelector(".view-overlay")?.remove();
      void emit("view-anim-done", { label });
      reportRegions();
    }, 1500);
  }
}

/** 出生点 = 边栏左缘附近（发牌/归档取回的"从按钮飞出"起点；仅主屏有效） */
function appearFromPoint() {
  if (!st?.sidebarRect || myMon !== st.primaryIndex) return undefined;
  return {
    left: (st.sidebarRect[0] - winPhys.x) / dpr - 170,
    top: (st.sidebarRect[1] - winPhys.y) / dpr + 130,
    width: 60,
    height: 60,
  };
}

function renderDesk(closing: boolean) {
  if (!st) return;
  const d = drag; // 局部引用：renderDesk 同步执行，等价模块级 drag（供 TS 收窄）
  const mustRebuild = !!d && d.moved && d.viewDrag && !d.viewRebuilt;
  const skipId = mustRebuild ? editingId ?? null : pressedId ?? (drag ? drag.id : editingId ?? null);

  // 桌面卡（视图拖出的归档卡也要重建为桌面卡继续手势——B2）
  let notes = deskNotes(st, myMon).filter((n) => n.id !== skipId);
  if (
    mustRebuild &&
    d &&
    !st.view &&
    !notes.some((n) => n.id === d.id)
  ) {
    const n = st.notes.find((x) => x.id === d.id);
    if (n) notes = [...notes, n];
  }

  // 叠放分组（厚度视觉 + ×N 角标 + 层序）
  const posCount = new Map<string, number>();
  const posIndex = new Map<string, number>();
  for (const n of notes) {
    const key = `${n.x},${n.y}`;
    posCount.set(key, (posCount.get(key) ?? 0) + 1);
  }
  const newIds = new Set(notes.map((n) => n.id));

  // 扫入边栏/删除的幽灵卡：元素即将消失 → 克隆一份飞向边栏（归档）/淡出（删除）
  canvasEl.querySelectorAll<HTMLElement>(".note-card").forEach((old) => {
    const id = old.dataset.id;
    if (!id || id === skipId || newIds.has(id)) return;
    const n = st?.notes.find((x) => x.id === id);
    if (n && n.mode === "archive") sweepGhost(old, "sidebar");
    else if (!n || n.deleted) sweepGhost(old, "fade");
  });

  const frag = document.createDocumentFragment();
  let rebuiltEl: HTMLElement | null = null;
  for (const n of notes) {
    const key = `${n.x},${n.y}`;
    const idx = posIndex.get(key) ?? 0;
    posIndex.set(key, idx + 1);
    const count = posCount.get(key) ?? 1;
    const rebuildDrag =
      !!d && d.moved && d.viewDrag && !d.viewRebuilt && !st.view && n.id === d.id;
    const css = rebuildDrag
      ? { left: d.curLeft, top: d.curTop, width: n.w / dpr, height: n.h / dpr }
      : cardCss(n);
    const el = buildCard(n, css, {
      expanded: expanded.has(n.id),
      unconfirmed: st.ephemeral.unconfirmed.includes(n.id),
      rot: true,
      stackTop: idx === count - 1,
      stackCount: count,
    });
    el.dataset.id = n.id;
    el.dataset.stackIndex = String(idx);
    if (rebuildDrag) {
      // 视图关闭 → 被拖卡重建为桌面卡（隐藏与重捕获在入文档后按序执行，见下）
      d.viewRebuilt = true;
      rebuiltEl = el;
    }
    bindCard(el, n);
    frag.appendChild(el);
  }
  canvasEl.querySelectorAll(".note-card").forEach((el) => {
    if (el instanceof HTMLElement && el.dataset.id !== skipId) el.remove();
  });
  if (!closing) {
    canvasEl.querySelector(".view-overlay")?.remove(); // 视图关闭
  } else {
    // 收回动画：遮罩淡出；view 卡位置已由 capture 记录，桌面卡 FLIP 飞回。
    // 归档/删除实体已由上方幽灵循环处理（飞向边栏/淡出），此处只需清空 view-body
    const ov = canvasEl.querySelector(".view-overlay");
    if (ov) {
      ov.classList.add("closing");
      const body = ov.querySelector(".view-body");
      if (body) body.innerHTML = "";
    }
  }
  canvasEl.appendChild(frag);
  // 重建卡接续拖拽：必须先捕获（可见元素）再隐藏——对 display:none 元素
  // setPointerCapture 会静默失效（不抛异常），后续 move/release 全部落空 →
  // drag 冻结 + 拖拽层永远悬挂（安静机器必现）；且必须在入文档后（离树静默失败）
  if (rebuiltEl && d) {
    try {
      rebuiltEl.setPointerCapture(d.pointerId);
      rebuiltEl.style.display = "none"; // 拖拽层窗口仍是视觉主体
    } catch {
      // 指针已结束（release 已在窗口期送达）→ 主动收尾，防复合卡死：
      // drag 非空 + viewRebuilt + 隐藏卡会让 onState 兜底与 pointerdown 自愈都失效
      if (drag) {
        drag = null;
        dragLayerShown = false;
      }
      rebuiltEl.style.display = "";
      void emit("drag-cancel", { label });
    }
  }
  ensurePortal();
}

function cardCss(n: Note) {
  return {
    left: (n.x - winPhys.x) / dpr,
    top: (n.y - winPhys.y) / dpr,
    width: n.w / dpr,
    height: n.h / dpr,
  };
}

/** 幽灵卡：归档 → 飞向边栏；删除 → 淡出缩小（纯装饰，pointer-events: none） */
function sweepGhost(src: HTMLElement, target: "sidebar" | "fade") {
  const r = src.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  const ghost = src.cloneNode(true) as HTMLElement;
  ghost.classList.remove("note-card", "dragging", "editing", "view-card", "merged");
  ghost.classList.add("sweep-ghost");
  ghost.querySelectorAll("[contenteditable]").forEach((x) => x.removeAttribute("contenteditable"));
  delete ghost.dataset.id; // 不与 [data-id] 查询/拖拽逻辑冲突
  delete ghost.dataset.flip; // 不进 FLIP capture
  delete ghost.dataset.stackIndex;
  ghost.style.left = `${r.left}px`;
  ghost.style.top = `${r.top}px`;
  ghost.style.width = `${r.width}px`;
  ghost.style.height = `${r.height}px`;
  ghost.style.minHeight = "0";
  canvasEl.appendChild(ghost);
  const toX =
    target === "sidebar" && st?.sidebarRect
      ? (st.sidebarRect[0] - winPhys.x) / dpr + 60
      : 0;
  const toY =
    target === "sidebar" && st?.sidebarRect
      ? (st.sidebarRect[1] - winPhys.y) / dpr + r.top * 0.6
      : 0;
  const kf =
    target === "sidebar"
      ? [
          { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
          { transform: `translate(${toX - r.left}px, ${toY - r.top}px) rotate(9deg) scale(.82)`, opacity: 0 },
        ]
      : [
          { transform: "scale(1) rotate(0deg)", opacity: 1 },
          { transform: "scale(.62) rotate(-7deg)", opacity: 0 },
        ];
  const anim = ghost.animate(kf, { duration: 430, easing: "cubic-bezier(.45,.05,.55,.95)" });
  setTimeout(() => {
    try {
      anim.finish();
    } catch {
      anim.cancel();
    }
    ghost.remove();
  }, 430 * 4 + 250);
}

// ---------------------------------------------------------------------------
// 传送门
// ---------------------------------------------------------------------------

let portalEl: HTMLElement | null = null;

function ensurePortal() {
  if (!portalEl || !portalEl.isConnected) {
    portalEl = document.createElement("div");
    portalEl.className = "portal";
    portalEl.innerHTML = `
      <div class="portal-slot urgent" data-slot="0"><span class="slot-icon">⚡</span><span class="slot-label">紧急</span></div>
      <div class="portal-slot timed" data-slot="1"><span class="slot-icon">⏰</span><span class="slot-label">定时</span></div>
      <div class="portal-slot clear" data-slot="2"><span class="slot-icon">📄</span><span class="slot-label">恢复</span></div>
    `;
    canvasEl.appendChild(portalEl);
  }
  portalEl.classList.toggle("hidden", viewOpen());
}

/** 刷卡判定：便签 bbox 与槽位水平重叠 ≥50% 且指针在光带高度带内；前置 = 指针不在 dock */
function portalHit(d: DragState, _px: number, py: number): { slot: number } | null {
  if (viewOpen() || !st) return null;
  if (d.dock) return null;
  const nb = noteGlobalRect(d);
  for (const m of st.monitors) {
    const band = portalBandPhys(m);
    if (py < band.y || py > band.y + band.h) continue;
    const slots = portalSlotsPhys(m);
    for (let i = 0; i < 3; i++) {
      if (slotSwipe(nb, slots[i], py, band.y, band.y + band.h)) return { slot: i };
    }
  }
  return null;
}

/** 标记动效（FORM-PLAN §3.5）：⚡颜料桶流下染红 / ⏰笔刷自上而下刷出 / 📄擦除倒刷 */
function flashSlot(slot: number) {
  const el = portalEl?.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (!el) return;
  const kind = ["pour", "brush", "erase"][slot];
  const fill = document.createElement("div");
  fill.className = `slot-fill ${kind}`;
  el.appendChild(fill);
  el.classList.add("triggered");
  setTimeout(() => {
    fill.remove();
    el.classList.remove("triggered");
  }, 760);
}

// ---------------------------------------------------------------------------
// 视图（最近发牌 / 时间线崩塌）——画布窗口抬升 + 窗口内遮罩
// ---------------------------------------------------------------------------

function renderView() {
  if (!st?.view) return;
  // 视图打开/更新前先提交进行中的编辑（否则全量重建会丢未提交文本 + editingId 残留）
  if (editingId) endEdit();
  // B4 同型：视图内全量重建会吞按下的 click——按下的卡不重建，等释放后的下一次事件
  if (pressedId) return;
  const name = st.view.name;
  canvasEl.querySelectorAll(".note-card").forEach((el) => el.remove());
  ensurePortal();
  portalEl!.classList.add("hidden");

  let overlay = canvasEl.querySelector<HTMLElement>(".view-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "view-overlay";
    canvasEl.appendChild(overlay);
  }
  // 复用旧 overlay 时必须清除 closing 状态（上个视图的收回动画留下的类：
  // pointer-events:none 会让新视图整体穿透，所有交互失效）
  overlay.classList.remove("closing");
  // 最近 = 桌面 Top 12；时间线 = 全部实体（含归档，FORM-PLAN §3.6"全部实体从各自位置 FLIP 汇入"）
  const notes =
    name === "recent"
      ? deskNotes(st, myMon)
          .filter((n) => !n.merge_tree)
          .sort((a, b) => b.updated_at - a.updated_at)
          .slice(0, 12)
      : st.notes
          .filter((n) => !n.deleted)
          .sort((a, b) => b.updated_at - a.updated_at);
  const sub =
    name === "recent" ? "最近更新 · Top 12" : `全部实体 · ${notes.length} 张`;
  overlay.innerHTML = `
    <div class="view-mask"></div>
    <div class="view-panel ${name}">
      <div class="view-head">
        <span class="view-title">${name === "recent" ? "🕐 最近" : "⏱ 时间线"}<span class="view-sub">${sub}</span></span>
        <span class="view-x" title="关闭">✕</span>
      </div>
      <div class="view-body"></div>
    </div>
  `;
  const body = overlay.querySelector(".view-body")!;
  for (const n of notes) {
    const css =
      name === "recent"
        ? { left: 0, top: 0, width: 210 / dpr, height: 150 / dpr }
        : { left: 0, top: 0, width: 560 / dpr, height: 120 / dpr };
    const el = buildCard(n, css, { viewMode: true });
    el.dataset.id = n.id;
    bindCard(el, n);
    body.appendChild(el);
  }
  layoutViewBody(name);
  // 遮罩点击 = 关闭；✕ = 关闭
  overlay.querySelector(".view-mask")!.addEventListener("pointerdown", () => {
    void act({ name: "view", args: { name, open: false } });
  });
  overlay.querySelector(".view-x")!.addEventListener("pointerdown", () => {
    void act({ name: "view", args: { name, open: false } });
  });
}

function layoutViewBody(name: string) {
  const body = canvasEl.querySelector(".view-body");
  if (!body) return;
  if (name === "recent") {
    // 发牌：错落网格
    const cards = body.querySelectorAll<HTMLElement>(".note-card");
    const gap = 18;
    const colW = 210 + gap;
    const cols = Math.max(2, Math.floor((window.innerWidth * 0.72) / colW));
    cards.forEach((el, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      el.style.left = `${col * colW + (row % 2) * 24}px`;
      el.style.top = `${row * 168 + 12}px`;
    });
  } else {
    const cards = body.querySelectorAll<HTMLElement>(".note-card");
    cards.forEach((el, i) => {
      el.style.left = "24px";
      el.style.top = `${i * 136 + 12}px`;
    });
  }
}

// ---------------------------------------------------------------------------
// 卡片交互（桌面 + 视图共用）
// ---------------------------------------------------------------------------

function bindCard(el: HTMLElement, n: Note) {
  el.addEventListener("pointerdown", (e) => {
    if (editingId) return;
    const t = e.target as HTMLElement;
    // 合并容器 ✂ 拆分按钮（不设 pressedId：旧容器允许被 state 渲染立即清理，防幽灵残留）
    if (t.closest("[data-unmerge]")) {
      void actions.unmerge(n.id, newBatch());
      return;
    }
    pressedId = n.id; // 按下的卡在任何渲染中保留（勾选框点击不创建 drag，同样怕重建吞 click）
    // 陈腐拖拽自愈：被拖元素若已被移除（pointer capture 随之销毁 → pointerup 丢失）
    // 或拖拽超时未动，先取消旧拖拽再开始新手势，防止 drag 卡死吞掉全部后续手势
    if (drag) {
      const staleEl = canvasEl.querySelector(`[data-id="${drag.id}"]`);
      if (!staleEl || performance.now() - drag.t0 > 30_000) {
        drag = null;
        dragLayerShown = false;
        void emit("drag-cancel", { label });
      } else {
        return;
      }
    }
    if (t.closest(".check-item")) return;
    // 取消可能卡住的 FLIP 动画（残留 transform 会破坏命中测试）
    for (const a of el.getAnimations()) a.cancel(); // 勾选走 click
    // 桌面卡：layout 坐标（offsetLeft 含叠放 margin，即视觉左缘；不含旋转，
    // 落点与视觉一致）；视图卡：offsetParent 是 .view-body（相对定位），
    // offsetLeft 是错的 → 用 gBCR（第一轮"弹到左上角"根因）
    const inView = !!el.closest(".view-body");
    const box = inView
      ? el.getBoundingClientRect()
      : { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
    drag = {
      id: n.id,
      pointerId: e.pointerId,
      viewRebuilt: false,
      grabX: e.clientX - box.left,
      grabY: e.clientY - box.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      w: el.offsetWidth * dpr,
      h: el.offsetHeight * dpr,
      t0: performance.now(),
      overCardId: null,
      overCardSince: 0,
      mergeArmed: false,
      portalTagged: false,
      timedPending: false,
      clearPending: false,
      dock: false,
      snap: null,
      viewDrag: false,
      lastRegion: "",
      batch: newBatch(),
      curLeft: box.left,
      curTop: box.top,
      srcX: n.x,
      srcY: n.y,
    };
    dragAcked = false;
    lastEndInfo = null; // 清上一轮拖拽的陈旧诊断记录
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== n.id) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      beginDrag(e);
    }
    if (drag.moved) moveDrag(e);
  });

  el.addEventListener("pointerup", (e) => {
    if (pressedId === n.id) pressedId = null;
    if (!drag || drag.id !== n.id) return;
    const d = drag;
    drag = null;
    el.classList.remove("dragging");
    if (!d.moved) {
      el.classList.remove("drag-collapse");
      clickCard(el, n, e);
      return;
    }
    void endDrag(d, e);
  });

  el.addEventListener("pointercancel", () => {
    if (pressedId === n.id) pressedId = null;
    if (!drag || drag.id !== n.id) return;
    const wasMoved = drag.moved;
    drag = null;
    dragLayerShown = false;
    el.classList.remove("dragging", "drag-collapse");
    if (wasMoved) {
      void emit("drag-clear", {});
      void emit("drag-cancel", { label });
    }
  });

  // 勾选
  el.querySelectorAll(".check-item").forEach((row) => {
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const cb = row.querySelector("input")!;
      const itemId = (row as HTMLElement).dataset.item!;
      void actions.check(n.id, itemId, cb.checked);
    });
  });
}

function beginDrag(e: PointerEvent) {
  const el = canvasEl.querySelector<HTMLElement>(`[data-id="${drag!.id}"]`);
  if (!el) return;
  el.classList.add("dragging");
  drag!.curLeft = e.clientX - drag!.grabX;
  drag!.curTop = e.clientY - drag!.grabY;
  // 展开态拖动：超过 4px 阈值才算拖 → 此时瞬间收缩再拖（FORM-PLAN §3.4；
  // 类切换不重建 DOM，pointer capture 不受影响；grab 以卡顶为基准，收缩不影响）
  const noteId = drag!.id;
  if (expanded.has(noteId)) {
    expanded.delete(noteId);
    el.classList.add("drag-collapse");
    // 拖拽层尺寸用收缩后的标准卡高
    drag!.h = CARD.h * dpr;
    drag!.w = el.offsetWidth * dpr;
  }
  // 视图内拖出：时间线（超过阈值后崩塌）/ 最近（立即关闭视图）——
  // 两者都置 viewDrag：视图关闭渲染会把被拖卡重建为桌面卡继续手势（B2），
  // 且拖出全程 portal 挂起（与"视图打开时刷卡被挂起"语义一致）
  if (viewOpen() && st?.view) {
    drag!.viewDrag = true;
    if (st.view.name !== "timeline") {
      const name = st.view.name;
      void act({ name: "view", args: { name, open: false } });
    }
  }
  dragLayerShown = false;
  dragAcked = false;
  const left = e.clientX - drag!.grabX;
  const top = e.clientY - drag!.grabY;
  void emit("drag-start", {
    label,
    id: drag!.id,
    x: winPhys.x + left * dpr,
    y: winPhys.y + top * dpr,
    w: drag!.w,
    h: drag!.h,
  });
}

function moveDrag(e: PointerEvent) {
  const d = drag!;
  const left = e.clientX - d.grabX;
  const top = e.clientY - d.grabY;
  d.curLeft = left;
  d.curTop = top;
  const el = canvasEl.querySelector<HTMLElement>(`[data-id="${d.id}"]`);
  // 视图内拖动不移动视图卡（视图布局不动，拖拽层接管视觉）
  if (el && !d.viewDrag) {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  if (dragLayerShown) emitDragMove();

  const px = winPhys.x + e.clientX * dpr;
  const py = winPhys.y + e.clientY * dpr;

  // 时间线拖出：累计位移 > 80px → 整线崩塌 + 视图关闭
  if (viewOpen() && st?.view?.name === "timeline" && d.viewDrag) {
    const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
    if (moved > TIMELINE_DRAG_PX) {
      const name = st.view.name;
      void act({ name: "view", args: { name, open: false } });
    }
    return;
  }

  // dock 判定（指针在边栏矩形内）
  const sb = st?.sidebarRect;
  const dock = !!sb && inRect(px, py, { x: sb[0], y: sb[1], w: sb[2], h: sb[3] });
  d.dock = dock;

  // 刷卡判定（视图打开时挂起；视图拖出 portal 忽略）
  const hit = d.viewDrag ? null : portalHit(d, px, py);
  if (hit) {
    if (hit.slot === 0 && !d.portalTagged) {
      d.portalTagged = true;
      flashSlot(0);
      void actions.tag(d.id, "urgent", true, d.batch);
    } else if (hit.slot === 1) {
      d.timedPending = true;
      flashSlot(1);
    } else if (hit.slot === 2) {
      d.clearPending = true;
      flashSlot(2);
    }
  }

  // 磁吸 + 叠放/合并目标（仅桌面拖动）
  if (el && !d.viewDrag) {
    updateMagnet(el, e);
    updateMergeTarget(el, e);
  }

  // 反馈事件（跨窗口高亮：dock / 传送门槽位）
  const region = dock ? "dock" : hit ? `slot${hit.slot}` : "";
  if (region !== d.lastRegion) {
    d.lastRegion = region;
    void emit("drag-feedback", { x: px, y: py, active: true });
  }
}

function clearGuideLine() {
  canvasEl.querySelectorAll(".mag-line").forEach((x) => x.remove());
}

function setGuideLine(axis: "v" | "h", at: number) {
  clearGuideLine();
  const line = document.createElement("div");
  line.className = `mag-line ${axis}`;
  if (axis === "v") {
    line.style.left = `${at}px`;
    line.style.top = "0";
  } else {
    line.style.top = `${at}px`;
    line.style.left = "0";
  }
  canvasEl.appendChild(line);
}

function updateMagnet(el: HTMLElement, _e: PointerEvent) {
  if (!st) return;
  const M = MAGNET_PX;
  let best = Infinity;
  let snap: { left: number; top: number; axis: "v" | "h"; pos: number } | null = null;
  const left = drag!.curLeft;
  const top = drag!.curTop;
  const w = drag!.w / dpr;
  const h = drag!.h / dpr;
  for (const other of canvasEl.querySelectorAll<HTMLElement>(".note-card")) {
    if (other === el || other.dataset.id === drag!.id) continue;
    if (other.classList.contains("view-card")) continue;
    const r = other.getBoundingClientRect();
    const cands: [number, { left: number; top: number; axis: "v" | "h"; pos: number }][] = [
      [Math.abs(left - r.left), { left: r.left, top, axis: "v", pos: r.left }], // 左对齐
      [Math.abs(left + w - (r.left + r.width)), { left: r.left + r.width - w, top, axis: "v", pos: r.left + r.width }], // 右对齐
      [Math.abs(top - r.top), { left, top: r.top, axis: "h", pos: r.top }], // 顶对齐
      [Math.abs(top + h - (r.top + r.height)), { left, top: r.top + r.height - h, axis: "h", pos: r.top + r.height }], // 底对齐
    ];
    for (const [dist, cand] of cands) {
      if (dist <= M && dist < best) {
        best = dist;
        snap = cand;
      }
    }
  }
  const prevSnap = drag!.snap;
  if (snap) {
    // 吸附弹性：首次进入磁吸范围时用弹簧动画"吸"过去
    if (!prevSnap) {
      const dx = drag!.curLeft - snap.left;
      const dy = drag!.curTop - snap.top;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) {
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0,0)" }],
          { duration: 140, easing: "cubic-bezier(.3,1.6,.4,1)" },
        );
        setTimeout(() => {
          for (const a of el.getAnimations()) {
            if (a.playState === "running") {
              try {
                a.finish();
              } catch {
                a.cancel();
              }
            }
          }
        }, 140 * 4 + 250);
      }
    }
    drag!.curLeft = snap.left;
    drag!.curTop = snap.top;
    if (el) {
      el.style.left = `${snap.left}px`;
      el.style.top = `${snap.top}px`;
    }
    setGuideLine(snap.axis, snap.pos); // 引导线
    el?.classList.add("snapped");
  } else {
    if (prevSnap) clearGuideLine();
    el?.classList.remove("snapped");
  }
  drag!.snap = snap;
}

function updateMergeTarget(el: HTMLElement, e: PointerEvent) {
  const d = drag!;
  if (d.viewDrag || d.dock) {
    d.overCardId = null;
    return;
  }
  let over: string | null = null;
  for (const other of canvasEl.querySelectorAll<HTMLElement>(".note-card")) {
    if (other === el || other.dataset.id === d.id) continue;
    if (other.classList.contains("view-card")) continue;
    const r = other.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      over = other.dataset.id ?? null;
      break;
    }
  }
  if (over !== d.overCardId) {
    d.overCardId = over;
    d.overCardSince = over ? performance.now() : 0;
    d.mergeArmed = false;
    canvasEl.querySelectorAll(".note-card.merge-target").forEach((x) => x.classList.remove("merge-target"));
    canvasEl.querySelectorAll(".note-card.merge-armed").forEach((x) => x.classList.remove("merge-armed"));
    if (over) {
      canvasEl.querySelector(`[data-id="${over}"]`)?.classList.add("merge-target");
    }
  } else if (over && !d.mergeArmed && performance.now() - d.overCardSince >= MERGE_HOLD_MS) {
    d.mergeArmed = true; // 停留 800ms → 合并预备
    canvasEl.querySelector(`[data-id="${over}"]`)?.classList.add("merge-armed");
  }
}

let lastEndInfo: Record<string, number | boolean> | null = null;

async function endDrag(d: DragState, e: PointerEvent) {
  dragLayerShown = false;
  elCleanup(d);
  const px = winPhys.x + e.clientX * dpr;
  const py = winPhys.y + e.clientY * dpr;
  const sb = st?.sidebarRect;
  const dock = !!sb && inRect(px, py, { x: sb[0], y: sb[1], w: sb[2], h: sb[3] });
  const note = st?.notes.find((n) => n.id === d.id);

  void emit("drag-clear", {});
  // 松手落定：本卡不播出生动画（拖拽期间 display:none，capture 拿不到旧矩形，
  // 不跳过会走 appearFrom 分支从边栏点飞入——"弹走又飞回"的直接来源）
  skipAnim(d.id);
  // 1) 位置更新（同步 invoke：先落坐标再执行后续动作，顺序有保证）
  //    视图拖出用 store 原始尺寸（时间线卡 560×120 不该污染桌面卡尺寸）。
  //    落点 = curLeft/curTop 原样提交：单卡落点与视觉严格一致；叠放路径的
  //    位置由 stack 动作覆盖，无需补偿。
  const w = d.viewDrag && note ? note.w : d.w;
  const h = d.viewDrag && note ? note.h : d.h;
  try {
    lastEndInfo = {
      curLeft: d.curLeft,
      curTop: d.curTop,
      grabY: d.grabY,
      grabX: d.grabX,
      viewDrag: d.viewDrag,
      clientY: e.clientY,
      sentY: winPhys.y + d.curTop * dpr,
    };
    await invoke("drag_end", {
      p: {
        id: d.id,
        x: winPhys.x + d.curLeft * dpr,
        y: winPhys.y + d.curTop * dpr,
        w,
        h,
      },
    });
  } catch {
    void emit("drag-cancel", { label });
  }

  if (d.viewDrag) {
    // 视图拖出：dock→store / desk→move（归档卡 = take 落桌）/ portal→忽略（drag_end 已落点）
    if (dock) {
      await actions.store(d.id, undefined, d.batch);
      void emit("entry-highlight", { ids: [d.id] });
    } else if (note && note.mode === "archive") {
      await actions.take(d.id, winPhys.x + d.curLeft * dpr, winPhys.y + d.curTop * dpr, d.batch);
    }
    return;
  }
  if (dock) {
    // 桌面纸堆整格拖入 → storeSlot（按拖前起点找纸堆成员）；单张 → store
    const at = stackMembersAt(d);
    if (at.length >= 2) {
      await actions.storeSlot(at, d.batch);
      void emit("entry-highlight", { ids: at });
    } else {
      await actions.store(d.id, undefined, d.batch);
      void emit("entry-highlight", { ids: [d.id] });
    }
    return;
  }
  if (d.clearPending) {
    void actions.tag(d.id, "urgent", false, d.batch);
    void actions.tag(d.id, "timed", null, d.batch);
    return;
  }
  if (d.timedPending) {
    showChips(px, py, d.id, d.batch);
    return;
  }
  // 桌面：合并（停留 800ms）/ 叠放（快速松手，上限 9）/ 磁吸（drag_end 已带吸附坐标）
  if (d.mergeArmed && d.overCardId) {
    const target = st?.notes.find((n) => n.id === d.overCardId);
    const me = st?.notes.find((n) => n.id === d.id);
    if (target && me && !target.merge_tree && !me.merge_tree) {
      // 停靠点决定左右/上下分割（撕裂方向）
      const targetEl = canvasEl.querySelector<HTMLElement>(`[data-id="${d.overCardId}"]`);
      let dir = "grid";
      if (targetEl) {
        const r = targetEl.getBoundingClientRect();
        dir =
          Math.abs(e.clientX - (r.left + r.width / 2)) >=
          Math.abs(e.clientY - (r.top + r.height / 2))
            ? "row"
            : "col";
      }
      const r = await act({ name: "merge", args: { ids: [d.id, d.overCardId], x: target.x, y: target.y, dir }, batch: d.batch });
      const containerId = r.notes?.[0]?.id;
      if (containerId) pulseId = containerId;
      return;
    }
  }
  if (d.overCardId) {
    const target = st?.notes.find((n) => n.id === d.overCardId);
    if (target) {
      const mates = stackMembersAt(d, target.x, target.y).filter((m) => m !== d.id);
      if (mates.length + 1 > 9) {
        // 叠放上限 9：轻晃拒绝（落点保留，仅不叠放）
        const el = canvasEl.querySelector<HTMLElement>(`[data-id="${d.id}"]`);
        if (el) {
          el.classList.add("shake");
          setTimeout(() => el.classList.remove("shake"), 420);
        }
        return;
      }
      // 被拖卡排最后 = 渲染在最上层（第一轮"叠放后卡不见了"根因：被拖卡垫底被盖住）
      const ids = [...mates, d.id];
      await actions.stack(ids, target.x, target.y, d.batch);
      pulseId = d.id;
      return;
    }
  }
}

/** 与 (x,y) 同位置的桌面卡（缺省 = 拖前起点，纸堆成员判定） */
function stackMembersAt(d: DragState, x?: number, y?: number): string[] {
  if (!st) return [];
  const gx = x ?? d.srcX;
  const gy = y ?? d.srcY;
  return st.notes
    .filter((n) => isDesk(n) && n.x === gx && n.y === gy)
    .map((n) => n.id);
}

function elCleanup(d: DragState) {
  const el = canvasEl.querySelector<HTMLElement>(`[data-id="${d.id}"]`);
  if (el) {
    el.classList.remove("dragging", "snapped", "drag-collapse");
    el.style.display = "";
  }
  clearGuideLine();
  canvasEl.querySelectorAll(".note-card.merge-target, .note-card.merge-armed").forEach((x) =>
    x.classList.remove("merge-target", "merge-armed"),
  );
  if (portalEl) {
    portalEl.querySelectorAll(".portal-slot.hover").forEach((x) => x.classList.remove("hover"));
  }
}

function emitDragMove(force = false) {
  if (!drag || !dragLayerShown) return;
  // 时间限频（16ms），不再用 rAF——WebView2 对后台窗口节流 rAF，
  // 拖拽层会停在原地然后突进（"卡弹走又飞回"的另一来源）
  const now = performance.now();
  if (!force && now - lastMoveEmit < 16) return;
  lastMoveEmit = now;
  void emit("drag-move", {
    x: winPhys.x + drag.curLeft * dpr,
    y: winPhys.y + drag.curTop * dpr,
    w: drag.w,
    h: drag.h,
  });
}

// ---------------------------------------------------------------------------
// 点击（展开/编辑/脉冲）与编辑
// ---------------------------------------------------------------------------

function clickCard(el: HTMLElement, n: Note, _e: PointerEvent) {
  // 视图内卡片：点击 = 脉冲（时间线"点击=脉冲不崩塌"；最近"点击脉冲"）
  if (el.classList.contains("view-card")) {
    pulse(el);
    return;
  }
  if (n.merge_tree) {
    // 合并容器：点击 = 摊开四宫格动画
    el.classList.add("bounce");
    setTimeout(() => el.classList.remove("bounce"), 400);
    return;
  }
  if (n.items.length > 0) {
    // checklist：点击 = 展开/收起（expanded 纯前端渲染态）
    if (expanded.has(n.id)) expanded.delete(n.id);
    else expanded.add(n.id);
    render(false);
    return;
  }
  // 文本卡：点开全文 + 就地编辑
  if (expanded.has(n.id)) expanded.delete(n.id);
  else expanded.add(n.id);
  startEdit(el, n);
}

function startEdit(el: HTMLElement, n: Note) {
  const textEl = el.querySelector<HTMLElement>(".text");
  if (!textEl) return;
  if (editingId) endEdit();
  editingId = n.id;
  el.classList.add("editing");
  void emit("card-focus", { label });
  textEl.contentEditable = "true";
  textEl.classList.remove("clamp5");
  textEl.focus();
}

function endEdit() {
  if (!editingId) return;
  const id = editingId;
  editingId = null;
  const el = canvasEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (el) {
    el.classList.remove("editing");
    const ed = el.querySelector<HTMLElement>(".text");
    if (ed) {
      ed.contentEditable = "false";
      const text = ed.innerText;
      const note = st?.notes.find((n) => n.id === id);
      if (note && text !== note.text && text.trim() !== "") {
        void actions.editText(id, text);
      } else {
        render(false);
      }
    }
  }
  void emit("card-blur", { label });
}

// ---------------------------------------------------------------------------
// 定时 chips（⏰ 松手后弹出）
// ---------------------------------------------------------------------------

let chipsEl: HTMLElement | null = null;

function showChips(px: number, py: number, id: string, batch: string) {
  dismissChips();
  const lx = (px - winPhys.x) / dpr;
  const ly = (py - winPhys.y) / dpr;
  chipsEl = document.createElement("div");
  chipsEl.className = "chips";
  const t18 = defaultTimed();
  const t10 = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return d.getTime();
  })();
  chipsEl.innerHTML = `
    <div class="chip" data-t="${t18}">🕕 今天 18:00</div>
    <div class="chip" data-t="${t10}">☀ 明天 10:00</div>
    <div class="chip custom"><input type="time" value="18:00" /><span>自定义</span></div>
  `;
  chipsEl.style.left = `${Math.min(Math.max(lx - 60, 8), window.innerWidth - 260)}px`;
  chipsEl.style.top = `${Math.max(ly - 80, 8)}px`;
  canvasEl.appendChild(chipsEl);
  chipsEl.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const t = (chip as HTMLElement).dataset.t;
      const custom = chip.querySelector("input");
      const value = t ? Number(t) : custom ? timeInputToMs(custom.value) : null;
      if (value) void actions.tag(id, "timed", value, batch);
      dismissChips();
      reportRegions();
    });
  });
  setTimeout(() => {
    document.addEventListener("pointerdown", dismissChips, { once: true });
  }, 0);
  reportRegions();
}

function timeInputToMs(v: string): number {
  const [h, m] = v.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function dismissChips() {
  chipsEl?.remove();
  chipsEl = null;
  reportRegions(); // Y6：chips 关闭后重报 Rgn，避免残留拦截区
}

// ---------------------------------------------------------------------------
// 区域上报（Rgn）
// ---------------------------------------------------------------------------

function reportRegions(delay = 0) {
  setTimeout(async () => {
    if (viewOpen() || closingView || !st) return; // 视图期间 Rust 已设全屏 Rgn
    // Q31：上报屏幕物理坐标（不再依赖 devicePixelRatio 猜测换算——DPR 与窗口实际
    // 缩放可能不一致导致命中偏移；用 Tauri scaleFactor = 物理px/CSSpx 官方比例）
    const scale = win.scaleFactor ? await win.scaleFactor() : window.devicePixelRatio || 1;
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    canvasEl.querySelectorAll<HTMLElement>(".note-card, .portal, .chips").forEach((el) => {
      if (el.classList.contains("view-card")) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        rects.push({
          x: winPhys.x + r.left * scale,
          y: winPhys.y + r.top * scale,
          w: r.width * scale,
          h: r.height * scale,
        });
    });
    void emit("update-regions", { label, rects });
  }, delay);
}

// ---------------------------------------------------------------------------
// 监听 / 初始化
// ---------------------------------------------------------------------------

async function init() {
  await refreshWinPhys();
  await initState();
  // T1 调试钩子（CDP 手势排查用）
  (window as unknown as Record<string, unknown>).__slipDebug = {
    dragInfo: () =>
      drag
        ? {
            id: drag.id,
            moved: drag.moved,
            curLeft: drag.curLeft,
            curTop: drag.curTop,
            dock: drag.dock,
            portalTagged: drag.portalTagged,
            timedPending: drag.timedPending,
            overCardId: drag.overCardId,
            viewDrag: drag.viewDrag,
            layerShown: dragLayerShown,
            acked: dragAcked,
            grab: { x: drag.grabX, y: drag.grabY },
            w: drag.w,
            h: drag.h,
          }
        : null,
    lastEnd: () => lastEndInfo,
    st: () => st && { view: st.view, monitors: st.monitors, sidebarRect: st.sidebarRect, winPhys },
    winPhys: () => winPhys,
    cardRects: () =>
      [...canvasEl.querySelectorAll<HTMLElement>(".note-card")].map((el) => ({
        id: el.dataset.id,
        left: el.style.left,
        top: el.style.top,
        w: el.offsetWidth,
        h: el.offsetHeight,
      })),
  };
  // 事件序纪律：state.ts 的 initState 是唯一 listen("state") 注册点，
  // 窗口一律 onState 订阅拿最新载荷（tauri 监听器 LIFO，自行 listen 会读旧缓存）
  onState((s) => {
    const wasOpen = !!st?.view && st.view.label === label;
    const nowOpen = !!s.view && s.view.label === label;
    st = s;
    if (nowOpen) {
      closingView = false;
      if (closingTimer != null) {
        clearTimeout(closingTimer);
        closingTimer = null;
      }
    } else if (wasOpen) {
      closingView = true;
    }
    // 注意：closingView 在收回动画期间保持 true（无关 state 事件不得截断动画），
    // 动画完成后由 closingTimer 清零 + emit view-anim-done + Rust 压回窗口。
    // 全屏隐藏/恢复、视图开合、拓扑重建 → 重新对齐窗口物理位置后再渲染。
    // R3：必须 await 完成再 render（render 用 winPhys 换算卡片位置）；
    // 渲染序号防重入：并发 state 事件时只由最新一次执行渲染。
    const mySeq = ++renderSeq;
    void (async () => {
      if (st?.monitors[myMon]) {
        await refreshWinPhys();
      }
      if (mySeq !== renderSeq) return; // 已有更新的 state 事件，本次作废
      render(closingView);
      // 兜底：渲染可能移除被拖卡元素（视图关闭/切换等）→ 其 pointer capture 随元素
      // 销毁而丢失，pointerup 不会再到达 → 主动取消拖拽，防止 drag 卡死（安静机器必现）
      if (drag) {
        const live = canvasEl.querySelector(`[data-id="${drag.id}"]`);
        if (!live) {
          drag = null;
          dragLayerShown = false;
          void emit("drag-cancel", { label });
        }
      }
    })();
  });
  // 拖拽层窗口已显示（Rust）：先不隐藏原卡，等渲染 ack 或超时兜底——
  // 拖拽层内容渲染有延迟（隐藏过的 WebView 首次恢复慢），
  // 立即隐藏原卡会造成每次拖起都有"两张卡都不在"的窗口（"拖过去不见了"）
  await listen("drag-layer-shown", () => {
    dragLayerShown = true;
    if (drag && !dragAcked) {
      const idAtShow = drag.id; // 捕获当时拖拽对象：快速松手再抓时防误隐藏新一轮的原卡
      setTimeout(() => {
        if (drag && drag.id === idAtShow && !dragAcked && dragLayerShown) {
          const el = canvasEl.querySelector<HTMLElement>(`[data-id="${drag.id}"]`);
          if (el) el.style.display = "none";
        }
      }, 450);
    }
  });
  // 拖拽层渲染完成 ack（drag-layer.ts 在 DOM 就绪后发）→ 隐藏原卡 + 立即同步一次位置
  await listen("drag-layer-ack", () => {
    dragAcked = true;
    dragLayerShown = true;
    if (drag) {
      const el = canvasEl.querySelector<HTMLElement>(`[data-id="${drag.id}"]`);
      if (el) el.style.display = "none";
      emitDragMove(true);
    }
  });
  await listen("edit-end", () => {
    if (editingId) endEdit();
  });
  await listen<{ id: string }>("pulse-note", (e) => {
    const el = canvasEl.querySelector<HTMLElement>(`[data-id="${e.payload.id}"]`);
    if (el) pulse(el);
  });
  // 拖起 → 传送门增亮（本窗口或边栏/其它窗口的拖拽统一走事件广播）
  await listen("drag-start", () => {
    portalEl?.classList.add("armed");
  });
  await listen("drag-clear", () => {
    portalEl?.classList.remove("armed");
    if (portalEl) {
      portalEl.querySelectorAll(".portal-slot.hover").forEach((x) => x.classList.remove("hover"));
    }
  });
  // 跨窗口拖拽反馈（高亮传送门槽位）
  await listen<{ x: number; y: number; active: boolean }>("drag-feedback", (e) => {
    if (!portalEl || viewOpen()) return;
    const f = e.payload;
    if (!f.active) {
      portalEl.classList.remove("armed");
      portalEl.querySelectorAll(".portal-slot.hover").forEach((x) => x.classList.remove("hover"));
      return;
    }
    portalEl.classList.add("armed");
    const lx = (f.x - winPhys.x) / dpr;
    const ly = (f.y - winPhys.y) / dpr;
    const r = portalEl.getBoundingClientRect();
    portalEl.querySelectorAll(".portal-slot.hover").forEach((x) => x.classList.remove("hover"));
    if (ly >= r.top && ly <= r.bottom) {
      portalEl.querySelectorAll<HTMLElement>(".portal-slot").forEach((slot) => {
        const sr = slot.getBoundingClientRect();
        if (lx >= sr.left && lx <= sr.right) slot.classList.add("hover");
      });
    }
  });
  // 新建卡聚焦（边栏 ➕ → 聚焦可打字，FORM-PLAN §3.4"聚焦可打字"）。
  // 跨窗口事件与 invoke 响应无顺序保证：元素已渲染则立即编辑，否则挂 pending 下次 render 消费。
  await listen<{ id: string }>("focus-note", (e) => {
    const id = e.payload.id;
    const el = canvasEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
    const note = st?.notes.find((n) => n.id === id);
    if (el && note && note.text.trim() === "" && !note.merge_tree) startEdit(el, note);
    else pendingFocusId = id;
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (viewOpen() && st?.view) {
        void act({ name: "view", args: { name: st.view.name, open: false } });
      } else if (editingId) {
        endEdit();
      } else {
        dismissChips();
      }
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (editingId && !(e.target as HTMLElement).closest(".note-card.editing")) {
      endEdit();
    }
  });
  // pressedId 兜底清理：释放落在卡片外/其它窗口时无卡片 pointerup，
  // 由 document 级 pointerup 统一清（卡自身的 handler 先清，此处幂等）
  document.addEventListener("pointerup", () => {
    pressedId = null;
    // 兜底：重建卡重捕获失败时（释放落回文档而非卡片），清理冻结的视图拖出——
    // 防拖拽层永远悬挂 + 后续手势被吞（正常路径卡 handler 先置 drag=null，此处幂等）
    if (drag?.viewDrag && drag.viewRebuilt) {
      drag = null;
      dragLayerShown = false;
      void emit("drag-clear", {});
      void emit("drag-cancel", { label });
    }
  });
  void emit("canvas-init", { label, dpr });
}

void init();

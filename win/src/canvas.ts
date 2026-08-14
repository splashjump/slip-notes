// 画布窗口（canvas-N）：桌面卡 + 传送门光带 + 拖动/磁吸/叠放/合并 + 聚合视图
// 前端 = 纯渲染 + 手势解析 + 动作调用（无状态）；数据入口唯一 = Rust 动作层

import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { buildCard } from "./card";
import { actions, act, newBatch, defaultTimed } from "./api";
import {
  getState,
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
} from "./geom";
import { capture, apply, pulse, flash } from "./flip";

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

// 本地渲染态（不进 Rust）：expanded / 已看
const expanded = new Set<string>();
let editingId: string | null = null;

// ---------------------------------------------------------------------------
// 拖拽状态机（桌面卡 / 视图卡共用；拖动统一走拖拽层窗口）
// ---------------------------------------------------------------------------

interface DragState {
  id: string;
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
  snap: { left: number; top: number } | null;
  viewDrag: boolean; // 时间线拖出（portal 忽略）
  lastRegion: string;
  batch: string;
  curLeft: number; // 拖动中实时位置（CSS，不依赖 DOM——视图关闭会移除被拖卡 DOM）
  curTop: number;
  srcX: number; // 拖动起始 store 坐标（物理）
  srcY: number;
}

let drag: DragState | null = null;
let dragLayerShown = false;
let dragMovePending = false;

function noteGlobalRect(d: DragState): { x: number; y: number; w: number; h: number } {
  return { x: winPhys.x + d.curLeft * dpr, y: winPhys.y + d.curTop * dpr, w: d.w, h: d.h };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render() {
  if (!st) return;
  const prev = capture(canvasEl);
  if (viewOpen()) {
    renderView();
  } else {
    renderDesk();
  }
  apply(canvasEl, prev, { appearFrom: appearFromPoint() });
  reportRegions();
}

function appearFromPoint() {
  if (!st?.sidebarRect) return undefined;
  // 新建/发牌出生点：边栏左缘（物理 → 本窗口 CSS）
  const s = st.monitors[myMon] ?? st.monitors[0];
  const scale = s.dpi / 96;
  return {
    left: (st.sidebarRect[0] - 140) / scale,
    top: (st.sidebarRect[1] + 100) / scale,
    width: 60,
    height: 60,
  };
}

function renderDesk() {
  if (!st) return;
  // 拖拽中/编辑中的卡不重渲染（动作响应期间保持 DOM 不被打断；
  // 否则 card-focus 的状态事件会重建编辑卡，丢掉 .editing 与焦点）
  const skipId = drag?.moved ? drag.id : editingId ?? null;
  const notes = deskNotes(st, myMon).filter((n) => n.id !== skipId);
  const frag = document.createDocumentFragment();
  for (const n of notes) {
    const el = buildCard(n, cardCss(n), {
      expanded: expanded.has(n.id),
      unconfirmed: st.ephemeral.unconfirmed.includes(n.id),
    });
    el.dataset.id = n.id;
    bindCard(el, n);
    frag.appendChild(el);
  }
  canvasEl.querySelectorAll(".note-card").forEach((el) => {
    if (el instanceof HTMLElement && el.dataset.id !== skipId) el.remove();
  });
  canvasEl.querySelector(".view-overlay")?.remove(); // 视图关闭
  canvasEl.appendChild(frag);
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

function flashSlot(slot: number) {
  if (!portalEl) return;
  const el = portalEl.querySelector(`[data-slot="${slot}"]`);
  if (el) flash(el as HTMLElement);
}

// ---------------------------------------------------------------------------
// 视图（最近发牌 / 时间线崩塌）——画布窗口抬升 + 窗口内遮罩
// ---------------------------------------------------------------------------

function renderView() {
  if (!st?.view) return;
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
  const notes = deskNotes(st, myMon)
    .filter((n) => !n.merge_tree)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 12);
  overlay.innerHTML = `
    <div class="view-mask"></div>
    <div class="view-panel ${name}">
      <div class="view-head">
        <span class="view-title">${name === "recent" ? "🕐 最近" : "⏱ 时间线"}</span>
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
        : { left: 0, top: 0, width: 520 / dpr, height: 108 / dpr };
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
    // 错落网格
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
      el.style.top = `${i * 124 + 12}px`;
    });
  }
}

// ---------------------------------------------------------------------------
// 卡片交互（桌面 + 视图共用）
// ---------------------------------------------------------------------------

function bindCard(el: HTMLElement, n: Note) {
  el.addEventListener("pointerdown", (e) => {
    if (editingId) return;
    if (drag) return;
    const target = e.target as HTMLElement;
    if (target.closest(".check-item")) return;
    // 取消可能卡住的 FLIP 动画（残留 transform 会破坏命中测试）
    for (const a of el.getAnimations()) a.cancel(); // 勾选走 click
    drag = {
      id: n.id,
      grabX: e.clientX - el.offsetLeft,
      grabY: e.clientY - el.offsetTop,
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
      curLeft: el.offsetLeft,
      curTop: el.offsetTop,
      srcX: n.x,
      srcY: n.y,
    };
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
    if (!drag || drag.id !== n.id) return;
    const d = drag;
    drag = null;
    el.classList.remove("dragging");
    if (!d.moved) {
      clickCard(el, n, e);
      return;
    }
    endDrag(d, e);
  });

  el.addEventListener("pointercancel", () => {
    if (!drag || drag.id !== n.id) return;
    const wasMoved = drag.moved;
    drag = null;
    dragLayerShown = false;
    el.classList.remove("dragging");
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
  // 视图内拖出：时间线（崩塌）/ 最近（关闭视图）
  if (viewOpen() && st?.view) {
    if (st.view.name === "timeline") {
      // 80px 阈值由 moveDrag 判定（需要先积累位移）
      drag!.viewDrag = true;
    } else {
      // 最近：拖出 = 变桌面态 + 整个视图关闭
      const name = st.view.name;
      void act({ name: "view", args: { name, open: false } });
    }
  }
  dragLayerShown = false;
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
  const el = canvasEl.querySelector<HTMLElement>(`[data-id="${drag!.id}"]`);
  const left = e.clientX - drag!.grabX;
  const top = e.clientY - drag!.grabY;
  drag!.curLeft = left;
  drag!.curTop = top;
  if (el) {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  if (dragLayerShown) emitDragMove();

  const px = winPhys.x + e.clientX * dpr;
  const py = winPhys.y + e.clientY * dpr;

  // 时间线拖出：累计位移 > 80px → 整线崩塌 + 视图关闭
  if (viewOpen() && st?.view?.name === "timeline" && drag!.viewDrag) {
    const moved = Math.hypot(e.clientX - drag!.startX, e.clientY - drag!.startY);
    if (moved > TIMELINE_DRAG_PX) {
      const name = st.view.name;
      void act({ name: "view", args: { name, open: false } });
    }
    return;
  }

  // dock 判定（指针在边栏矩形内）
  const sb = st?.sidebarRect;
  const dock = !!sb && inRect(px, py, { x: sb[0], y: sb[1], w: sb[2], h: sb[3] });
  drag!.dock = dock;

  // 刷卡判定（视图打开时挂起；时间线拖出 portal 忽略）
  const hit = drag!.viewDrag ? null : portalHit(drag!, px, py);
  if (hit) {
    if (hit.slot === 0 && !drag!.portalTagged) {
      drag!.portalTagged = true;
      flashSlot(0);
      void actions.tag(drag!.id, "urgent", true, drag!.batch);
    } else if (hit.slot === 1) {
      drag!.timedPending = true;
      flashSlot(1);
    } else if (hit.slot === 2) {
      drag!.clearPending = true;
      flashSlot(2);
    }
  }

  // 磁吸 + 叠放/合并目标（本窗口内其他卡）
  if (el) {
    updateMagnet(el, e);
    updateMergeTarget(el, e);
  }

  // 反馈事件（跨窗口高亮：dock / 传送门槽位）
  const region = dock ? "dock" : hit ? `slot${hit.slot}` : "";
  if (region !== drag!.lastRegion) {
    drag!.lastRegion = region;
    void emit("drag-feedback", { x: px, y: py, active: true });
  }
}

function updateMagnet(el: HTMLElement, _e: PointerEvent) {
  if (!st) return;
  const M = MAGNET_PX;
  let best = Infinity;
  let snap: { left: number; top: number } | null = null;
  const left = drag!.curLeft;
  const top = drag!.curTop;
  const w = drag!.w / dpr;
  const h = drag!.h / dpr;
  for (const other of canvasEl.querySelectorAll<HTMLElement>(".note-card")) {
    if (other === el || other.dataset.id === drag!.id) continue;
    const r = other.getBoundingClientRect();
    const cands: [number, { left: number; top: number }][] = [
      [Math.abs(left - r.left), { left: r.left, top }], // 左对齐
      [Math.abs(left + w - (r.left + r.width)), { left: r.left + r.width - w, top }], // 右对齐
      [Math.abs(top - r.top), { left, top: r.top }], // 顶对齐
      [Math.abs(top + h - (r.top + r.height)), { left, top: r.top + r.height - h }], // 底对齐
    ];
    for (const [dist, cand] of cands) {
      if (dist <= M && dist < best) {
        best = dist;
        snap = cand;
      }
    }
  }
  if (snap) {
    drag!.curLeft = snap.left;
    drag!.curTop = snap.top;
    if (el) {
      el.style.left = `${snap.left}px`;
      el.style.top = `${snap.top}px`;
    }
    el?.classList.add("snapped");
  } else {
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
    if (over) {
      canvasEl.querySelector(`[data-id="${over}"]`)?.classList.add("merge-target");
    }
  } else if (over && !d.mergeArmed && performance.now() - d.overCardSince >= MERGE_HOLD_MS) {
    d.mergeArmed = true; // 停留 800ms → 合并预备
    canvasEl.querySelector(`[data-id="${over}"]`)?.classList.add("merge-armed");
  }
}

async function endDrag(d: DragState, e: PointerEvent) {
  dragLayerShown = false;
  elCleanup(d);
  const px = winPhys.x + e.clientX * dpr;
  const py = winPhys.y + e.clientY * dpr;
  const sb = st?.sidebarRect;
  const dock = !!sb && inRect(px, py, { x: sb[0], y: sb[1], w: sb[2], h: sb[3] });

  void emit("drag-clear", {});
  // 1) 位置更新（同步 invoke：先落坐标再执行后续动作，顺序有保证）
  try {
    await invoke("drag_end", {
      p: {
        id: d.id,
        x: winPhys.x + d.curLeft * dpr,
        y: winPhys.y + d.curTop * dpr,
        w: d.w,
        h: d.h,
      },
    });
  } catch {
    void emit("drag-cancel", { label });
  }

  if (d.viewDrag) {
    // 时间线拖出：dock→store / desk→move / portal→忽略（drag_end 已处理 move）
    if (dock) void actions.store(d.id, undefined, d.batch);
    return;
  }
  if (dock) {
    // 桌面纸堆整格拖入 → storeSlot（按拖前起点找纸堆成员）；单张 → store
    const at = stackMembersAt(d);
    if (at.length >= 2) void actions.storeSlot(at, d.batch);
    else void actions.store(d.id, undefined, d.batch);
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
      void actions.merge([d.id, d.overCardId], target.x, target.y, d.batch);
      return;
    }
  }
  if (d.overCardId) {
    const target = st?.notes.find((n) => n.id === d.overCardId);
    if (target) {
      const mates = stackMembersAt(d, target.x, target.y);
      const ids = [d.id, ...mates.filter((m) => m !== d.id)].slice(0, 9);
      void actions.stack(ids, target.x, target.y, d.batch);
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
    el.classList.remove("dragging", "snapped");
  }
  canvasEl.querySelectorAll(".note-card.merge-target, .note-card.merge-armed").forEach((x) =>
    x.classList.remove("merge-target", "merge-armed"),
  );
  if (portalEl) {
    portalEl.querySelectorAll(".portal-slot.hover").forEach((x) => x.classList.remove("hover"));
  }
}

function emitDragMove() {
  if (!drag || dragMovePending || !dragLayerShown) return;
  dragMovePending = true;
  requestAnimationFrame(() => {
    dragMovePending = false;
    if (!drag) return;
    void emit("drag-move", {
      x: winPhys.x + drag.curLeft * dpr,
      y: winPhys.y + drag.curTop * dpr,
      w: drag.w,
      h: drag.h,
    });
  });
}

// ---------------------------------------------------------------------------
// 点击（展开/编辑）与脉冲
// ---------------------------------------------------------------------------

function clickCard(el: HTMLElement, n: Note, _e: PointerEvent) {
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
    render();
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
        render();
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
    <div class="chip" data-t="${t18}">今天 18:00</div>
    <div class="chip" data-t="${t10}">明天 10:00</div>
    <div class="chip custom"><input type="time" value="18:00" /><span>自定义</span></div>
  `;
  chipsEl.style.left = `${Math.min(Math.max(lx - 60, 8), window.innerWidth - 260)}px`;
  chipsEl.style.top = `${Math.max(ly - 70, 8)}px`;
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
  setTimeout(() => {
    if (viewOpen() || !st) return; // 视图期间 Rust 已设全屏 Rgn
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    canvasEl.querySelectorAll<HTMLElement>(".note-card, .portal, .chips").forEach((el) => {
      if (el.classList.contains("view-card")) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
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
          }
        : null,
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
  await listen("state", () => {
    st = getState();
    // 全屏隐藏/恢复、视图开合、拓扑重建 → 重新对齐窗口物理位置后再渲染。
    // R3：必须 await 完成再 render（render 用 winPhys 换算卡片位置）；
    // 渲染序号防重入：并发 state 事件时只由最新一次执行渲染。
    const mySeq = ++renderSeq;
    void (async () => {
      if (st?.monitors[myMon]) {
        await refreshWinPhys();
      }
      if (mySeq !== renderSeq) return; // 已有更新的 state 事件，本次作废
      render();
    })();
  });
  await listen("drag-layer-shown", () => {
    dragLayerShown = true;
    if (drag) {
      const el = canvasEl.querySelector<HTMLElement>(`[data-id="${drag.id}"]`);
      if (el) el.style.display = "none";
    }
  });
  await listen("edit-end", () => {
    if (editingId) endEdit();
  });
  await listen<{ id: string }>("pulse-note", (e) => {
    const el = canvasEl.querySelector<HTMLElement>(`[data-id="${e.payload.id}"]`);
    if (el) pulse(el);
  });
  // 跨窗口拖拽反馈（高亮传送门槽位）
  await listen<{ x: number; y: number; active: boolean }>("drag-feedback", (e) => {
    if (!portalEl || viewOpen()) return;
    const f = e.payload;
    if (!f.active) {
      portalEl.querySelectorAll(".portal-slot.hover").forEach((x) => x.classList.remove("hover"));
      return;
    }
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
  await listen("drag-clear", () => {
    if (portalEl) {
      portalEl.querySelectorAll(".portal-slot.hover").forEach((x) => x.classList.remove("hover"));
    }
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
  void emit("canvas-init", { label, dpr });
}

void init();

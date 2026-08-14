// 边栏窗口（sidebar，主屏右缘 270px）：快捷栏 / 今日投影 / 全部列表 / 档案格 / 底部
// 点击边栏只抬升边栏窗口（窄条），桌面卡窗口保持置底（z-order 解耦）

import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { actions, newBatch, act } from "./api";
import {
  onState,
  initState,
  archiveFlat,
  archiveSlots,
  todayEntries,
  isUnconfirmed,
  relTime,
  fmtTime,
  type AppState,
  type Note,
} from "./state";
import { SLOT_H, SIDEBAR_W } from "./geom";
import { capture, apply } from "./flip";

const win = getCurrentWindow();
const label = "sidebar";
const dpr = window.devicePixelRatio || 1;
const root = document.getElementById("sidebar-root") as HTMLElement;

let st: AppState | null = null;
let winPhys = { x: 0, y: 0 };
async function refreshWinPhys() {
  const p = await win.outerPosition();
  winPhys = { x: p.x, y: p.y };
}
// 本地渲染态
const pinned = new Set<string>(); // 钉住的抽屉
const slotExpanded = new Set<string>(); // 摊开的档案格
let deleteArmed: { id: string; timer: number } | null = null;

/** store 时钟（真实时间 + timeOffset；与 Rust 逾期/自动收回基准一致——Y5） */
const nowMs = () => Date.now() + (st?.timeOffset ?? 0);

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render() {
  if (!st) return;
  const prev = capture(root);
  root.innerHTML = st.sidebarCollapsed ? quickbarHtml() : panelHtml();
  if (!st.sidebarCollapsed) {
    bindPanel(root);
  } else {
    bindQuickbar(root);
  }
  apply(root, prev);
  reportRegions();
}

function quickbarHtml(): string {
  return `
    <div class="sb-quickbar">
      <button class="qb-btn" data-act="expand" title="展开">⤢</button>
      <button class="qb-btn" data-act="create" title="新建">➕</button>
      <button class="qb-btn" data-act="archiveAll" title="一键归档">🗄</button>
      <button class="qb-btn" data-act="view-recent" title="最近">🕐</button>
      <button class="qb-btn" data-act="view-timeline" title="时间线">⏱</button>
      <button class="qb-btn" data-act="console" title="控制台">⚙</button>
    </div>
  `;
}

function panelHtml(): string {
  const s = st!;
  const today = todayEntries(s);
  const slots = archiveSlots(s);
  const flat = archiveFlat(s);
  const journal = s.journal.slice(0, 3);

  const todayHtml = today
    .map((n) => {
      const overdue = n.timed != null && n.timed < nowMs();
      const icon = overdue ? "🔴" : n.urgent ? "⚡" : "⏰";
      return `
        <div class="today-entry${overdue ? " overdue" : ""}" data-id="${n.id}" data-mode="${n.mode}">
          <span class="today-icon">${icon}</span>
          <span class="today-text">${esc(title(n))}${n.timed != null ? ` <em>${fmtTime(n.timed)}</em>` : ""}</span>
        </div>`;
    })
    .join("");

  const slotsHtml = slots
    .map(({ slotId, notes }) => slotHtml(slotId, notes))
    .join("");

  const flatHtml = flat
    .map((n) => entryHtml(n))
    .join("");

  const logHtml = journal
    .map(
      (j) =>
        `<div class="log-row${j.author === "ai" ? " ai" : ""}"><span class="log-name">${esc(j.name)}</span><span class="log-args">${esc(logArgs(j))}</span><span class="log-time">${relTime(j.time)}</span></div>`,
    )
    .join("");

  return `
    <div class="sb-panel">
      <div class="sb-header">
        <span class="sb-logo">纸筏</span>
        <span class="sync-lamp offline" title="离线模式（形态先行，未接服务器）">●</span>
        <button class="sb-icon-btn" data-act="collapse" title="收起">⤢</button>
      </div>
      <div class="sb-toolbar">
        <button class="tb-btn" data-act="create" title="新建便签">➕</button>
        <button class="tb-btn" data-act="archiveAll" title="一键归档全部">🗄</button>
        <button class="tb-btn" data-act="view-recent" title="最近（发牌）">🕐</button>
        <button class="tb-btn" data-act="view-timeline" title="时间线（崩塌）">⏱</button>
        <button class="tb-btn" data-act="console" title="控制台">⚙</button>
      </div>
      <div class="sb-section today">
        <div class="sb-section-title">🔥 今日</div>
        <div class="sb-today-list">${todayHtml || `<div class="sb-empty">暂无定时/紧急</div>`}</div>
      </div>
      <div class="sb-section all">
        <div class="sb-section-title">📋 全部</div>
        <div class="sb-slots">${slotsHtml}</div>
        <div class="sb-all-list">${flatHtml || `<div class="sb-empty">（拖桌面卡到这里归档）</div>`}</div>
      </div>
      <div class="sb-bottom">
        <div class="sync-detail"><span class="sync-lamp offline">●</span> 同步 · 离线（形态先行）</div>
        <div class="ai-log">${logHtml || `<div class="sb-empty">AI 日志为空</div>`}</div>
        <button class="undo-btn" data-act="undo">↩ 撤销批次</button>
      </div>
    </div>
  `;
}

function entryHtml(n: Note): string {
  const un = isUnconfirmed(st!, n.id);
  return `
    <div class="sb-entry" data-id="${n.id}" data-flip="entry-${n.id}">
      <div class="entry-head">
        <span class="entry-title">${esc(title(n))}</span>
        <span class="entry-meta">${relTime(n.updated_at)}</span>
      </div>
      <div class="entry-badges">${badges(n)}</div>
      <div class="entry-body clamp5">${esc(n.text.replace(/\n/g, "\n"))}</div>
      ${un ? `<span class="unconfirmed-dot" title="自动收回，待确认">●</span>` : ""}
      <div class="entry-drawer${pinned.has(n.id) ? " pinned" : ""}">
        <div class="drawer-body">${esc(n.text.replace(/\n/g, "\n"))}</div>
      </div>
      ${deleteArmed?.id === n.id ? `<button class="del-btn">🗑 删除</button>` : ""}
    </div>
  `;
}

function slotHtml(slotId: string, notes: Note[]): string {
  const expanded = slotExpanded.has(slotId);
  const layout = slotLayout(slotId, notes);
  const membersHtml = layout.members
    .map(
      (m) => `
      <div class="slot-member" data-id="${m.note.id}" style="left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px;background:${m.note.color}">
        <div class="slot-member-title">${esc(title(m.note))}</div>
        <div class="slot-member-body clamp3">${esc(m.note.text.replace(/\n/g, "\n"))}</div>
      </div>`,
    )
    .join("");
  return `
    <div class="slot" data-slot="${slotId}">
      <div class="slot-head">
        <span class="slot-name">🗂 档案格</span>
        <span class="slot-count">${notes.length} 张</span>
        <span class="slot-mode">${layout.mode === "stack" ? "堆叠" : "平铺"}${expanded ? " · 摊开" : ""}</span>
        ${layout.mode === "stack" ? `<span class="slot-badge">×${notes.length}</span>` : ""}
      </div>
      <div class="slot-body${expanded ? " expanded" : ""}" style="height:${expanded ? "auto" : SLOT_H + "px"}">
        ${membersHtml}
        ${layout.mode === "stack" ? `<div class="slot-stack-edge">${notes.length} 张</div>` : ""}
      </div>
    </div>
  `;
}

interface MemberLayout {
  note: Note;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SlotLayout {
  mode: "flat" | "stack";
  members: MemberLayout[];
}

/** 容量 = floor((格高−边距)/(成员最大内容高+间距))，按实际渲染测量 */
function slotLayout(slotId: string, notes: Note[]): SlotLayout {
  const expanded = slotExpanded.has(slotId);
  const bodyW = SIDEBAR_W - 24;
  const memberW = Math.max(118, (bodyW - 10 * (notes.length - 1)) / notes.length);
  const probeH = measureMemberH(memberW, notes);
  const capacity = Math.max(2, Math.floor((SLOT_H - 14) / (probeH + 10)));
  // 迟滞：>容量 → 堆叠；≤容量−1 → 回平铺
  const hysteresis = slotHysteresis.get(slotId) ?? "flat";
  let mode: "flat" | "stack" = hysteresis;
  if (hysteresis === "flat" && notes.length > capacity) mode = "stack";
  if (hysteresis === "stack" && notes.length <= capacity - 1) mode = "flat";
  slotHysteresis.set(slotId, mode);
  if (expanded) mode = "flat";

  const members: MemberLayout[] = [];
  if (mode === "flat") {
    notes.forEach((n, i) => {
      members.push({
        note: n,
        x: i * (memberW + 10),
        y: 8,
        w: memberW,
        h: probeH,
      });
    });
  } else {
    // 堆叠：顶卡 + 厚度 + ×N
    notes.forEach((n, i) => {
      members.push({
        note: n,
        x: 0,
        y: 8 + i * 5,
        w: bodyW,
        h: probeH,
      });
    });
  }
  return { mode, members };
}

const slotHysteresis = new Map<string, "flat" | "stack">();

function measureMemberH(w: number, notes: Note[]): number {
  // 探针测量（与 .slot-member 样式一致）
  let probe = document.getElementById("sb-probe");
  if (!probe) {
    probe = document.createElement("div");
    probe.id = "sb-probe";
    probe.className = "slot-member";
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    probe.style.left = "-9999px";
    document.body.appendChild(probe);
  }
  let maxH = 0;
  for (const n of notes) {
    probe.style.width = `${w}px`;
    probe.style.height = "auto";
    probe.innerHTML = `<div class="slot-member-title">${esc(title(n))}</div><div class="slot-member-body clamp3">${esc(n.text.replace(/\n/g, "\n"))}</div>`;
    maxH = Math.max(maxH, probe.offsetHeight || 84);
  }
  return maxH;
}

function badges(n: Note): string {
  const parts: string[] = [];
  if (n.urgent) parts.push('<span class="badge urgent">⚡</span>');
  if (n.timed != null) {
    const overdue = n.timed < nowMs();
    parts.push(
      `<span class="badge timed${overdue ? " overdue" : ""}">${overdue ? "🔴" : "⏰"} ${fmtTime(n.timed)}</span>`,
    );
  }
  return parts.join("");
}

function title(n: Note): string {
  if (n.title) return n.title;
  return n.text.split("\n")[0].trim() || "（无标题）";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function logArgs(j: { name: string; args: Record<string, unknown> }): string {
  const a = j.args ?? {};
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string).slice(0, 18) : "");
  switch (j.name) {
    case "create":
      return pick("text") || "新建";
    case "editText":
      return pick("id");
    case "store":
    case "take":
    case "move":
      return `${pick("id")}${a.direction ? "→" + a.direction : ""}`;
    case "tag":
      return `${pick("id")} ${a.tag}${a.v === true ? "=true" : a.v === false ? "=false" : ""}`;
    case "merge":
      return `(${Array.isArray(a.ids) ? (a.ids as string[]).join("+") : ""})`;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function bindPanel(el: HTMLElement) {
  el.querySelectorAll<HTMLElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void doAct(btn.dataset.act!);
    });
  });

  // 今日条目
  el.querySelectorAll<HTMLElement>(".today-entry").forEach((row) => {
    row.addEventListener("pointerdown", () => {
      const id = row.dataset.id!;
      const mode = row.dataset.mode!;
      const closeFirst = () => {
        if (st?.view) {
          return act({ name: "view", args: { name: st.view.name, open: false } }).then(() =>
            setTimeout(() => respond(), 60),
          );
        }
        respond();
      };
      const respond = () => {
        if (mode === "desk") void emit("pulse-note", { id }); // 桌面 → 脉冲（跨窗口）
        else void actions.take(id); // 档案 → 抽出
      };
      void closeFirst();
    });
  });

  // 全部条目（hover 抽屉 / 钉住 / 拖出 / 未确认）
  el.querySelectorAll<HTMLElement>(".sb-entry").forEach((entry) => {
    bindEntry(entry);
  });

  // 档案格
  el.querySelectorAll<HTMLElement>(".slot").forEach((slot) => {
    bindSlot(slot);
  });

  // 撤销批次
  el.querySelector('[data-act="undo"]')?.addEventListener("pointerdown", () => {
    const last = st?.journal[0];
    if (last) void actions.undoBatch(last.batch);
  });
}

function bindQuickbar(el: HTMLElement) {
  el.querySelectorAll<HTMLElement>("[data-act]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void doAct(btn.dataset.act!);
    });
  });
}

async function doAct(actName: string) {
  switch (actName) {
    case "expand":
      await actions.expand();
      break;
    case "collapse":
      await actions.collapse();
      break;
    case "create": {
      // 新建 = 桌面铺开空卡（发牌动效在画布窗口 FLIP）
      const s = st;
      const batch = newBatch();
      const x = s ? Math.max(120, (s.sidebarRect?.[0] ?? 900) - 300) : 180;
      await actions.create("", undefined, x, 140, batch);
      break;
    }
    case "archiveAll":
      await actions.archiveAll(newBatch());
      break;
    case "view-recent":
      await toggleView("recent");
      break;
    case "view-timeline":
      await toggleView("timeline");
      break;
    case "console":
      await actions.toggleConsole();
      break;
    case "undo": {
      const last = st?.journal[0];
      if (last) await actions.undoBatch(last.batch);
      break;
    }
  }
}

async function toggleView(name: string) {
  if (st?.view?.name === name) await actions.view(name, false);
  else await actions.view(name, true);
}

// ---------------------------------------------------------------------------
// 条目交互（抽屉 / 拖出 / 排序 / 入格）
// ---------------------------------------------------------------------------

interface EntryDrag {
  id: string;
  el: HTMLElement; // 被按元素引用：全量重建后旧元素销毁（capture 释放）用 isConnected 判定
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  moved: boolean;
  w: number;
  h: number;
  batch: string;
  lastRegion: string;
}

let entryDrag: EntryDrag | null = null;

function bindEntry(entry: HTMLElement) {
  const id = entry.dataset.id!;
  entry.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".unconfirmed-dot") || t.closest(".del-btn")) return;
    entryDrag = {
      id,
      el: entry,
      grabX: e.clientX - entry.offsetLeft,
      grabY: e.clientY - entry.offsetTop,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      w: entry.offsetWidth * dpr,
      h: entry.offsetHeight * dpr,
      batch: newBatch(),
      lastRegion: "",
    };
    entry.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  entry.addEventListener("pointermove", (e) => {
    if (!entryDrag || entryDrag.id !== id) return;
    if (!entryDrag.moved && Math.hypot(e.clientX - entryDrag.startX, e.clientY - entryDrag.startY) > 4) {
      entryDrag.moved = true;
      void emit("drag-start", {
        label,
        id,
        x: winPhys.x + (e.clientX - entryDrag.grabX) * dpr,
        y: winPhys.y + (e.clientY - entryDrag.grabY) * dpr,
        w: entryDrag.w,
        h: entryDrag.h,
      });
    }
    if (entryDrag.moved) {
      const px = winPhys.x + e.clientX * dpr;
      const py = winPhys.y + e.clientY * dpr;
      void emit("drag-move", {
        x: px - entryDrag.grabX * dpr,
        y: py - entryDrag.grabY * dpr,
        w: entryDrag.w,
        h: entryDrag.h,
      });
      // 反馈：边栏内 = dock；边栏外 = 让画布窗口高亮传送门
      const sb = st?.sidebarRect;
      const inSb = !!sb && px >= sb[0] && px <= sb[0] + sb[2];
      const region = inSb ? "dock" : "outside";
      if (region !== entryDrag.lastRegion) {
        entryDrag.lastRegion = region;
        void emit("drag-feedback", { x: px, y: py, active: true });
      }
    }
  });

  entry.addEventListener("pointerup", (e) => {
    if (!entryDrag || entryDrag.id !== id) return;
    const d = entryDrag;
    entryDrag = null;
    void emit("drag-clear", {});
    if (!d.moved) {
      // 点击 = 抽屉钉住/收起
      if (pinned.has(id)) pinned.delete(id);
      else pinned.add(id);
      render();
      return;
    }
    void emit("drag-cancel", { label });
    const px = winPhys.x + e.clientX * dpr;
    const py = winPhys.y + e.clientY * dpr;
    const sb = st?.sidebarRect;
    const inSb = !!sb && px >= sb[0] && px <= sb[0] + sb[2];
    if (inSb) {
      // 边栏内：入格 / 排序 / 原地
      const slotEl = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest(".slot");
      if (slotEl) {
        void actions.joinSlot(id, (slotEl as HTMLElement).dataset.slot!);
        return;
      }
      const overEntry = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement)?.closest(
        ".sb-entry",
      );
      if (overEntry && overEntry !== entry && (overEntry as HTMLElement).dataset.id) {
        const flat = archiveFlat(st!);
        const idx = flat.findIndex((n) => n.id === (overEntry as HTMLElement).dataset.id);
        // Y2：toIndex = 归档扁平序列下标（store.reorder 在归档组内插入）
        if (idx >= 0) void actions.reorder(id, idx);
        return;
      }
      render();
    } else {
      // 拖出 = 桌面铺开（take 落点）
      void actions.take(id, px - d.grabX * dpr, py - d.grabY * dpr);
    }
  });

  entry.addEventListener("pointercancel", () => {
    if (!entryDrag || entryDrag.id !== id) return;
    entryDrag = null;
    void emit("drag-clear", {});
    void emit("drag-cancel", { label });
  });

  // 未确认圆点：点击 = 确认 + 尾部弹出 🗑 删除按钮（3 秒后消失，不自动删除）
  entry.querySelector(".unconfirmed-dot")?.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    void actions.confirm(id);
    if (deleteArmed) clearTimeout(deleteArmed.timer);
    deleteArmed = { id, timer: window.setTimeout(() => { deleteArmed = null; render(); }, 3000) };
    render();
  });
  entry.querySelector(".del-btn")?.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (deleteArmed) clearTimeout(deleteArmed.timer);
    deleteArmed = null;
    void actions.del(id, newBatch());
  });
}

// ---------------------------------------------------------------------------
// 档案格交互
// ---------------------------------------------------------------------------

function bindSlot(slotEl: HTMLElement) {
  const slotId = slotEl.dataset.slot!;
  const notes = archiveSlots(st!).find((s) => s.slotId === slotId)?.notes ?? [];
  const stacked = slotEl.querySelector(".slot-mode")?.textContent?.includes("堆叠");
  const expanded = slotExpanded.has(slotId);

  // 点击：平铺 = 抽出单张 / 堆叠 = 摊开
  slotEl.querySelector(".slot-body")?.addEventListener("pointerdown", (e: Event) => {
    const member = (e.target as HTMLElement).closest(".slot-member");
    if (!member) return;
    const mid = (member as HTMLElement).dataset.id!;
    if (stacked && !expanded) {
      slotExpanded.add(slotId);
      render();
      return;
    }
    void actions.take(mid); // 抽出单张
  });

  // 成员拖出 = 一次一张 take（Y1：pointercancel 清理，防止拖拽态泄漏）
  notes.forEach((n) => {
    const member = slotEl.querySelector<HTMLElement>(`.slot-member[data-id="${n.id}"]`);
    if (!member) return;
    member.addEventListener("pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
      const m = member as HTMLElement;
      const sx = e.clientX;
      const sy = e.clientY;
      const d = { grabX: e.clientX - m.offsetLeft, grabY: e.clientY - m.offsetTop };
      let moved = false;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        m.removeEventListener("pointermove", onMove);
        m.removeEventListener("pointerup", onUp);
        m.removeEventListener("pointercancel", onCancel);
        m.style.opacity = "";
        void emit("drag-clear", {});
      };
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
          moved = true;
          m.style.opacity = "0.4";
          void emit("drag-start", {
            label,
            id: n.id,
            x: winPhys.x + ev.clientX * dpr,
            y: winPhys.y + ev.clientY * dpr,
            w: m.offsetWidth * dpr,
            h: m.offsetHeight * dpr,
          });
        }
        if (moved) {
          void emit("drag-move", {
            x: winPhys.x + ev.clientX * dpr,
            y: winPhys.y + ev.clientY * dpr,
            w: m.offsetWidth * dpr,
            h: m.offsetHeight * dpr,
          });
          const px = winPhys.x + ev.clientX * dpr;
          const py = winPhys.y + ev.clientY * dpr;
          const sb = st?.sidebarRect;
          const inSb = !!sb && px >= sb[0] && px <= sb[0] + sb[2];
          const region = inSb ? "dock" : "outside";
          if (region !== entryDrag?.lastRegion) {
            if (entryDrag) entryDrag.lastRegion = region;
            void emit("drag-feedback", { x: px, y: py, active: true });
          }
        }
      };
      const onUp = (ev: PointerEvent) => {
        cleanup();
        if (!moved) return;
        void emit("drag-cancel", { label });
        const px = winPhys.x + ev.clientX * dpr;
        const py = winPhys.y + ev.clientY * dpr;
        const sb = st?.sidebarRect;
        const inSb = !!sb && px >= sb[0] && px <= sb[0] + sb[2];
        if (!inSb) void actions.take(n.id, px - d.grabX * dpr, py - d.grabY * dpr);
      };
      const onCancel = () => {
        // 系统夺走指针（窗口失焦/触控板手势）：恢复样式 + 清拖拽态
        cleanup();
        void emit("drag-cancel", { label });
      };
      m.addEventListener("pointermove", onMove);
      m.addEventListener("pointerup", onUp);
      m.addEventListener("pointercancel", onCancel);
      m.setPointerCapture(e.pointerId);
    });
  });

  // 摊开态点击标题栏 = 收回
  slotEl.querySelector(".slot-head")?.addEventListener("pointerdown", (e) => {
    if (expanded) {
      e.stopPropagation();
      slotExpanded.delete(slotId);
      render();
    }
  });
}

// ---------------------------------------------------------------------------
// 区域上报 / 监听 / 初始化
// ---------------------------------------------------------------------------

function reportRegions() {
  requestAnimationFrame(() => {
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const el = root.querySelector(".sb-panel, .sb-quickbar");
    if (el) {
      const r = el.getBoundingClientRect();
      rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    root.querySelectorAll<HTMLElement>(".entry-drawer.pinned").forEach((d) => {
      const r = d.getBoundingClientRect();
      rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    });
    void emit("update-regions", { label, rects });
  });
}

async function init() {
  await refreshWinPhys();
  await initState();
  // 事件序纪律：唯一 listen("state") 在 state.ts；窗口一律 onState 订阅拿最新载荷
  onState((s) => {
    st = s;
    void refreshWinPhys();
    render();
    // 兜底：render 全量重建 DOM，若拖拽中的条目元素已被销毁 → 取消拖拽
    // （否则 pointerup 丢失，Rust 侧 ephemeral.dragging 永久卡住）
    if (entryDrag && !entryDrag.el.isConnected) {
      entryDrag = null;
      void emit("drag-clear", {});
      void emit("drag-cancel", { label });
    }
  });
  // 拖拽层接管（条目/成员拖出）
  await listen("drag-layer-shown", () => {
    // 原卡视觉移交拖拽层（条目在拖出时保持显示，无需隐藏）
  });
  // dock 高亮（来自画布窗口的拖拽反馈）
  await listen<{ x: number; y: number; active: boolean }>("drag-feedback", (e) => {
    const f = e.payload;
    const hint = root.querySelector(".dock-hint");
    if (!f.active) {
      hint?.remove();
      return;
    }
    const sb = st?.sidebarRect;
    if (!sb) return;
    const inSb = f.x >= sb[0] && f.x <= sb[0] + sb[2] && f.y >= sb[1] && f.y <= sb[1] + sb[3];
    if (inSb && !hint) {
      const d = document.createElement("div");
      d.className = "dock-hint";
      d.textContent = "松手归档";
      root.appendChild(d);
      reportRegions();
    } else if (!inSb) {
      hint?.remove();
    }
  });
  await listen("drag-clear", () => {
    root.querySelector(".dock-hint")?.remove();
  });
  void emit("canvas-init", { label, dpr });
}

void init();

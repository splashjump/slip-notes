// 卡片 DOM 构建（桌面卡 / 边栏条目 / 档案格成员 / 拖拽层副本共用）

import type { Note } from "./state";
import { fmtTime, titleOf, nowMs } from "./state";
import type { RectLike } from "./flip";

export interface CardCss {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CardOpts {
  expanded?: boolean; // 展开全文（默认 5 行截断）
  unconfirmed?: boolean; // 琥珀"未确认"圆点
  editable?: boolean; // 进入编辑态（contenteditable）
  viewMode?: boolean; // 视图内卡片（时间线/最近）
  noShadow?: boolean;
}

export function tagBadges(n: Note): string {
  const parts: string[] = [];
  if (n.urgent) parts.push('<span class="badge urgent">⚡ 紧急</span>');
  if (n.timed != null) {
    const overdue = n.timed < nowMs();
    parts.push(
      `<span class="badge timed${overdue ? " overdue" : ""}">${overdue ? "🔴 已逾期 " : "⏰ "}${fmtTime(n.timed)}</span>`,
    );
  }
  return parts.join("");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function noteBodyHtml(n: Note, expanded: boolean): string {
  if (n.items.length > 0) {
    const rows = n.items
      .map(
        (it) =>
          `<label class="check-item${it.done ? " done" : ""}" data-item="${esc(it.id)}">
            <input type="checkbox" ${it.done ? "checked" : ""} />
            <span>${esc(it.text)}</span>
          </label>`,
      )
      .join("");
    return `<div class="title">${esc(titleOf(n))}</div>${rows}`;
  }
  const title = esc(titleOf(n));
  const body = esc(n.text.replace(/\n/g, "\n"));
  return `<div class="title">${title}</div><div class="text${expanded ? "" : " clamp5"}">${body}</div>`;
}

/** 桌面卡（画布窗口 / 拖拽层副本） */
export function buildCard(n: Note, css: CardCss, opts: CardOpts = {}): HTMLElement {
  const el = document.createElement("div");
  el.className = "note-card";
  el.dataset.flip = n.id;
  el.style.background = n.color;
  el.style.left = `${css.left}px`;
  el.style.top = `${css.top}px`;
  el.style.width = `${css.width}px`;
  el.style.minHeight = `${css.height}px`;
  if (opts.viewMode) el.classList.add("view-card");
  if (opts.noShadow) el.classList.add("no-shadow");
  if (n.merge_tree) el.classList.add("merged");

  el.innerHTML = `
    <div class="card-top">
      <div class="badges">${tagBadges(n)}</div>
      ${opts.unconfirmed ? '<span class="unconfirmed-dot" title="自动收回，未确认">●</span>' : ""}
    </div>
    <div class="card-body">${n.merge_tree ? mergeGridHtml(n) : noteBodyHtml(n, !!opts.expanded)}</div>
    <div class="expand-hint">⤢</div>
  `;
  return el;
}

function mergeGridHtml(n: Note): string {
  const cells = (n.merge_tree?.children ?? [])
    .map(
      (c) =>
        `<div class="merge-cell" style="background:${c.color}">
           <div class="merge-cell-title">${esc(titleOf(c))}</div>
         </div>`,
    )
    .join("");
  return `<div class="merge-grid">${cells}</div>`;
}

/** 边栏条目（标题 + 5 行截断；hover 抽屉露全文） */
export function buildEntry(n: Note, opts: { unconfirmed?: boolean } = {}): HTMLElement {
  const el = document.createElement("div");
  el.className = "sb-entry";
  el.dataset.flip = `entry-${n.id}`;
  el.innerHTML = `
    <div class="entry-head">
      <span class="entry-title">${esc(titleOf(n))}</span>
      <span class="entry-meta">${relAge(n)}${n.slot_id ? "" : ""}</span>
    </div>
    <div class="entry-badges">${tagBadges(n)}</div>
    <div class="entry-body clamp5">${esc(n.text.replace(/\n/g, "\n"))}</div>
    ${opts.unconfirmed ? '<span class="unconfirmed-dot" title="自动收回，待确认">●</span>' : ""}
    <div class="entry-drawer"><div class="drawer-body">${esc(n.text.replace(/\n/g, "\n"))}</div></div>
  `;
  return el;
}

/** 档案格成员（小卡） */
export function buildSlotMember(n: Note, css: RectLike): HTMLElement {
  const el = document.createElement("div");
  el.className = "slot-member";
  el.style.background = n.color;
  el.style.left = `${css.left}px`;
  el.style.top = `${css.top}px`;
  el.style.width = `${css.width}px`;
  el.style.height = `${css.height}px`;
  el.innerHTML = `
    <div class="slot-member-title">${esc(titleOf(n))}</div>
    <div class="slot-member-body clamp3">${esc(n.text.replace(/\n/g, "\n"))}</div>
  `;
  return el;
}

function relAge(n: Note): string {
  const diff = nowMs() - n.updated_at;
  const d = Math.floor(diff / 86_400_000);
  if (d < 1) return "今天";
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

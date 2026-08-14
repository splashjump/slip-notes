// 全局状态（Rust 唯一事实源；"state" 事件驱动，各窗口取所需）

import { listen } from "@tauri-apps/api/event";
import type { MonitorInfo } from "./geom";

export interface CheckItem {
  id: string;
  text: string;
  done: boolean;
}

export interface MergeTree {
  dir: string;
  children: Note[];
}

export interface Note {
  id: string;
  title?: string | null;
  text: string;
  items: CheckItem[];
  color: string;
  created_at: number;
  updated_at: number;
  urgent: boolean;
  timed: number | null;
  mode: "desk" | "archive";
  x: number;
  y: number;
  w: number;
  h: number;
  last_desk_pos: [number, number, number, number] | null;
  slot_id: string | null;
  merge_tree: MergeTree | null;
  deleted: boolean;
}

export interface Ephemeral {
  unconfirmed: string[];
  borrowing: string[];
  dragging: string | null;
}

export interface JournalMeta {
  seq: number;
  batch: string;
  author: string;
  name: string;
  args: Record<string, unknown>;
  time: number;
}

export interface AppState {
  notes: Note[];
  ephemeral: Ephemeral;
  monitors: MonitorInfo[];
  virtualRect: [number, number, number, number];
  primaryIndex: number;
  view: { name: string; label: string } | null;
  editing: string | null;
  fullscreenHidden: boolean[];
  sidebarCollapsed: boolean;
  sidebarRect: [number, number, number, number] | null; // 物理 px
  timeOffset: number; // store 时间偏移（debug.fastForward；逾期判定基准——Y5）
  journal: JournalMeta[];
}

let cur: AppState | null = null;
const subs = new Set<(s: AppState) => void>();

/**
 * 事件序纪律：initState() 是本模块唯一的 listen("state") 注册点，
 * 各窗口一律通过 onState 订阅（回调直接收到最新载荷）。
 * 禁止各窗口自行 listen("state") 后读 getState()——tauri 事件监听器按
 * LIFO 顺序执行（后注册先跑），后注册的窗口监听器会先于本监听器运行，
 * 读到的是上一个事件的旧载荷，导致渲染落后一拍（安静机器上确定性复现）。
 */
export function getState(): AppState | null {
  return cur;
}

/** store 时钟：真实时间 + timeOffset（逾期/相对时间判定基准；与 Rust 一致——Y5） */
export function nowMs(): number {
  return Date.now() + (cur?.timeOffset ?? 0);
}

export function onState(cb: (s: AppState) => void): void {
  if (cur) cb(cur);
  subs.add(cb);
}

export async function initState(): Promise<void> {
  await listen<AppState>("state", (e) => {
    cur = e.payload;
    for (const cb of subs) {
      try {
        cb(cur);
      } catch (err) {
        // 单订阅者异常不得中断其它订阅者（全部窗口依赖此唯一通道）
        console.error("[state] 订阅回调异常", err);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 派生查询
// ---------------------------------------------------------------------------

export function deskNotes(s: AppState, monIdx: number): Note[] {
  const m = s.monitors[monIdx];
  if (!m) return [];
  return s.notes.filter((n) => {
    if (n.mode !== "desk" || n.deleted) return false;
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    return cx >= m.rect[0] && cx < m.rect[2] && cy >= m.rect[1] && cy < m.rect[3];
  });
}

export function archiveFlat(s: AppState): Note[] {
  return s.notes.filter((n) => isArchive(n) && !n.slot_id);
}

export function archiveSlots(s: AppState): { slotId: string; notes: Note[] }[] {
  const map = new Map<string, Note[]>();
  for (const n of s.notes) {
    if (isArchive(n) && n.slot_id) {
      const list = map.get(n.slot_id) ?? [];
      list.push(n);
      map.set(n.slot_id, list);
    }
  }
  return [...map.entries()].map(([slotId, notes]) => ({ slotId, notes }));
}

/** 今日投影：紧急 + 定时；排序 逾期 > 紧急 > 定时（逾期基准 = store 时钟：真实时间 + timeOffset） */
export function todayEntries(s: AppState): Note[] {
  const now = Date.now() + (s.timeOffset ?? 0);
  const list = s.notes.filter((n) => isLive(n) && (n.urgent || n.timed != null));
  const score = (n: Note): number => {
    if (n.timed != null && n.timed < now) return 0; // 逾期置顶
    if (n.urgent) return 1;
    return 2;
  };
  return [...list].sort((a, b) => score(a) - score(b) || (a.timed ?? 0) - (b.timed ?? 0));
}

export function deletedNotes(s: AppState): Note[] {
  return s.notes.filter((n) => n.deleted);
}

export function isUnconfirmed(s: AppState, id: string): boolean {
  return s.ephemeral.unconfirmed.includes(id);
}

export function isDesk(n: Note): boolean {
  return n.mode === "desk" && !n.deleted;
}
export function isArchive(n: Note): boolean {
  return n.mode === "archive" && !n.deleted;
}
export function isLive(n: Note): boolean {
  return !n.deleted;
}

export function deskNotesByPos(s: AppState, x: number, y: number): Note[] {
  return s.notes.filter((n) => isDesk(n) && n.x === x && n.y === y);
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

export function titleOf(n: Note): string {
  if (n.title) return n.title;
  const first = n.text.split("\n")[0].trim();
  return first || "（无标题）";
}

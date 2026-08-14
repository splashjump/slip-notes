// 动作层调用（FORM-PLAN §5）：手势与 AI 指令同构
// invoke("action", {name, args, batch?, author?}) → {ok, notes?, error?, journal?}

import { invoke } from "@tauri-apps/api/core";

export interface ActReq {
  name: string;
  args?: Record<string, unknown>;
  batch?: string;
  author?: string;
}

export interface ActResp {
  ok: boolean;
  notes?: import("./state").Note[];
  error?: string;
  journal?: import("./state").JournalMeta;
}

export async function act(req: ActReq): Promise<ActResp> {
  try {
    return await invoke<ActResp>("action", { req });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

let batchCounter = 0;
/** 手势批次标记（一键撤销粒度） */
export function newBatch(): string {
  batchCounter += 1;
  return `g${Date.now()}-${batchCounter}`;
}

// ---- 便捷包装（最后一个可选参数 = batch 标记，用于一键撤销） ----

function withBatch(args: Record<string, unknown>, batch?: string): Record<string, unknown> {
  return batch ? { ...args, __batch: batch } : args;
}

export const actions = {
  create: (text = "", color?: string, x?: number, y?: number, batch?: string) =>
    act({ name: "create", args: withBatch({ text, color, x, y }, batch) }),
  editText: (id: string, text: string, batch?: string) =>
    act({ name: "editText", args: withBatch({ id, text }, batch) }),
  check: (id: string, itemId: string, done: boolean, batch?: string) =>
    act({ name: "check", args: withBatch({ id, itemId, done }, batch) }),
  move: (id: string, x: number, y: number, batch?: string) =>
    act({ name: "move", args: withBatch({ id, x, y }, batch) }),
  moveDir: (id: string, direction: string, batch?: string) =>
    act({ name: "move", args: withBatch({ id, direction }, batch) }),
  take: (id: string, x?: number, y?: number, batch?: string) =>
    act({ name: "take", args: withBatch({ id, x, y }, batch) }),
  store: (id: string, index?: number, batch?: string) =>
    act({ name: "store", args: withBatch({ id, index }, batch) }),
  joinSlot: (id: string, slotId: string, batch?: string) =>
    act({ name: "joinSlot", args: withBatch({ id, slotId }, batch) }),
  storeSlot: (ids: string[], batch?: string) => act({ name: "storeSlot", args: withBatch({ ids }, batch) }),
  archiveAll: (batch?: string) => act({ name: "archiveAll", args: withBatch({}, batch) }),
  tag: (id: string, tag: string, v: unknown, batch?: string) =>
    act({ name: "tag", args: withBatch({ id, tag, v }, batch) }),
  stack: (ids: string[], x: number, y: number, batch?: string) =>
    act({ name: "stack", args: withBatch({ ids, x, y }, batch) }),
  unstack: (id: string, batch?: string) => act({ name: "unstack", args: withBatch({ id }, batch) }),
  merge: (ids: string[], x: number, y: number, batch?: string) =>
    act({ name: "merge", args: withBatch({ ids, x, y }, batch) }),
  unmerge: (id: string, batch?: string) => act({ name: "unmerge", args: withBatch({ id }, batch) }),
  reorder: (id: string, toIndex: number, batch?: string) =>
    act({ name: "reorder", args: withBatch({ id, toIndex }, batch) }),
  del: (id: string, batch?: string) => act({ name: "delete", args: withBatch({ id }, batch) }),
  restore: (id: string, batch?: string) => act({ name: "restore", args: withBatch({ id }, batch) }),
  undoBatch: (batchId: string) => act({ name: "undoBatch", args: { batchId } }),
  confirm: (id: string) => act({ name: "confirm", args: { id } }),
  expand: () => act({ name: "expand", args: {} }),
  collapse: () => act({ name: "collapse", args: {} }),
  view: (name: string, open: boolean) => act({ name: "view", args: { name, open } }),
  toggleConsole: () => act({ name: "toggleConsole", args: {} }),
  fastForward: (days: number) => act({ name: "debug.fastForward", args: { days } }),
  autoArchive: () => act({ name: "debug.autoArchive", args: {} }),
  reset: () => act({ name: "debug.reset", args: {} }),
};

/** 定时 chips 默认值：今天 18:00（已过 → 明天 10:00），与 Rust default_timed 一致 */
export function defaultTimed(): number {
  const now = new Date();
  const today18 = new Date(now);
  today18.setHours(18, 0, 0, 0);
  if (today18.getTime() > now.getTime()) return today18.getTime();
  const tomorrow10 = new Date(now);
  tomorrow10.setDate(tomorrow10.getDate() + 1);
  tomorrow10.setHours(10, 0, 0, 0);
  return tomorrow10.getTime();
}

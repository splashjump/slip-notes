// 几何常量与换算 —— 与 Rust 侧 action.rs 常量对齐
// 坐标系：窗口内 = CSS px；全局 = 物理 px（虚拟屏）

export const SIDEBAR_W = 270;
export const QUICKBAR_W = 48;

export const PORTAL = {
  bandH: 96, // 20（上下 padding）+ 56（槽高），与 CSS .portal { padding: 20px 14px } 对齐
  slotW: 210,
  slotH: 56,
  gap: 16,
  padX: 14,
  totalW: 210 * 3 + 16 * 2 + 14 * 2, // 690（box-sizing: border-box，含左右 padding）
  bottomOffset: 14, // 与 CSS .portal { bottom: 14px } 对齐
};

export const CARD = { w: 220, h: 170 };
export const SLOT_H = 320; // 档案格高（CSS px，保证 ≥2 张平铺）
export const MERGE_HOLD_MS = 800; // 合并停留阈值
export const MAGNET_PX = 16; // 磁吸距离
export const TIMELINE_DRAG_PX = 80; // 时间线崩塌阈值

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MonitorInfo {
  rect: [number, number, number, number]; // 物理 px [l,t,r,b]
  dpi: number;
  primary: boolean;
}

export function monitorScale(m: MonitorInfo): number {
  return m.dpi / 96;
}

/** 显示器上的传送门光带（物理 px；底部距屏底 PORTAL.bottomOffset） */
export function portalBandPhys(m: MonitorInfo): Rect {
  const s = monitorScale(m);
  const w = PORTAL.totalW * s;
  const h = PORTAL.bandH * s;
  return {
    x: (m.rect[0] + m.rect[2]) / 2 - w / 2,
    y: m.rect[3] - PORTAL.bottomOffset * s - h,
    w,
    h,
  };
}

export function portalSlotsPhys(m: MonitorInfo): Rect[] {
  const s = monitorScale(m);
  const b = portalBandPhys(m);
  const y = b.y + (b.h - PORTAL.slotH * s) / 2;
  const out: Rect[] = [];
  for (let i = 0; i < 3; i++) {
    out.push({
      x: b.x + (PORTAL.padX + i * (PORTAL.slotW + PORTAL.gap)) * s,
      y,
      w: PORTAL.slotW * s,
      h: PORTAL.slotH * s,
    });
  }
  return out;
}

export function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 便签矩形与槽位水平重叠 ≥ 槽宽 50%（刷卡判定）且 y 在光带高度带内 */
export function slotSwipe(note: Rect, slot: Rect, y: number, bandTop: number, bandBottom: number): boolean {
  if (y < bandTop || y > bandBottom) return false;
  const overlap = Math.min(note.x + note.w, slot.x + slot.w) - Math.max(note.x, slot.x);
  return overlap >= slot.w * 0.5;
}

export const CARD_COLORS = [
  "#fff3b0",
  "#d8f3dc",
  "#ffd6e0",
  "#caf0f8",
  "#e7d8f8",
  "#ffe8cc",
  "#f0f7c8",
];

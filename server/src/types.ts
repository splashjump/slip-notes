/**
 * 纸筏服务器 — 共享类型定义（与 docs/protocol.md §3 一致）
 */

export interface Item {
  id: string;
  text: string;
  done: boolean;
  urgent: boolean;
  /** 定时项时间（ISO 8601）；服务器不解释，仅存储 */
  time: string | null;
}

export interface Position {
  x: number;
  y: number;
  monitor: number;
}

export interface Content {
  title: string | null;
  body_type: "text" | "checklist";
  /** body_type=text 时非空 */
  body: string | null;
  /** body_type=checklist 时非空 */
  items: Item[] | null;
  color: string | null;
  /** 仅 PC；服务器不解释 */
  position: Position | null;
}

/** 版本记录（所有读接口返回此形状，见协议 §3.2） */
export interface VersionRecord {
  id: string;
  /** 全局单调序号，只由服务器签发 */
  version: number;
  /** 客户端声称的作者（"device:win1" / "ai"） */
  author: string;
  /** token 身份（服务器核实） */
  actor: string;
  /** 写时客户端携带的基础版本；创建时 null */
  base_version: number | null;
  /** base_version < 写时 head → true（Q29 裁决：接受并标记） */
  conflict: boolean;
  /** conflict 时被跳过的本便签版本号（升序） */
  covered_versions: number[];
  content: Content;
  /** tombstone 标记 */
  deleted: boolean;
  updated_at: string;
}

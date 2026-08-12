import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Content, VersionRecord } from "./types.js";

export class NoteExistsError extends Error {
  constructor(public readonly noteId: string) {
    super(`便签已存在: ${noteId}`);
  }
}
export class NoteNotFoundError extends Error {
  constructor(public readonly noteId: string) {
    super(`便签不存在: ${noteId}`);
  }
}
export class VersionNotFoundError extends Error {
  constructor(public readonly noteId: string, public readonly version: number) {
    super(`版本不存在: ${noteId}@${version}`);
  }
}

/** 一次写操作（创建/更新/删除/还原），全部走同一路径 → 产生一个新版本 */
export interface WriteInput {
  kind: "create" | "update" | "delete" | "restore";
  noteId: string;
  author: string;
  actor: string;
  /** update/delete 必带；create 为 null；restore 由服务器取写时 head */
  baseVersion: number | null;
  content: Content;
  /** delete 为 true；restore 由历史版本决定 */
  deleted: boolean;
  /** kind=restore：要还原的历史版本号 */
  restoreFrom?: number;
}

interface VersionRow {
  version: number;
  note_id: string;
  author: string;
  actor: string;
  base_version: number | null;
  conflict: number;
  content: string;
  deleted: number;
  updated_at: string;
}

interface HeadRow {
  head_version: number;
  deleted: number;
}

export class SlipDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_versions (
        version INTEGER PRIMARY KEY AUTOINCREMENT,  -- 全局单调序号，唯一由服务器签发
        note_id TEXT NOT NULL,
        author TEXT NOT NULL,
        actor TEXT NOT NULL,
        base_version INTEGER,
        conflict INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, version);

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        head_version INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
  }

  /** 全部写操作的单一路径：事务内裁决 + 签发新版本号（铁律 1/2/4/5/6） */
  write(input: WriteInput): VersionRecord {
    const tx = this.db.transaction(() => this.writeTx(input));
    return tx();
  }

  private writeTx(input: WriteInput): VersionRecord {
    const head = this.db
      .prepare("SELECT head_version, deleted FROM notes WHERE id = ?")
      .get(input.noteId) as HeadRow | undefined;

    let base: number | null = null;
    let content: Content;
    let deleted: boolean;
    let covered: number[] = [];

    switch (input.kind) {
      case "create": {
        if (head) throw new NoteExistsError(input.noteId);
        base = null;
        content = input.content;
        deleted = false;
        break;
      }
      case "update": {
        if (!head) throw new NoteNotFoundError(input.noteId);
        if (input.baseVersion === null) {
          throw new Error("内部错误: update 必须携带 base_version（校验层应已拦截）");
        }
        base = input.baseVersion;
        content = input.content;
        deleted = false;
        break;
      }
      case "delete": {
        if (!head) throw new NoteNotFoundError(input.noteId);
        if (input.baseVersion === null) {
          throw new Error("内部错误: delete 必须携带 base_version（校验层应已拦截）");
        }
        base = input.baseVersion;
        // tombstone 版本携带删除前内容快照（协议 §3.2）
        const headRow = this.versionRow(input.noteId, head.head_version);
        if (!headRow) throw new Error("内部错误: head 版本行缺失（数据损坏）");
        content = headRow.content;
        deleted = true;
        break;
      }
      case "restore": {
        if (!head) throw new NoteNotFoundError(input.noteId);
        const from = input.restoreFrom;
        if (from === undefined) throw new Error("内部错误: restore 必须携带历史版本号");
        const hist = this.versionRow(input.noteId, from);
        if (!hist) throw new VersionNotFoundError(input.noteId, from);
        // 还原 = 写新版本：base = 写时 head（服务器裁决），内容取历史版本
        base = head.head_version;
        content = hist.content;
        deleted = hist.deleted === 1;
        break;
      }
    }

    // Q29 裁决：陈旧写入接受并标记 conflict，附被跳过的本便签版本号
    if (head && base !== null && base < head.head_version) {
      const rows = this.db
        .prepare(
          "SELECT version FROM note_versions WHERE note_id = ? AND version > ? AND version <= ? ORDER BY version",
        )
        .all(input.noteId, base, head.head_version) as { version: number }[];
      covered = rows.map((r) => r.version);
    }

    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO note_versions (note_id, author, actor, base_version, conflict, content, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.noteId,
        input.author,
        input.actor,
        base,
        head && base !== null && base < head.head_version ? 1 : 0,
        JSON.stringify(content),
        deleted ? 1 : 0,
        now,
      );
    const version = Number(info.lastInsertRowid);

    if (head) {
      this.db
        .prepare("UPDATE notes SET head_version = ?, deleted = ? WHERE id = ?")
        .run(version, deleted ? 1 : 0, input.noteId);
    } else {
      this.db
        .prepare("INSERT INTO notes (id, head_version, deleted, created_at) VALUES (?, ?, ?, ?)")
        .run(input.noteId, version, deleted ? 1 : 0, now);
    }

    return {
      id: input.noteId,
      version,
      author: input.author,
      actor: input.actor,
      base_version: base,
      conflict: covered.length > 0,
      covered_versions: covered,
      content,
      deleted,
      updated_at: now,
    };
  }

  private versionRow(noteId: string, version: number): (Omit<VersionRow, "content"> & { content: Content }) | undefined {
    const row = this.db
      .prepare("SELECT * FROM note_versions WHERE note_id = ? AND version = ?")
      .get(noteId, version) as VersionRow | undefined;
    if (!row) return undefined;
    const { content: _raw, ...rest } = row;
    return { ...rest, content: JSON.parse(row.content) as Content };
  }

  private toRecord(row: VersionRow): VersionRecord {
    const content = JSON.parse(row.content) as Content;
    let covered: number[] = [];
    if (row.conflict === 1 && row.base_version !== null) {
      const rows = this.db
        .prepare(
          "SELECT version FROM note_versions WHERE note_id = ? AND version > ? AND version < ? ORDER BY version",
        )
        .all(row.note_id, row.base_version, row.version) as { version: number }[];
      covered = rows.map((r) => r.version);
    }
    return {
      id: row.note_id,
      version: row.version,
      author: row.author,
      actor: row.actor,
      base_version: row.base_version,
      conflict: row.conflict === 1,
      covered_versions: covered,
      content,
      deleted: row.deleted === 1,
      updated_at: row.updated_at,
    };
  }

  getHead(noteId: string): VersionRecord | undefined {
    const head = this.db.prepare("SELECT head_version FROM notes WHERE id = ?").get(noteId) as
      | { head_version: number }
      | undefined;
    if (!head) return undefined;
    const row = this.db
      .prepare("SELECT * FROM note_versions WHERE note_id = ? AND version = ?")
      .get(noteId, head.head_version) as VersionRow;
    return this.toRecord(row);
  }

  getVersions(noteId: string): VersionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM note_versions WHERE note_id = ? ORDER BY version")
      .all(noteId) as VersionRow[];
    return rows.map((r) => this.toRecord(r));
  }

  listHeads(): VersionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM note_versions v
         JOIN notes n ON n.id = v.note_id AND n.head_version = v.version
         ORDER BY v.note_id`,
      )
      .all() as VersionRow[];
    return rows.map((r) => this.toRecord(r));
  }

  /** 增量同步（协议 §4.9）：changes 按 version 升序 */
  sync(since: number, limit: number): { changes: VersionRecord[]; latest_version: number; has_more: boolean } {
    const rows = this.db
      .prepare("SELECT * FROM note_versions WHERE version > ? ORDER BY version LIMIT ?")
      .all(since, limit + 1) as VersionRow[];
    const has_more = rows.length > limit;
    return {
      changes: rows.slice(0, limit).map((r) => this.toRecord(r)),
      latest_version: this.latestVersion(),
      has_more,
    };
  }

  latestVersion(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM note_versions").get() as { v: number };
    return row.v;
  }

  close(): void {
    this.db.close();
  }
}

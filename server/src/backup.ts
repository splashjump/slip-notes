/**
 * 数据库备份脚本（宿主机 cron 调用：docker exec slip-sync node dist/src/backup.js）
 * 用 SQLite backup API 做在线一致性快照，并清理超过 SLIP_BACKUP_KEEP 份的旧备份。
 */
import Database from "better-sqlite3";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const dbPath = process.env.SLIP_DB_PATH ?? "./data/slip.db";
const backupDir = process.env.SLIP_BACKUP_DIR ?? "./data/backups";
const keep = Math.max(1, Number(process.env.SLIP_BACKUP_KEEP ?? 14));

mkdirSync(backupDir, { recursive: true });

const db = new Database(dbPath, { readonly: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(backupDir, `slip-${stamp}.db`);
await db.backup(target);
db.close();

const files = readdirSync(backupDir)
  .filter((f) => /^slip-\d{4}-\d{2}-\d{2}T.*\.db$/.test(f))
  .sort();
while (files.length > keep) {
  const victim = files.shift();
  if (victim) unlinkSync(join(backupDir, victim));
}

console.log(`backup ok → ${target}（保留最近 ${keep} 份，现存 ${files.length} 份）`);

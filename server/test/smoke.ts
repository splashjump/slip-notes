/**
 * 生产服务器端到端冒烟：REST 全链路 + WS 广播 + 游标同步（用真实 token）
 * 运行：npx tsx test/smoke.ts
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 直接读仓库根 .env（避免 shell 传参吃掉 JSON 引号）
const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
const env: Record<string, string> = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2]!;
}

const BASE = `http://${env.SSH_HOST ?? "101.37.160.131"}:50000/api/v1`;
const TOKENS = JSON.parse(env.SLIP_TOKENS ?? "{}") as Record<string, string>;

const api = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const content = (body: string) => ({
  title: null,
  body_type: "text",
  body,
  items: null,
  color: null,
  position: null,
});

// 1. health
const health = await fetch(BASE.replace("/api/v1", "/api/v1/health"));
console.log("1. health:", health.status, await health.json());

// 2. WS 监听（win2 视角）
const ws = new WebSocket(BASE.replace(/^http/, "ws").replace("/api/v1", "/api/v1/ws") + `?token=${TOKENS.win2}`);
const wsMessages: any[] = [];
ws.on("message", (d) => wsMessages.push(JSON.parse(String(d))));
await new Promise((r) => ws.on("open", r));
const hello: any = await new Promise((r) => {
  const h = () => {
    if (wsMessages.length) r(wsMessages.shift());
    else setTimeout(h, 50);
  };
  h();
});
console.log("2. ws hello:", hello.type, "latest_version:", hello.latest_version);

// 3. 创建便签（win1）
const created = await api("POST", "/notes", TOKENS.win1, {
  id: "smoke-" + Date.now(),
  author: "device:win1",
  content: content("部署冒烟测试便签"),
});
console.log("3. create:", created.status, "version:", created.body.version, "actor:", created.body.actor);

// 4. 更新（base=创建版本）
const updated = await api("PUT", `/notes/${created.body.id}`, TOKENS.win1, {
  author: "device:win1",
  base_version: created.body.version,
  content: content("部署冒烟测试便签（已更新）"),
});
console.log("4. update:", updated.status, "version:", updated.body.version);

// 5. 陈旧写入 → conflict（win2 用旧 base）
const stale = await api("PUT", `/notes/${created.body.id}`, TOKENS.win2, {
  author: "device:win2",
  base_version: created.body.version,
  content: content("部署冒烟测试便签（陈旧写入）"),
});
console.log("5. stale:", stale.status, "conflict:", stale.body.conflict, "covered:", stale.body.covered_versions);

// 6. 游标同步（android）
const synced = await api("GET", `/sync?since=${hello.latest_version}`, TOKENS.android);
console.log("6. sync:", synced.status, "changes:", synced.body.changes.length, "latest:", synced.body.latest_version);

// 7. WS 广播验证（win2 应收到 3 条 note_changed）
await new Promise((r) => setTimeout(r, 800));
const noteChanged = wsMessages.filter((m) => m.type === "note_changed");
console.log("7. ws 广播收到:", noteChanged.length, "条 note_changed（期望 3）");
ws.close();

// 8. tombstone 清理冒烟便签（历史保留）
const del = await api("DELETE", `/notes/${created.body.id}`, TOKENS.win1, {
  author: "device:win1",
  base_version: stale.body.version,
});
console.log("8. tombstone:", del.status, "deleted:", del.body.deleted);

console.log("冒烟完成 ✓");

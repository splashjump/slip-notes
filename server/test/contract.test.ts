/**
 * 服务器 API 权威契约测试 —— 逐条强制 docs/protocol.md。
 * 铁律（GRILL-PLAN §4）：版本号只由服务器签发 / 陈旧写入裁决 / 删除=tombstone /
 * 还原=写新版本 / 全量历史保留。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  api,
  checklistNote,
  startTestServer,
  textNote,
  wsConnect,
  type TestApp,
} from "./helpers.js";
import type { VersionRecord } from "../src/types.js";

let app: TestApp;
let baseUrl: string;

before(async () => {
  app = await startTestServer();
  baseUrl = app.baseUrl;
});

after(async () => {
  await app.close();
  app.cleanup();
});

// ---------- §4.1 健康检查（免鉴权） ----------

test("GET /health 免鉴权，返回服务名与 latest_version", async () => {
  const res = await api(baseUrl, "GET", "/api/v1/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok", name: "slip-sync", version: "0.1.0", latest_version: 0 });
});

// ---------- §2 鉴权 ----------

test("鉴权：缺 token / 错 token → 401 unauthorized（错误格式 §4.10）", async () => {
  const noToken = await api(baseUrl, "GET", "/api/v1/notes");
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.error.code, "unauthorized");

  const badToken = await api(baseUrl, "GET", "/api/v1/notes", { token: "wrong-token" });
  assert.equal(badToken.status, 401);
  assert.equal(badToken.body.error.code, "unauthorized");
});

test("鉴权：未知路径不要求 token（先 404）", async () => {
  const res = await api(baseUrl, "GET", "/api/v1/nope");
  assert.equal(res.status, 404);
});

// ---------- §4.2 创建 ----------

test("POST /notes：201，version=1 由服务器签发，base_version=null，actor 来自 token，author 来自载荷", async () => {
  const res = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-a", author: "device:win1", content: textNote("第一条便签") },
  });
  assert.equal(res.status, 201);
  const v: VersionRecord = res.body;
  assert.equal(v.version, 1);
  assert.equal(v.base_version, null);
  assert.equal(v.conflict, false);
  assert.deepEqual(v.covered_versions, []);
  assert.equal(v.author, "device:win1");
  assert.equal(v.actor, "win1");
  assert.equal(v.deleted, false);
  assert.equal(v.content.body, "第一条便签");
  assert.ok(!Number.isNaN(Date.parse(v.updated_at)), "updated_at 应为合法 ISO 时间");
});

test("POST /notes：缺省 id 由服务器生成（UUID）", async () => {
  const res = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-ai",
    body: { author: "ai", content: textNote("无 id") },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("POST /notes：重复 id → 409 conflict", async () => {
  const res = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-a", author: "device:win1", content: textNote("x") },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "conflict");
});

test("POST /notes：内容校验失败 → 400 validation_failed（checklist 缺 items / 未知字段 / id 非法）", async () => {
  const noItems = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { author: "device:win1", content: { body_type: "checklist", title: null, body: null, color: null, position: null } },
  });
  assert.equal(noItems.status, 400);
  assert.equal(noItems.body.error.code, "validation_failed");

  const unknownField = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { author: "device:win1", content: textNote("x"), hack: 1 },
  });
  assert.equal(unknownField.status, 400);

  const badId = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "非法 id!", author: "device:win1", content: textNote("x") },
  });
  assert.equal(badId.status, 400);
});

test("POST /notes：非 JSON 请求体 → 400", async () => {
  const res = await fetch(`${baseUrl}/api/v1/notes`, {
    method: "POST",
    headers: { authorization: "Bearer test-token-win1", "content-type": "application/json" },
    body: "not json",
  });
  assert.equal(res.status, 400);
  const errBody: any = await res.json();
  assert.equal(errBody.error.code, "validation_failed");
});

// ---------- §4.3 更新 ----------

test("PUT /notes/:id：版本递增，base_version 如实记录", async () => {
  const created = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-upd", author: "device:win1", content: textNote("原始") },
  });
  const v1 = created.body.version as number;
  const res = await api(baseUrl, "PUT", "/api/v1/notes/note-upd", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: v1, content: textNote("更新后的内容") },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.version, v1 + 1, "版本号 = 服务器序列下一号");
  assert.equal(res.body.base_version, v1);
  assert.equal(res.body.conflict, false);
});

test("PUT /notes/:id：不存在 → 404 not_found", async () => {
  const res = await api(baseUrl, "PUT", "/api/v1/notes/ghost", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: 1, content: textNote("x") },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "not_found");
});

test("PUT：缺 base_version → 400（更新必须携带基础版本）", async () => {
  const res = await api(baseUrl, "PUT", "/api/v1/notes/note-a", {
    token: "test-token-win1",
    body: { author: "device:win1", content: textNote("x") },
  });
  assert.equal(res.status, 400);
});

// ---------- Q29：陈旧写入裁决（协议 §1） ----------

test("陈旧写入：接受并标记 conflict + covered_versions，不拒绝（Q29）", async () => {
  const created = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-stale", author: "device:win1", content: textNote("v1") },
  });
  const v1 = created.body.version as number;

  // win2 基于 v1 更新 → v2
  const fresh = await api(baseUrl, "PUT", "/api/v1/notes/note-stale", {
    token: "test-token-win2",
    body: { author: "device:win2", base_version: v1, content: textNote("v2 from win2") },
  });
  assert.equal(fresh.status, 200);
  const v2 = fresh.body.version as number;
  assert.equal(v2, v1 + 1);

  // win1 离线编辑后带着旧 base_version 回来 → 接受，标记 conflict，covered=[v2]
  const stale = await api(baseUrl, "PUT", "/api/v1/notes/note-stale", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: v1, content: textNote("v3 from win1 (stale)") },
  });
  assert.equal(stale.status, 200, "陈旧写入不得被拒绝");
  assert.equal(stale.body.conflict, true);
  assert.deepEqual(stale.body.covered_versions, [v2]);
  assert.equal(stale.body.version, v2 + 1);

  // head 是被接受的陈旧写入（LWW：后写者胜）
  const head = await api(baseUrl, "GET", "/api/v1/notes/note-stale", { token: "test-token-win1" });
  assert.equal(head.body.version, v2 + 1);
  assert.equal(head.body.content.body, "v3 from win1 (stale)");

  // 被覆盖内容仍在历史中（不静默丢东西）
  const hist = await api(baseUrl, "GET", "/api/v1/notes/note-stale/versions", { token: "test-token-win1" });
  assert.deepEqual(
    hist.body.versions.map((v: VersionRecord) => v.content.body),
    ["v1", "v2 from win2", "v3 from win1 (stale)"],
  );
});

test("陈旧删除（tombstone 也走冲突裁决）", async () => {
  const created = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-stale-del", author: "device:win1", content: textNote("v1") },
  });
  const v1 = created.body.version as number;
  const upd = await api(baseUrl, "PUT", "/api/v1/notes/note-stale-del", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: v1, content: textNote("v2") },
  });
  const v2 = upd.body.version as number;

  const del = await api(baseUrl, "DELETE", "/api/v1/notes/note-stale-del", {
    token: "test-token-win2",
    body: { author: "device:win2", base_version: v1 }, // 陈旧：head 已是 v2
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.conflict, true);
  assert.deepEqual(del.body.covered_versions, [v2]);
  assert.equal(del.body.deleted, true);
  // tombstone 内容快照 = 写时 head（v2）
  assert.equal(del.body.content.body, "v2");
});

// ---------- §4.4 删除 tombstone / 铁律 5 ----------

test("DELETE：tombstone 新版本，content 为删除前快照，head 仍可查，历史保留", async () => {
  const created = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-del", author: "device:win1", content: textNote("将被删除") },
  });
  const v1 = created.body.version as number;
  const del = await api(baseUrl, "DELETE", "/api/v1/notes/note-del", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: v1 },
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  assert.equal(del.body.conflict, false, "base 是最新 → 不是冲突");
  assert.equal(del.body.content.body, "将被删除");

  // head 可查且为 tombstone
  const head = await api(baseUrl, "GET", "/api/v1/notes/note-del", { token: "test-token-win1" });
  assert.equal(head.status, 200);
  assert.equal(head.body.deleted, true);

  // 列表里也出现（含 tombstone）
  const list = await api(baseUrl, "GET", "/api/v1/notes", { token: "test-token-win1" });
  const found = list.body.notes.find((n: VersionRecord) => n.id === "note-del");
  assert.ok(found);
  assert.equal(found.deleted, true);

  // 删除不存在 → 404
  const ghost = await api(baseUrl, "DELETE", "/api/v1/notes/ghost", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: v1 },
  });
  assert.equal(ghost.status, 404);
});

test("删除后更新 = 还原 + 更新（新版本 deleted=false，协议 §4.3）", async () => {
  // note-del 已 tombstone，head 版本是上一步删除写入的版本
  const head = await api(baseUrl, "GET", "/api/v1/notes/note-del", { token: "test-token-win1" });
  const tombVersion = head.body.version as number;
  const res = await api(baseUrl, "PUT", "/api/v1/notes/note-del", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: tombVersion, content: textNote("复活") },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, false);
  assert.equal(res.body.content.body, "复活");
});

// ---------- §4.5 还原（铁律 4：写新版本，不回拨） ----------

test("POST /restore：按历史版本写一个新版本，内容取自历史，版本号继续递增", async () => {
  const created = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-rs", author: "device:win1", content: textNote("v1 原始") },
  });
  const v1 = created.body.version as number;
  const upd = await api(baseUrl, "PUT", "/api/v1/notes/note-rs", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: v1, content: textNote("v2 改坏了") },
  });
  const v2 = upd.body.version as number;

  const restore = await api(baseUrl, "POST", "/api/v1/notes/note-rs/restore", {
    token: "test-token-win1",
    body: { author: "device:win1", version: v1 },
  });
  assert.equal(restore.status, 200);
  assert.ok(restore.body.version > v2, "还原必须写新版本号，绝不回拨");
  assert.equal(restore.body.content.body, "v1 原始");
  assert.equal(restore.body.deleted, false);
  assert.equal(restore.body.base_version, v2, "还原的 base = 服务器写时 head");
  assert.equal(restore.body.conflict, false);

  // 历史升序全量保留
  const hist = await api(baseUrl, "GET", "/api/v1/notes/note-rs/versions", { token: "test-token-win1" });
  assert.deepEqual(
    hist.body.versions.map((v: VersionRecord) => v.version),
    [v1, v2, restore.body.version],
  );
});

test("还原 tombstone 版本 → 还原后仍为 tombstone", async () => {
  // note-del 历史：v1 创建, v2 删除, v3 复活。还原 v2（tombstone）
  const created = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-del2", author: "device:win1", content: textNote("将被删除") },
  });
  const v1 = created.body.version as number;
  const del = await api(baseUrl, "DELETE", "/api/v1/notes/note-del2", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: v1 },
  });
  const v2 = del.body.version as number;
  await api(baseUrl, "PUT", "/api/v1/notes/note-del2", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: v2, content: textNote("复活") },
  });

  const res = await api(baseUrl, "POST", "/api/v1/notes/note-del2/restore", {
    token: "test-token-win1",
    body: { author: "device:win1", version: v2 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);
  assert.equal(res.body.content.body, "将被删除");
});

test("还原：版本不存在 / 属于其他便签 → 404", async () => {
  const noVer = await api(baseUrl, "POST", "/api/v1/notes/note-rs/restore", {
    token: "test-token-win1",
    body: { author: "device:win1", version: 9999 },
  });
  assert.equal(noVer.status, 404);

  const otherNote = await api(baseUrl, "POST", "/api/v1/notes/note-rs/restore", {
    token: "test-token-win1",
    body: { author: "device:win1", version: 1 }, // 属于 note-a 的 v1
  });
  assert.equal(otherNote.status, 404);
});

// ---------- §4.6/§4.8 列表与历史 ----------

test("GET /notes：全部便签 head（按 id 排序，含 tombstone）", async () => {
  const res = await api(baseUrl, "GET", "/api/v1/notes", { token: "test-token-android" });
  assert.equal(res.status, 200);
  const ids = res.body.notes.map((n: VersionRecord) => n.id);
  assert.deepEqual(ids, [...ids].sort(), "应按 id 排序");
  // 每个 head 的 version 应是该便签最新
  for (const n of res.body.notes) {
    assert.ok(n.version > 0);
  }
});

test("GET /notes/:id/versions：不存在的便签返回空数组（非 404）", async () => {
  const res = await api(baseUrl, "GET", "/api/v1/notes/ghost/versions", { token: "test-token-win1" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.versions, []);
});

// ---------- §4.9 同步游标 ----------

test("GET /sync：since=0 全量回放，按 version 升序，latest_version 正确", async () => {
  const res = await api(baseUrl, "GET", "/api/v1/sync?since=0&limit=5000", { token: "test-token-android" });
  assert.equal(res.status, 200);
  const { changes, latest_version, has_more } = res.body;
  assert.equal(has_more, false);
  assert.equal(latest_version, app.db.latestVersion());
  assert.equal(changes.length, latest_version, "全量回放应包含全部版本");
  const versions = changes.map((c: VersionRecord) => c.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), "changes 必须按 version 升序");
});

test("GET /sync：增量 + 分页 has_more + 游标推进", async () => {
  const latest = app.db.latestVersion();
  const page1 = await api(baseUrl, "GET", `/api/v1/sync?since=0&limit=2`, { token: "test-token-win1" });
  assert.equal(page1.body.changes.length, 2);
  assert.equal(page1.body.has_more, true);
  assert.equal(page1.body.latest_version, latest);

  const cursor = page1.body.changes[1].version as number;
  const page2 = await api(baseUrl, "GET", `/api/v1/sync?since=${cursor}&limit=5000`, { token: "test-token-win1" });
  assert.equal(page2.body.has_more, false);
  assert.equal(page2.body.changes.length, latest - cursor);

  // since = 当前最新 → 空
  const empty = await api(baseUrl, "GET", `/api/v1/sync?since=${latest}`, { token: "test-token-win1" });
  assert.deepEqual(empty.body.changes, []);
});

test("GET /sync：非法参数 → 400；limit 超上限 → 400", async () => {
  assert.equal((await api(baseUrl, "GET", "/api/v1/sync?since=abc", { token: "test-token-win1" })).status, 400);
  assert.equal((await api(baseUrl, "GET", "/api/v1/sync?since=-1", { token: "test-token-win1" })).status, 400);
  assert.equal((await api(baseUrl, "GET", "/api/v1/sync?limit=5001", { token: "test-token-win1" })).status, 400);
  assert.equal((await api(baseUrl, "GET", "/api/v1/sync?limit=0", { token: "test-token-win1" })).status, 400);
});

// ---------- 铁律 1：版本号只由服务器签发，全局单调 ----------

test("全局版本号跨便签单调递增（铁律 1）", async () => {
  const before = app.db.latestVersion();
  const a = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "mono-a", author: "device:win1", content: textNote("a") },
  });
  const b = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win2",
    body: { id: "mono-b", author: "device:win2", content: textNote("b") },
  });
  assert.equal(a.body.version, before + 1);
  assert.equal(b.body.version, before + 2);
  // 客户端编造的版本号无效：base_version 只是参照物，签发权在服务器
  const forged = await api(baseUrl, "PUT", "/api/v1/notes/mono-a", {
    token: "test-token-win1",
    body: { author: "device:win1", base_version: 999999, content: textNote("x") },
  });
  assert.equal(forged.status, 200);
  assert.equal(forged.body.version, before + 3, "版本号必须是服务器序列的下一号，而非 1000000");
});

// ---------- author/actor 分离（AI 通道） ----------

test("author/actor 分离：win1 的 token 可以写 author=ai（AI 经 Win 本地接口的操作痕迹）", async () => {
  const res = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win1",
    body: { id: "note-ai", author: "ai", content: checklistNote([{ id: "i1", text: "AI 建的清单项", done: false, urgent: false, time: null }]) },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.author, "ai");
  assert.equal(res.body.actor, "win1");
  assert.equal(res.body.content.items[0].text, "AI 建的清单项");
});

// ---------- §5 WebSocket ----------

test("ws：无效 token → 握手 401", async () => {
  const client = wsConnect(baseUrl, "wrong-token");
  const result = await Promise.race([
    client.handshake.then((status) => ({ status })),
    client.closed.then(({ code }) => ({ code })),
  ]);
  assert.ok(
    (result as { status?: number }).status === 401 || (result as { code?: number }).code === 1006,
    `握手应被拒：${JSON.stringify(result)}`,
  );
});

test("ws：连接即收 hello（含 latest_version）", async () => {
  const client = wsConnect(baseUrl, "test-token-win1");
  const hello = await client.next();
  assert.equal(hello.type, "hello");
  assert.equal(hello.latest_version, app.db.latestVersion());
  client.ws.close();
});

test("ws：写操作广播 note_changed 给所有连接，消息与 REST 响应一致", async () => {
  const c1 = wsConnect(baseUrl, "test-token-win1");
  const c2 = wsConnect(baseUrl, "test-token-android");
  await c1.next();
  await c2.next();

  const res = await api(baseUrl, "POST", "/api/v1/notes", {
    token: "test-token-win2",
    body: { id: "note-ws", author: "device:win2", content: textNote("广播我") },
  });

  const m1 = await c1.next();
  const m2 = await c2.next();
  assert.equal(m1.type, "note_changed");
  assert.deepEqual(m1.version, res.body, "广播版本记录应与 REST 响应完全一致");
  assert.deepEqual(m2.version, res.body);

  c1.ws.close();
  c2.ws.close();
});

test("ws：心跳——不回应 ping 的死连接被服务器断开", async () => {
  // autoPong=false：客户端不回协议级 pong → 连续 2 次（~300ms）后服务器 terminate
  const client = wsConnect(baseUrl, "test-token-win1", { autoPong: false });
  await client.next(); // hello
  const { code } = await Promise.race([
    client.closed,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("死连接未被断开")), 3000)),
  ]);
  assert.ok([1001, 1006].includes(code), `服务器应主动断开，实际 code=${code}`);
});

test("ws：正常客户端跨过多个心跳周期仍存活", async () => {
  const client = wsConnect(baseUrl, "test-token-win1");
  await client.next();
  await new Promise((r) => setTimeout(r, 700)); // > 4 个 ping 周期
  assert.equal(client.ws.readyState, 1, "OPEN");
  client.ws.close();
});

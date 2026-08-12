# 纸筏服务器协议 v1（权威契约）

> 本文件定义 server API 的逐字段契约；`server/test/contract.test.ts` 逐条强制本契约。
> 设计原则见 GRILL-PLAN.md §3/§4/§10。任何修改先改 GRILL-PLAN，再改本文件，再改代码。

## 1. 核心模型

- 唯一实体：**note（便签）**。内容为 JSON（见 §3）。
- **版本号只由服务器签发**：全局单调递增序号（整数，从 1 起），客户端不生成版本号。
- 每次写操作（创建/更新/删除/还原）产生一个**新版本**，永久保留（全量历史）。
- 删除 = tombstone：写一个 `deleted: true` 的新版本，历史不删。
- 还原 = 写一个**新版本**（`deleted: false` + 指定内容），**绝不回拨版本号**。
- 写入携带 `base_version`（客户端所基于的版本；创建时为 `null`）。
- **陈旧写入裁决（Q29）**：`base_version < 服务器当前 head` → **接受**，新版本标记 `conflict: true`，
  响应附 `covered_versions`（被跳过的本便签版本号）。服务器**不拒绝**陈旧写入，不阻塞同步。
- 裁决只认服务器序列；`updated_at` 由服务器生成（ISO 8601 UTC）。

## 2. 鉴权

- 除 `GET /health` 外，所有端点要求 `Authorization: Bearer <token>`（WebSocket 用查询参数 `?token=`）。
- 服务器配置固定 token 集合：`win1` / `win2` / `android` / `ai`（每设备一个，含 AI 专用）。
- 无 token / 无效 token → `401 unauthorized`。
- 每个版本记录 `actor`（token 身份，服务器核实）与 `author`（客户端声称，如 `"device:win1"` / `"ai"`）。

## 3. 数据形状

### 3.1 content（便签内容，写请求与版本记录中均为此形状）

```jsonc
{
  "title": "string | null",            // 可选标题
  "body_type": "text" | "checklist",
  "body": "string | null",             // body_type=text 时必填（纯文本，换行+链接）
  "items": [                            // body_type=checklist 时必填（可为空数组）
    { "id": "string", "text": "string", "done": false, "urgent": false,
      "time": "ISO8601 | null" }        // time=定时项；服务器不解释，仅存储
  ],
  "color": "string | null",             // 便签颜色
  "position": { "x": 0, "y": 0, "monitor": 0 } | null   // 仅 PC；服务器不解释
}
```

### 3.2 版本记录（所有读接口返回此形状）

```jsonc
{
  "id": "note-uuid",                  // 便签 id（客户端生成）
  "version": 42,                      // 全局单调序号（服务器签发）
  "author": "device:win1",            // 客户端声称
  "actor": "win1",                    // token 身份（服务器核实）
  "base_version": 41,                 // 写时携带；创建时 null
  "conflict": false,                  // base_version < 写时 head → true
  "covered_versions": [],             // conflict 时：被跳过的本便签版本号（升序）
  "content": { ... },                 // §3.1；tombstone 版本为写前内容快照
  "deleted": false,                   // tombstone 标记
  "updated_at": "2026-08-12T15:30:00.000Z"
}
```

## 4. REST 端点（base = `/api/v1`）

### 4.1 `GET /health`（无鉴权）

`200` → `{ "status": "ok", "name": "slip-sync", "version": "0.1.0", "latest_version": 130 }`

### 4.2 `POST /notes` — 创建

请求：`{ "id": "uuid", "author": "string", "base_version": null, "content": {...} }`

- `id` 可选：缺省由服务器生成（UUID）；已存在 → `409 conflict`。
- 响应 `201` → 版本记录（`base_version: null`，`conflict: false`）。

### 4.3 `PUT /notes/:id` — 更新

请求：`{ "author": "string", "base_version": 42, "content": {...} }`

- 便签不存在 → `404 not_found`。
- 便签当前是 tombstone → 允许（等价于还原 + 更新，新版本 `deleted: false`）。
- 响应 `200` → 版本记录。

### 4.4 `DELETE /notes/:id` — 删除（tombstone）

请求：`{ "author": "string", "base_version": 42 }`

- 响应 `200` → 版本记录（`deleted: true`，`content` = 删除前内容快照）。

### 4.5 `POST /notes/:id/restore` — 还原历史版本（写新版本）

请求：`{ "author": "string", "version": 39 }`（`version` = 该便签任一历史版本号）

- `version` 不存在或不属于该便签 → `404 not_found`。
- 还原版本本身是 tombstone → 还原为 `deleted: true`。
- 响应 `200` → 新版本记录（新版本号，`base_version` = 服务器写时 head）。

### 4.6 `GET /notes` — 全部便签 head 列表

`200` → `{ "notes": [ 版本记录, ... ] }`（每便签当前 head，含 tombstone，按 id 排序）

### 4.7 `GET /notes/:id` — 单便签 head

`200` → 版本记录；不存在 → `404`。

### 4.8 `GET /notes/:id/versions` — 单便签全量历史

`200` → `{ "versions": [ 版本记录, ... ] }`（按 version 升序）

### 4.9 `GET /sync?since=N&limit=M` — 增量同步（游标）

- `since`：客户端已见的最大全局版本号（0 = 全量回放）。
- `limit`：单页条数，默认 500，最大 5000。
- `200` → `{ "latest_version": 130, "has_more": false, "changes": [ 版本记录, ... ] }`
  （`changes` 按 version 升序；客户端以 `changes` 末条的 version 为下一游标，`has_more` 为真则继续拉）

### 4.10 错误格式（所有非 2xx）

```jsonc
{ "error": { "code": "string", "message": "string", "details": { ... } | null } }
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `validation_failed` | 请求体不符合契约 |
| 401 | `unauthorized` | 缺/错 token |
| 404 | `not_found` | 便签或历史版本不存在 |
| 409 | `conflict` | 创建时 id 已存在 |
| 405 | `method_not_allowed` | — |

> 注意：陈旧写入（base < head）**不是错误**（见 §1，Q29）。

## 5. WebSocket（`/api/v1/ws?token=...`）

- 连接即鉴权：token 无效 → 握手 `401`。
- 服务器 → 客户端消息（JSON）：
  - `{ "type": "hello", "latest_version": 130 }`（连接建立后立即发）
  - `{ "type": "note_changed", "version": { 版本记录 } }`（每次写操作后广播给所有连接）
- 心跳：服务器每 30s 发协议级 ping 帧，连续 2 次无 pong → 断开。
- 客户端不发业务消息；掉线后靠 `GET /sync?since=cursor` 补齐。

## 6. 客户端职责（提示，非服务器契约）

- 本地 journal 只追加、永不被 sync 覆盖（GRILL-PLAN §4 铁律 3）。
- 收到 `conflict: true` 的版本 → 对相关便签打"被覆盖版本"可见标记（可查看/还原，见 4.5/4.8）。
- 还原只能写新版本，绝不本地回拨版本号。

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { actorFromAuthHeader } from "./auth.js";
import {
  NoteExistsError,
  NoteNotFoundError,
  VersionNotFoundError,
  type SlipDb,
} from "./db.js";
import type { Content, VersionRecord } from "./types.js";
import {
  createRequestSchema,
  deleteRequestSchema,
  flattenIssues,
  restoreRequestSchema,
  syncQuerySchema,
  updateRequestSchema,
} from "./validate.js";

const MAX_BODY_BYTES = 256 * 1024;
const API_PREFIX = "/api/v1";
const SERVER_VERSION = "0.1.0";

/** delete/restore 的真实内容由 db 层取 head 快照/历史版本，此值仅占位 */
const PLACEHOLDER_CONTENT: Content = {
  title: null,
  body_type: "text",
  body: "",
  items: null,
  color: null,
  position: null,
};

class BodyTooLargeError extends Error {}
class BadJsonError extends Error {}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  const err: { code: string; message: string; details?: unknown } = { code, message };
  if (details !== undefined) err.details = details;
  json(res, status, { error: err });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BadJsonError());
      }
    });
    req.on("error", reject);
  });
}

export interface HttpContext {
  db: SlipDb;
  config: Config;
  log: Logger;
  /** 每次写操作成功后向 WS 广播版本记录 */
  broadcast: (record: VersionRecord) => void;
}

export function createHandler(ctx: HttpContext) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res, ctx).catch((e) => {
      ctx.log.error("未处理异常", e);
      if (!res.headersSent) fail(res, 500, "internal", "服务器内部错误");
      else res.end();
    });
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://slip.local");

  if (!url.pathname.startsWith(API_PREFIX)) {
    fail(res, 404, "not_found", "接口不存在");
    return;
  }
  const path = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, "") || "/";
  const segs = path.split("/").filter(Boolean);

  // 健康检查：唯一免鉴权端点
  if (segs.length === 1 && segs[0] === "health" && method === "GET") {
    json(res, 200, {
      status: "ok",
      name: "slip-sync",
      version: SERVER_VERSION,
      latest_version: ctx.db.latestVersion(),
    });
    return;
  }

  // 未知路径先 404，再做鉴权（协议 §4.10：路由形状匹配优先）
  const knownShape =
    (segs[0] === "sync" && segs.length === 1) ||
    (segs[0] === "notes" && segs.length === 1) ||
    (segs[0] === "notes" && segs.length === 2) ||
    (segs[0] === "notes" && segs.length === 3 && (segs[2] === "versions" || segs[2] === "restore"));
  if (!knownShape) {
    fail(res, 404, "not_found", "接口不存在");
    return;
  }

  const actor = actorFromAuthHeader(ctx.config, req.headers.authorization);
  if (!actor) {
    fail(res, 401, "unauthorized", "缺少或无效的 token");
    return;
  }

  if (segs[0] === "sync" && segs.length === 1 && method === "GET") {
    const q = syncQuerySchema.safeParse({
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!q.success) {
      fail(res, 400, "validation_failed", "查询参数无效", flattenIssues(q.error));
      return;
    }
    json(res, 200, ctx.db.sync(q.data.since, q.data.limit));
    return;
  }

  if (segs[0] !== "notes") {
    fail(res, 404, "not_found", "接口不存在");
    return;
  }

  if (segs.length === 1) {
    if (method === "GET") {
      json(res, 200, { notes: ctx.db.listHeads() });
      return;
    }
    if (method === "POST") {
      await createNote(req, res, ctx, actor);
      return;
    }
    fail(res, 405, "method_not_allowed", "方法不允许");
    return;
  }

  const noteId = segs[1]!;

  if (segs.length === 2) {
    if (method === "GET") {
      const head = ctx.db.getHead(noteId);
      if (!head) {
        fail(res, 404, "not_found", "便签不存在");
        return;
      }
      json(res, 200, head);
      return;
    }
    if (method === "PUT") {
      await updateNote(req, res, ctx, actor, noteId);
      return;
    }
    if (method === "DELETE") {
      await deleteNote(req, res, ctx, actor, noteId);
      return;
    }
    fail(res, 405, "method_not_allowed", "方法不允许");
    return;
  }

  if (segs.length === 3 && segs[2] === "versions" && method === "GET") {
    json(res, 200, { versions: ctx.db.getVersions(noteId) });
    return;
  }

  if (segs.length === 3 && segs[2] === "restore" && method === "POST") {
    await restoreNote(req, res, ctx, actor, noteId);
    return;
  }

  fail(res, 404, "not_found", "接口不存在");
}

/**
 * 读请求体并解析 JSON。出错时已写 400 响应并返回 null；正常空体也返回 null（调用方区分用 writableEnded）。
 */
async function parseOrFail(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    return await readBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      fail(res, 400, "validation_failed", "请求体过大");
      return null;
    }
    if (e instanceof BadJsonError) {
      fail(res, 400, "validation_failed", "请求体不是合法 JSON");
      return null;
    }
    throw e;
  }
}

async function bodyAsObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await parseOrFail(req, res);
  if (raw === null) {
    if (!res.writableEnded) fail(res, 400, "validation_failed", "请求体不能为空");
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(res, 400, "validation_failed", "请求体必须是 JSON 对象");
    return null;
  }
  return raw as Record<string, unknown>;
}

function writeAndBroadcast(ctx: HttpContext, input: Parameters<SlipDb["write"]>[0]): VersionRecord {
  const record = ctx.db.write(input);
  ctx.broadcast(record);
  return record;
}

async function createNote(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, actor: string): Promise<void> {
  const raw = await bodyAsObject(req, res);
  if (raw === null) return;
  const parsed = createRequestSchema.safeParse(raw);
  if (!parsed.success) {
    fail(res, 400, "validation_failed", "请求体不符合契约", flattenIssues(parsed.error));
    return;
  }
  const noteId = parsed.data.id ?? randomUUID();
  try {
    const record = writeAndBroadcast(ctx, {
      kind: "create",
      noteId,
      author: parsed.data.author,
      actor,
      baseVersion: null,
      content: parsed.data.content,
      deleted: false,
    });
    json(res, 201, record);
  } catch (e) {
    if (e instanceof NoteExistsError) {
      fail(res, 409, "conflict", `便签已存在: ${noteId}`);
      return;
    }
    throw e;
  }
}

async function updateNote(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, actor: string, noteId: string): Promise<void> {
  const raw = await bodyAsObject(req, res);
  if (raw === null) return;
  const parsed = updateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    fail(res, 400, "validation_failed", "请求体不符合契约", flattenIssues(parsed.error));
    return;
  }
  try {
    const record = writeAndBroadcast(ctx, {
      kind: "update",
      noteId,
      author: parsed.data.author,
      actor,
      baseVersion: parsed.data.base_version,
      content: parsed.data.content,
      deleted: false,
    });
    json(res, 200, record);
  } catch (e) {
    if (e instanceof NoteNotFoundError) {
      fail(res, 404, "not_found", "便签不存在");
      return;
    }
    throw e;
  }
}

async function deleteNote(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, actor: string, noteId: string): Promise<void> {
  const raw = await bodyAsObject(req, res);
  if (raw === null) return;
  const parsed = deleteRequestSchema.safeParse(raw);
  if (!parsed.success) {
    fail(res, 400, "validation_failed", "请求体不符合契约", flattenIssues(parsed.error));
    return;
  }
  try {
    const record = writeAndBroadcast(ctx, {
      kind: "delete",
      noteId,
      author: parsed.data.author,
      actor,
      baseVersion: parsed.data.base_version,
      content: PLACEHOLDER_CONTENT,
      deleted: true,
    });
    json(res, 200, record);
  } catch (e) {
    if (e instanceof NoteNotFoundError) {
      fail(res, 404, "not_found", "便签不存在");
      return;
    }
    throw e;
  }
}

async function restoreNote(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, actor: string, noteId: string): Promise<void> {
  const raw = await bodyAsObject(req, res);
  if (raw === null) return;
  const parsed = restoreRequestSchema.safeParse(raw);
  if (!parsed.success) {
    fail(res, 400, "validation_failed", "请求体不符合契约", flattenIssues(parsed.error));
    return;
  }
  try {
    const record = writeAndBroadcast(ctx, {
      kind: "restore",
      noteId,
      author: parsed.data.author,
      actor,
      baseVersion: null,
      content: PLACEHOLDER_CONTENT,
      deleted: false,
      restoreFrom: parsed.data.version,
    });
    json(res, 200, record);
  } catch (e) {
    if (e instanceof NoteNotFoundError || e instanceof VersionNotFoundError) {
      fail(res, 404, "not_found", "便签或历史版本不存在");
      return;
    }
    throw e;
  }
}

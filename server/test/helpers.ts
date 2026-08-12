import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp, type SlipApp } from "../src/index.js";
import type { Config } from "../src/config.js";
import type { Content } from "../src/types.js";

/** token → actor 身份 */
export const TOKENS: Record<string, string> = {
  "test-token-win1": "win1",
  "test-token-win2": "win2",
  "test-token-android": "android",
  "test-token-ai": "ai",
};

export interface TestApp extends SlipApp {
  baseUrl: string;
  cleanup: () => void;
}

const dirs: string[] = [];

export async function startTestServer(overrides?: Partial<Config>): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), "slip-test-"));
  dirs.push(dir);
  const config: Config = {
    host: "127.0.0.1",
    port: 0, // 系统分配空闲端口
    dbPath: join(dir, "test.db"),
    tokens: new Map(Object.entries(TOKENS)),
    logLevel: "error",
    wsPingIntervalMs: 150,
    wsMissedPingsMax: 2,
    ...overrides,
  };
  const app = await createApp(config);
  return {
    ...app,
    baseUrl: `http://127.0.0.1:${app.port}`,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function api(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts?.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts?.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(baseUrl + path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export function wsUrl(baseUrl: string, token?: string): string {
  const u = baseUrl.replace(/^http/, "ws") + "/api/v1/ws";
  return token !== undefined ? `${u}?token=${encodeURIComponent(token)}` : u;
}

export interface WsTestClient {
  ws: WebSocket;
  /** 等待下一条服务器消息 */
  next: (timeoutMs?: number) => Promise<any>;
  closed: Promise<{ code: number; reason: string }>;
  /** 握手被拒（非 101）时返回 HTTP 状态码，否则永不 resolve */
  handshake: Promise<number>;
}

export function wsConnect(baseUrl: string, token?: string, opts?: WebSocket.ClientOptions): WsTestClient {
  const ws = new WebSocket(wsUrl(baseUrl, token), opts);
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  ws.on("error", () => {}); // 握手失败等错误经 handshake/closed 暴露，这里吞掉防未捕获异常
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const handshake = new Promise<number>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
  });
  return {
    ws,
    next: (timeoutMs = 3000) => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("等待 ws 消息超时")), timeoutMs);
        waiters.push((v) => {
          clearTimeout(t);
          resolve(v);
        });
      });
    },
    closed,
    handshake,
  };
}

export function textNote(body: string, overrides?: Partial<Content>): Content {
  return { title: null, body_type: "text", body, items: null, color: null, position: null, ...overrides };
}

export function checklistNote(items: Content["items"], overrides?: Partial<Content>): Content {
  return { title: null, body_type: "checklist", body: null, items, color: null, position: null, ...overrides };
}

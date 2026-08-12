import type { Server, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { actorForToken } from "./auth.js";
import type { SlipDb } from "./db.js";
import type { VersionRecord } from "./types.js";

export interface WsHub {
  broadcast: (record: VersionRecord) => void;
  close: () => void;
}

/**
 * WebSocket 广播通道（协议 §5）：连接即鉴权，服务器 → 客户端单向推送 + 协议级心跳。
 * 掉线补数据靠 REST GET /sync（客户端职责）。
 */
export function attachWs(server: Server, config: Config, db: SlipDb, log: Logger): WsHub {
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://slip.local");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname.replace(/\/+$/, "") !== "/api/v1/ws") {
      socket.destroy();
      return;
    }
    const actor = actorForToken(config, url.searchParams.get("token"));
    if (!actor) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, actor);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, actor: string) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", (e: Error) => log.debug("ws 客户端错误", e.message));
    ws.send(
      JSON.stringify({
        type: "hello",
        latest_version: db.latestVersion(),
      }),
    );
    log.debug(`ws 连接建立: actor=${actor}, 客户端数=${wss.clients.size}`);
  });

  // 心跳：协议级 ping；连续 N 次无 pong → 断开（协议 §5）
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, config.wsPingIntervalMs);
  interval.unref();

  return {
    broadcast(record: VersionRecord) {
      const msg = JSON.stringify({ type: "note_changed", version: record });
      for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    },
    close() {
      clearInterval(interval);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

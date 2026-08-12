import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { SlipDb } from "./db.js";
import { createHandler } from "./http.js";
import { attachWs, type WsHub } from "./ws.js";

export interface SlipApp {
  server: Server;
  /** 实际监听端口（config.port=0 时由系统分配） */
  port: number;
  db: SlipDb;
  close: () => Promise<void>;
}

/** 组装完整应用（HTTP + WS + DB）。测试与生产共用此入口。 */
export function createApp(config: Config = loadConfig()): Promise<SlipApp> {
  const log = createLogger(config.logLevel);
  const db = new SlipDb(config.dbPath);
  const server = createServer();
  let ws: WsHub;

  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      db.close();
      reject(e);
    });

    server.on("request", createHandler({ db, config, log, broadcast: (r) => ws.broadcast(r) }));

    ws = attachWs(server, config, db, log);

    server.listen(config.port, config.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : config.port;
      log.info(`slip-sync 启动: http://${config.host}:${port} db=${config.dbPath} latest_version=${db.latestVersion()}`);
      resolve({
        server,
        port,
        db,
        close: async () => {
          ws.close();
          await new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          });
          db.close();
        },
      });
    });
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  createApp()
    .then((app) => {
      const stop = () => {
        void app
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
        setTimeout(() => process.exit(1), 3000).unref();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((e) => {
      console.error("启动失败:", e);
      process.exit(1);
    });
}

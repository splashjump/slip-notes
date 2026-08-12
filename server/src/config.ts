import { z } from "zod";

const envSchema = z.object({
  SLIP_HOST: z.string().default("0.0.0.0"),
  SLIP_PORT: z.coerce.number().int().min(1).max(65535).default(50000),
  SLIP_DB_PATH: z.string().default("./data/slip.db"),
  /** JSON 对象：{ "win1": "token", ..., "ai": "token" }（actor → token），见 .env.example */
  SLIP_TOKENS: z.string().min(1),
  SLIP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SLIP_WS_PING_INTERVAL_MS: z.coerce.number().int().min(100).default(30_000),
  SLIP_WS_MISSED_PINGS_MAX: z.coerce.number().int().min(1).default(2),
});

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** token → actor 身份 */
  tokens: Map<string, string>;
  logLevel: LogLevel;
  wsPingIntervalMs: number;
  wsMissedPingsMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = envSchema.parse(env);

  let tokensJson: unknown;
  try {
    tokensJson = JSON.parse(raw.SLIP_TOKENS);
  } catch {
    throw new Error("SLIP_TOKENS 不是合法 JSON（形如 {\"win1\":\"...\",\"ai\":\"...\"}）");
  }
  const tokensParsed = z
    .record(z.string().min(1), z.string().min(1))
    .refine((obj) => Object.keys(obj).length > 0, "SLIP_TOKENS 至少需要一个 token")
    .parse(tokensJson);

  return {
    host: raw.SLIP_HOST,
    port: raw.SLIP_PORT,
    dbPath: raw.SLIP_DB_PATH,
    // env 里写 actor → token（人读友好），运行时反转为 token → actor（查询热路径）
    tokens: new Map(Object.entries(tokensParsed).map(([actor, token]) => [token, actor])),
    logLevel: raw.SLIP_LOG_LEVEL,
    wsPingIntervalMs: raw.SLIP_WS_PING_INTERVAL_MS,
    wsMissedPingsMax: raw.SLIP_WS_MISSED_PINGS_MAX,
  };
}

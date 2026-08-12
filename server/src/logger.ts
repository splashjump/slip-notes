import type { LogLevel } from "./config.js";

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = order[level];
  const ts = () => new Date().toISOString();
  return {
    debug: (msg, ...args) => { if (threshold <= 0) console.error(`[${ts()}] DEBUG ${msg}`, ...args); },
    info: (msg, ...args) => { if (threshold <= 1) console.error(`[${ts()}] INFO  ${msg}`, ...args); },
    warn: (msg, ...args) => { if (threshold <= 2) console.error(`[${ts()}] WARN  ${msg}`, ...args); },
    error: (msg, ...args) => { if (threshold <= 3) console.error(`[${ts()}] ERROR ${msg}`, ...args); },
  };
}

import type { Config } from "./config.js";

/** 从 Authorization: Bearer <token> 或查询参数中解析 actor 身份（无效 → null） */
export function actorForToken(config: Config, token: string | null | undefined): string | null {
  if (!token) return null;
  return config.tokens.get(token) ?? null;
}

export function actorFromAuthHeader(config: Config, header: string | null | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return actorForToken(config, token || null);
}

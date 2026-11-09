import { hmacHex } from "./crypto";
import { ApiError, type AppContext } from "./http";

/**
 * Fixed-window counters stored in D1. One atomic UPSERT per check, so concurrent
 * requests can't race past the limit. Expired rows are purged by the cron job.
 */
export async function hit(db: D1Database, key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count    = CASE WHEN rate_limits.reset_at <= ?3 THEN 1  ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
    )
    .bind(key, now + windowMs, now)
    .first<{ count: number; reset_at: number }>();
  return { count: row?.count ?? 1, resetAt: row?.reset_at ?? now + windowMs };
}

export async function peek(db: D1Database, key: string): Promise<{ count: number; resetAt: number }> {
  const row = await db
    .prepare("SELECT count, reset_at FROM rate_limits WHERE key = ? AND reset_at > ?")
    .bind(key, Date.now())
    .first<{ count: number; reset_at: number }>();
  return { count: row?.count ?? 0, resetAt: row?.reset_at ?? 0 };
}

export async function clear(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key).run();
}

export function tooMany(resetAt: number, message: string): ApiError {
  return new ApiError(429, message, Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
}

/** Count this request against `key`; throw 429 once `limit` is exceeded within `windowMs`. */
export async function enforce(c: AppContext, key: string, limit: number, windowMs: number, message: string): Promise<void> {
  const { count, resetAt } = await hit(c.env.DB, key, windowMs);
  if (count > limit) throw tooMany(resetAt, message);
}

/**
 * Stable, non-reversible client fingerprint for rate-limit keys. Cloudflare sets
 * CF-Connecting-IP at the edge (clients cannot spoof it); the raw IP is never stored.
 */
export async function clientKey(c: AppContext): Promise<string> {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  if (!c.env.IP_HASH_SECRET && new URL(c.req.url).protocol === "https:")
    console.warn("IP_HASH_SECRET is not set — run `wrangler secret put IP_HASH_SECRET`.");
  const secret = c.env.IP_HASH_SECRET || "bb2-dev-only-secret";
  return (await hmacHex(secret, ip)).slice(0, 32);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

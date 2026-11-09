import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomId, sha256Hex } from "./crypto";
import type { AppContext, SessionUser } from "./http";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_WHEN_REMAINING_MS = 15 * 24 * 60 * 60 * 1000;

function isHttps(c: AppContext): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * Over HTTPS the cookie uses the `__Host-` prefix, which browsers only accept when
 * Secure, Path=/ and no Domain are set — it can't be planted by a sibling subdomain.
 * Plain `bb2_session` is only used for http://localhost development.
 */
function cookieName(c: AppContext): string {
  return isHttps(c) ? "__Host-bb2_session" : "bb2_session";
}

function writeCookie(c: AppContext, token: string, expiresAt: number) {
  setCookie(c, cookieName(c), token, {
    path: "/",
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    expires: new Date(expiresAt),
  });
}

export async function createSession(c: AppContext, userId: string): Promise<void> {
  const token = randomId(32);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, expiresAt)
    .run();
  writeCookie(c, token, expiresAt);
}

export async function destroySession(c: AppContext): Promise<void> {
  const user = c.get("user");
  if (user) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(user.sessionId).run();
  deleteCookie(c, cookieName(c), { path: "/", secure: isHttps(c) });
}

/** Resolves the session cookie to a user. Role/status come fresh from D1 on every request. */
export async function loadSessionUser(c: AppContext): Promise<SessionUser | null> {
  const token = getCookie(c, cookieName(c));
  if (!token || token.length > 100) return null;
  const sessionId = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.expires_at, u.id, u.username, u.role, u.status, u.created_at, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(sessionId, now)
    .first<{ expires_at: number; id: string; username: string; role: "user" | "admin"; status: "active" | "suspended"; created_at: number; must_change_password: number }>();
  if (!row) return null;

  // Sliding expiry: extend active sessions once they're past the halfway point.
  if (row.expires_at - now < RENEW_WHEN_REMAINING_MS) {
    const expiresAt = now + SESSION_TTL_MS;
    await c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(expiresAt, sessionId).run();
    writeCookie(c, token, expiresAt);
  }
  return {
    id: row.id, username: row.username, role: row.role, status: row.status, createdAt: row.created_at,
    mustChangePassword: !!row.must_change_password, sessionId,
  };
}

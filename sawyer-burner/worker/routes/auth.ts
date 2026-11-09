import { Hono } from "hono";
import type { Me } from "../../shared/types";
import { fakePasswordVerify, hashPassword, randomId, verifyPassword } from "../lib/crypto";
import { ApiError, readJson, type AppEnv, type SessionUser } from "../lib/http";
import { validatePassword, validateUsername } from "../lib/moderation";
import { clear, clientKey, enforce, hit, HOUR, MINUTE, peek, tooMany } from "../lib/ratelimit";
import { createSession, destroySession } from "../lib/session";

const LOGIN_IP_LIMIT = 20; // attempts per IP per 15 min
const LOGIN_USER_FAIL_LIMIT = 8; // failed attempts per username per 15 min
const LOGIN_WINDOW = 15 * MINUTE;

export const toMe = (u: Pick<SessionUser, "username" | "role" | "status" | "createdAt"> & { mustChangePassword?: boolean }): Me => ({
  username: u.username,
  role: u.role,
  suspended: u.status === "suspended",
  createdAt: u.createdAt,
  mustChangePassword: !!u.mustChangePassword,
});

export const auth = new Hono<AppEnv>()
  .get("/me", (c) => {
    const user = c.get("user");
    return c.json({ user: user ? toMe(user) : null });
  })

  .post("/signup", async (c) => {
    const body = await readJson<{ username: string; password: string; confirmPassword: string; agree: boolean }>(c);
    const username = validateUsername(body.username);
    const password = validatePassword(body.password, body.confirmPassword, username);
    if (body.agree !== true) throw new ApiError(400, "You need to agree to the Community Rules.");
    // Counted after validation so typos in the form don't burn the allowance.
    await enforce(c, `signup:${await clientKey(c)}`, 5, HOUR, "Too many new accounts from your network. Try again later.");

    const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
    if (exists) throw new ApiError(409, "That username is taken.");

    const id = randomId();
    const now = Date.now();
    try {
      await c.env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, username, await hashPassword(password), now)
        .run();
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw new ApiError(409, "That username is taken.");
      throw err;
    }
    await createSession(c, id);
    return c.json({ user: toMe({ username, role: "user", status: "active", createdAt: now }) }, 201);
  })

  .post("/login", async (c) => {
    const body = await readJson<{ username: string; password: string }>(c);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase().slice(0, 40) : "";
    const password = typeof body.password === "string" ? body.password.slice(0, 256) : "";
    if (!username || !password) throw new ApiError(400, "Enter your username and password.");

    // Per-IP throttle on all attempts + per-account throttle on failures (stops
    // distributed guessing against one account without letting anyone lock you out forever).
    const ipKey = `login:${await clientKey(c)}`;
    const userKey = `loginfail:${username}`;
    await enforce(c, ipKey, LOGIN_IP_LIMIT, LOGIN_WINDOW, "Too many login attempts. Take a breather and try again soon.");
    const fails = await peek(c.env.DB, userKey);
    if (fails.count >= LOGIN_USER_FAIL_LIMIT) throw tooMany(fails.resetAt, "Too many failed attempts on this account. Try again in a few minutes.");

    const user = await c.env.DB.prepare("SELECT id, password_hash FROM users WHERE username = ?")
      .bind(username)
      .first<{ id: string; password_hash: string }>();
    const ok = user ? await verifyPassword(password, user.password_hash) : (await fakePasswordVerify(password), false);
    if (!user || !ok) {
      await hit(c.env.DB, userKey, LOGIN_WINDOW);
      throw new ApiError(401, "Wrong username or password.");
    }
    await clear(c.env.DB, userKey);
    await createSession(c, user.id);

    const row = await c.env.DB.prepare("SELECT username, role, status, created_at, must_change_password FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ username: string; role: "user" | "admin"; status: "active" | "suspended"; created_at: number; must_change_password: number }>();
    return c.json({
      user: toMe({ username: row!.username, role: row!.role, status: row!.status, createdAt: row!.created_at, mustChangePassword: !!row!.must_change_password }),
    });
  })

  // Change your own password (also how a user replaces an admin-issued temporary one).
  // Signs out every other session on the account.
  .post("/change-password", async (c) => {
    const user = c.get("user");
    if (!user) throw new ApiError(401, "Log in first.");
    const body = await readJson<{ currentPassword: string; newPassword: string; confirmPassword: string }>(c);
    await enforce(c, `pwchange:${user.id}`, 10, HOUR, "Too many password changes. Try again later.");
    const row = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first<{ password_hash: string }>();
    const current = typeof body.currentPassword === "string" ? body.currentPassword.slice(0, 256) : "";
    if (!row || !(await verifyPassword(current, row.password_hash))) throw new ApiError(401, "Your current password is wrong.");
    const next = validatePassword(body.newPassword, body.confirmPassword, user.username);
    if (next === current) throw new ApiError(400, "Pick a password you haven't used here before.");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").bind(await hashPassword(next), user.id),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, user.sessionId),
    ]);
    return c.json({ user: toMe({ ...user, mustChangePassword: false }) });
  })

  .post("/logout", async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });

import { Hono } from "hono";
import { USERNAME_MAX } from "../../shared/rules";
import type { ProfileDTO } from "../../shared/types";
import { ApiError, imageUrl, requireUser, type AppEnv } from "../lib/http";

/** Public profile: username, join date, live posts, recent burns. Nothing else. */
export const users = new Hono<AppEnv>().get("/:username", async (c) => {
  requireUser(c);
  const username = c.req.param("username").toLowerCase();
  if (username.length > USERNAME_MAX || !/^[a-z0-9_]+$/.test(username)) throw new ApiError(404, "No one by that name.");
  const user = await c.env.DB.prepare("SELECT id, username, created_at FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: string; username: string; created_at: number }>();
  if (!user) throw new ApiError(404, "No one by that name.");

  const now = Date.now();
  const [postsRes, commentsRes] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT p.id, p.created_at, p.expires_at, p.width, p.height,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count
         FROM posts p
        WHERE p.user_id = ? AND p.status = 'active' AND p.expires_at > ?
        ORDER BY p.created_at DESC LIMIT 30`,
    ).bind(user.id, now),
    c.env.DB.prepare(
      `SELECT c.id, c.body, c.created_at, c.post_id,
              (SELECT COUNT(*) FROM comment_reactions r WHERE r.comment_id = c.id) AS fire_count
         FROM comments c JOIN posts p ON p.id = c.post_id
        WHERE c.user_id = ? AND c.status = 'active' AND p.status = 'active' AND p.expires_at > ?
        ORDER BY c.created_at DESC LIMIT 20`,
    ).bind(user.id, now),
  ]);

  const profile: ProfileDTO = {
    username: user.username,
    joinedAt: user.created_at,
    posts: postsRes.results.map((p) => ({
      id: p.id as string,
      imageUrl: imageUrl(p.id as string),
      createdAt: p.created_at as number,
      expiresAt: p.expires_at as number,
      commentCount: p.comment_count as number,
      width: p.width as number,
      height: p.height as number,
    })),
    recentComments: commentsRes.results.map((r) => ({
      id: r.id as string,
      body: r.body as string,
      createdAt: r.created_at as number,
      postId: r.post_id as string,
      fireCount: r.fire_count as number,
    })),
  };
  return c.json({ profile });
});

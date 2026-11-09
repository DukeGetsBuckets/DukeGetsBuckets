import { Hono } from "hono";
import { deleteComment } from "../lib/cleanup";
import { randomId } from "../lib/crypto";
import { ApiError, requireActiveUser, requireUser, type AppContext, type AppEnv } from "../lib/http";
import { enforce, MINUTE } from "../lib/ratelimit";
import { canSeePost } from "./posts";

interface CommentContext {
  id: string;
  user_id: string;
  status: string;
  post_user_id: string;
  post_status: string;
  post_expires_at: number;
}

async function loadComment(c: AppContext, id: string): Promise<CommentContext> {
  const user = requireUser(c);
  const row = await c.env.DB.prepare(
    `SELECT c.id, c.user_id, c.status, p.user_id AS post_user_id, p.status AS post_status, p.expires_at AS post_expires_at
       FROM comments c JOIN posts p ON p.id = c.post_id
      WHERE c.id = ?`,
  )
    .bind(id)
    .first<CommentContext>();
  const visible =
    row &&
    canSeePost({ user_id: row.post_user_id, status: row.post_status, expires_at: row.post_expires_at }, user) &&
    (row.status === "active" || row.user_id === user.id || user.role === "admin");
  if (!visible) throw new ApiError(404, "That burn is gone.");
  return row;
}

async function fireCount(db: D1Database, commentId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM comment_reactions WHERE comment_id = ?").bind(commentId).first<{ n: number }>();
  return r?.n ?? 0;
}

export const comments = new Hono<AppEnv>()
  .delete("/:id", async (c) => {
    const user = requireUser(c);
    const comment = await loadComment(c, c.req.param("id"));
    const allowed = comment.user_id === user.id || comment.post_user_id === user.id || user.role === "admin";
    if (!allowed) throw new ApiError(403, "You can only delete your own burns (or burns on your own photo).");
    const reason = comment.user_id === user.id ? "deleted_by_author" : comment.post_user_id === user.id ? "deleted_by_photo_owner" : "removed_by_admin";
    await deleteComment(c.env, comment.id, reason);
    return c.json({ ok: true });
  })

  // 🔥 — idempotent: the UNIQUE(comment_id, user_id) constraint makes a second react a no-op.
  .post("/:id/fire", async (c) => {
    const user = requireActiveUser(c);
    const comment = await loadComment(c, c.req.param("id"));
    await enforce(c, `fire:${user.id}`, 60, MINUTE, "Too many 🔥 too fast.");
    await c.env.DB.prepare(
      `INSERT INTO comment_reactions (id, comment_id, user_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(comment_id, user_id) DO NOTHING`,
    )
      .bind(randomId(), comment.id, user.id, Date.now())
      .run();
    return c.json({ fireCount: await fireCount(c.env.DB, comment.id), firedByMe: true });
  })

  .delete("/:id/fire", async (c) => {
    const user = requireActiveUser(c);
    const comment = await loadComment(c, c.req.param("id"));
    await c.env.DB.prepare("DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ?").bind(comment.id, user.id).run();
    return c.json({ fireCount: await fireCount(c.env.DB, comment.id), firedByMe: false });
  });

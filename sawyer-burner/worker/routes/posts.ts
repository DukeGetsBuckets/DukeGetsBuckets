import { Hono } from "hono";
import { MAX_UPLOAD_BYTES, POST_TTL_MS } from "../../shared/rules";
import type { CommentDTO, PostDTO } from "../../shared/types";
import { deletePostById } from "../lib/cleanup";
import { randomId } from "../lib/crypto";
import { ApiError, imageUrl, readJson, requireActiveUser, requireUser, type AppEnv, type SessionUser } from "../lib/http";
import { ImageError, processImage } from "../lib/image";
import { validateCaption, validateComment } from "../lib/moderation";
import { DAY, enforce, HOUR, MINUTE } from "../lib/ratelimit";

export interface PostRow {
  id: string;
  user_id: string;
  username: string;
  caption: string | null;
  width: number;
  height: number;
  status: "active" | "hidden";
  created_at: number;
  expires_at: number;
  comment_count: number;
}

export const POST_SELECT = `
  SELECT p.id, p.user_id, u.username, p.caption, p.width, p.height, p.status, p.created_at, p.expires_at,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count
    FROM posts p JOIN users u ON u.id = p.user_id`;

/** Expired posts are invisible to everyone, even before the cron job deletes them. */
export function canSeePost(row: { user_id: string; status: string; expires_at: number } | null, user: SessionUser): boolean {
  if (!row || row.expires_at <= Date.now()) return false;
  return row.status === "active" || row.user_id === user.id || user.role === "admin";
}

export function toPostDTO(row: PostRow, user: SessionUser): PostDTO {
  const dto: PostDTO = {
    id: row.id,
    author: row.username,
    caption: row.caption,
    width: row.width,
    height: row.height,
    imageUrl: imageUrl(row.id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    commentCount: row.comment_count,
    isMine: row.user_id === user.id,
  };
  if (row.status === "hidden") dto.hidden = true;
  return dto;
}

async function loadVisiblePost(env: Env, id: string, user: SessionUser): Promise<PostRow> {
  const row = await env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(id).first<PostRow>();
  if (!row || !canSeePost(row, user)) throw new ApiError(404, "This photo is gone. Photos only last 24 hours.");
  return row;
}

interface CommentRow {
  id: string;
  body: string;
  created_at: number;
  user_id: string;
  username: string;
  fire_count: number;
  fired: number;
}

export function toCommentDTO(row: CommentRow, user: SessionUser, postOwnerId: string): CommentDTO {
  const isMine = row.user_id === user.id;
  return {
    id: row.id,
    author: row.username,
    body: row.body,
    createdAt: row.created_at,
    fireCount: row.fire_count,
    firedByMe: !!row.fired,
    isMine,
    // Authors can delete their burns; photo owners can clear burns off their own photo.
    canDelete: isMine || postOwnerId === user.id || user.role === "admin",
  };
}

export const posts = new Hono<AppEnv>()
  // ───────────── upload ─────────────
  .post("/", async (c) => {
    const user = requireActiveUser(c);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES + 64 * 1024) throw new ApiError(413, "That file is too big. Max 10 MB.");
    await enforce(c, `upload:h:${user.id}`, 6, HOUR, "Easy there. You can post 6 photos an hour.");
    await enforce(c, `upload:d:${user.id}`, 20, DAY, "Daily limit reached (20 photos). Come back tomorrow.");

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new ApiError(400, "Upload failed to parse. Try again.");
    }
    const file = form.get("image");
    if (!file || typeof file === "string") throw new ApiError(400, "Pick a photo first.");
    if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "That file is too big. Max 10 MB.");
    if (file.size === 0) throw new ApiError(400, "That file is empty.");
    if (form.get("consent") !== "yes") throw new ApiError(400, "You must confirm you have permission to post this image.");
    const caption = validateCaption(form.get("caption"));

    let img;
    try {
      img = processImage(new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      if (err instanceof ImageError) throw new ApiError(415, err.message);
      throw err;
    }

    const id = randomId();
    const key = `posts/${randomId(16)}.${img.ext}`; // server-generated: no user input reaches the object key
    const now = Date.now();
    await c.env.IMAGES.put(key, img.bytes, { httpMetadata: { contentType: img.mime } });
    try {
      await c.env.DB.prepare(
        `INSERT INTO posts (id, user_id, image_key, mime_type, width, height, size_bytes, caption, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, user.id, key, img.mime, img.width, img.height, img.bytes.length, caption, now, now + POST_TTL_MS)
        .run();
    } catch (err) {
      await c.env.IMAGES.delete(key);
      throw err;
    }
    const row: PostRow = {
      id, user_id: user.id, username: user.username, caption, width: img.width, height: img.height,
      status: "active", created_at: now, expires_at: now + POST_TTL_MS, comment_count: 0,
    };
    return c.json({ post: toPostDTO(row, user), serverNow: Date.now() }, 201);
  })

  // ───────────── single post ─────────────
  .get("/:id", async (c) => {
    const user = requireUser(c);
    const row = await loadVisiblePost(c.env, c.req.param("id"), user);
    // Remember what this user has seen so the feed can prioritise unseen photos.
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        `INSERT INTO post_views (user_id, post_id, seen_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, post_id) DO UPDATE SET seen_at = excluded.seen_at`,
      )
        .bind(user.id, row.id, Date.now())
        .run()
        .catch(() => {}),
    );
    return c.json({ post: toPostDTO(row, user), serverNow: Date.now() });
  })

  .delete("/:id", async (c) => {
    const user = requireUser(c);
    const row = await c.env.DB.prepare("SELECT user_id FROM posts WHERE id = ?").bind(c.req.param("id")).first<{ user_id: string }>();
    if (!row) throw new ApiError(404, "Post not found.");
    if (row.user_id !== user.id && user.role !== "admin") throw new ApiError(403, "You can only delete your own photos.");
    await deletePostById(c.env, c.req.param("id"), row.user_id === user.id ? "deleted_by_owner" : "removed_by_admin");
    return c.json({ ok: true });
  })

  // ───────────── burns on a post ─────────────
  .get("/:id/comments", async (c) => {
    const user = requireUser(c);
    const post = await loadVisiblePost(c.env, c.req.param("id"), user);
    const hot = c.req.query("sort") === "hot";
    const { results } = await c.env.DB.prepare(
      `SELECT c.id, c.body, c.created_at, c.user_id, u.username,
              (SELECT COUNT(*) FROM comment_reactions r WHERE r.comment_id = c.id) AS fire_count,
              EXISTS (SELECT 1 FROM comment_reactions r WHERE r.comment_id = c.id AND r.user_id = ?1) AS fired
         FROM comments c JOIN users u ON u.id = c.user_id
        WHERE c.post_id = ?2 AND (c.status = 'active' OR c.user_id = ?1 OR ?3 = 'admin')
        ORDER BY ${hot ? "fire_count DESC, c.created_at DESC" : "c.created_at DESC"}
        LIMIT 200`,
    )
      .bind(user.id, post.id, user.role)
      .all<CommentRow>();
    return c.json({ comments: results.map((r) => toCommentDTO(r, user, post.user_id)), commentCount: post.comment_count, serverNow: Date.now() });
  })

  .post("/:id/comments", async (c) => {
    const user = requireActiveUser(c);
    const body = await readJson<{ body: string }>(c);
    const post = await loadVisiblePost(c.env, c.req.param("id"), user);
    if (post.status !== "active") throw new ApiError(403, "This photo is under review. Burns are paused.");
    const text = validateComment(body.body);
    await enforce(c, `comment:m:${user.id}`, 6, MINUTE, "Slow down, flamethrower. Max 6 burns a minute.");
    await enforce(c, `comment:h:${user.id}`, 80, HOUR, "You've hit the hourly burn limit. Cool off a bit.");

    const id = randomId();
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO comments (id, post_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, post.id, user.id, text, now)
      .run();
    const comment = toCommentDTO(
      { id, body: text, created_at: now, user_id: user.id, username: user.username, fire_count: 0, fired: 0 },
      user,
      post.user_id,
    );
    return c.json({ comment }, 201);
  });

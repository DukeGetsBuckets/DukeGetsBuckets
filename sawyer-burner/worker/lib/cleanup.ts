// Hard deletion of posts, comments and users, plus the scheduled 24-hour purge.
// Deletion order is always: R2 object first, then D1 rows in one transaction.
// If R2 fails, nothing is removed from D1 and the next cron run retries.
// If D1 fails after R2 succeeded, the row is already expired/unreachable and is retried.
//
// Content that was never reported is deleted completely. Content with at least one report
// is first copied (text/metadata only, never the image) into burn_archive / post_archive,
// inside the same transaction, so admins can review it later.

import { POST_TTL_MS } from "../../shared/rules";
import type { BurnDeletionReason, PostDeletionReason } from "../../shared/types";

const CHUNK = 40; // keeps every statement well under D1's 100 bound-parameter limit

function chunks<T>(arr: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** "?3, ?4, …" — numbered placeholders so ids can follow fixed ?1/?2 params. */
const numbered = (from: number, n: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(",");

const reportsJson = (type: "post" | "comment", idExpr: string) => `
  (SELECT COALESCE(json_group_array(json_object(
            'reason', rp.reason, 'details', rp.details, 'reporter', ru.username, 'at', rp.created_at)), '[]')
     FROM reports rp LEFT JOIN users ru ON ru.id = rp.reporter_user_id
    WHERE rp.target_type = '${type}' AND rp.target_id = ${idExpr})`;

/** Archives reported burns matching `where` (which may use ?1 = now, ?2 = reason, ?3… = extra params). */
function archiveReportedBurns(db: D1Database, where: string, now: number, reason: BurnDeletionReason, params: unknown[]) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO burn_archive
         (id, post_id, author_id, author_username, photo_owner_username, body, fire_count, reports_json, created_at, deleted_at, deletion_reason)
       SELECT c.id, c.post_id, c.user_id, u.username, pu.username, c.body,
              (SELECT COUNT(*) FROM comment_reactions r WHERE r.comment_id = c.id),
              ${reportsJson("comment", "c.id")},
              c.created_at, ?1, ?2
         FROM comments c
         JOIN users u ON u.id = c.user_id
         JOIN posts p ON p.id = c.post_id
         JOIN users pu ON pu.id = p.user_id
        WHERE c.report_count > 0 AND (${where})`,
    )
    .bind(now, reason, ...params);
}

const burnReasonForPost: Record<PostDeletionReason, BurnDeletionReason> = {
  expired: "expired",
  deleted_by_owner: "photo_deleted",
  removed_by_admin: "photo_deleted",
  account_deleted: "photo_deleted",
};

export async function deletePosts(env: Env, posts: Array<{ id: string; image_key: string }>, reason: PostDeletionReason): Promise<void> {
  const now = Date.now();
  for (const batch of chunks(posts)) {
    await env.IMAGES.delete(batch.map((p) => p.image_key));
    const ids = batch.map((p) => p.id);
    const ph = ids.map(() => "?").join(",");
    const idsFrom3 = numbered(3, ids.length);
    const commentIds = `SELECT id FROM comments WHERE post_id IN (${ph})`;
    await env.DB.batch([
      archiveReportedBurns(env.DB, `c.post_id IN (${idsFrom3})`, now, burnReasonForPost[reason], ids),
      env.DB.prepare(
        `INSERT OR IGNORE INTO post_archive
           (id, owner_id, owner_username, caption, width, height, comment_count, reports_json, created_at, deleted_at, deletion_reason)
         SELECT p.id, p.user_id, u.username, p.caption, p.width, p.height,
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id),
                ${reportsJson("post", "p.id")},
                p.created_at, ?1, ?2
           FROM posts p JOIN users u ON u.id = p.user_id
          WHERE p.report_count > 0 AND p.id IN (${idsFrom3})`,
      ).bind(now, reason, ...ids),
      env.DB.prepare(`DELETE FROM reports WHERE target_type = 'comment' AND target_id IN (${commentIds})`).bind(...ids),
      env.DB.prepare(`DELETE FROM reports WHERE target_type = 'post' AND target_id IN (${ph})`).bind(...ids),
      env.DB.prepare(`DELETE FROM comment_reactions WHERE comment_id IN (${commentIds})`).bind(...ids),
      env.DB.prepare(`DELETE FROM comments WHERE post_id IN (${ph})`).bind(...ids),
      env.DB.prepare(`DELETE FROM post_views WHERE post_id IN (${ph})`).bind(...ids),
      env.DB.prepare(`DELETE FROM posts WHERE id IN (${ph})`).bind(...ids),
    ]);
  }
}

export async function deletePostById(env: Env, postId: string, reason: PostDeletionReason): Promise<boolean> {
  const post = await env.DB.prepare("SELECT id, image_key FROM posts WHERE id = ?").bind(postId).first<{ id: string; image_key: string }>();
  if (!post) return false;
  await deletePosts(env, [post], reason);
  return true;
}

export async function deleteComment(env: Env, commentId: string, reason: BurnDeletionReason): Promise<void> {
  await env.DB.batch([
    archiveReportedBurns(env.DB, "c.id = ?3", Date.now(), reason, [commentId]),
    env.DB.prepare("DELETE FROM reports WHERE target_type = 'comment' AND target_id = ?").bind(commentId),
    env.DB.prepare("DELETE FROM comment_reactions WHERE comment_id = ?").bind(commentId),
    env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(commentId),
  ]);
}

/** Removes a user and everything they created, including their images in R2. */
export async function deleteUser(env: Env, userId: string): Promise<void> {
  const { results: posts } = await env.DB.prepare("SELECT id, image_key FROM posts WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string; image_key: string }>();
  await deletePosts(env, posts, "account_deleted");
  const theirComments = "SELECT id FROM comments WHERE user_id = ?";
  await env.DB.batch([
    archiveReportedBurns(env.DB, "c.user_id = ?3", Date.now(), "account_deleted", [userId]),
    env.DB.prepare(`DELETE FROM reports WHERE target_type = 'comment' AND target_id IN (${theirComments})`).bind(userId),
    env.DB.prepare(`DELETE FROM comment_reactions WHERE comment_id IN (${theirComments})`).bind(userId),
    env.DB.prepare("DELETE FROM comment_reactions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM comments WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM post_views WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE reports SET reporter_user_id = NULL WHERE reporter_user_id = ?").bind(userId),
    env.DB.prepare("UPDATE reports SET target_user_id = NULL WHERE target_user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}


/** Deletes every post whose 24h window has closed. Returns the number purged. */
export async function purgeExpiredPosts(env: Env, now = Date.now()): Promise<number> {
  let purged = 0;
  for (let round = 0; round < 25; round++) {
    const { results } = await env.DB.prepare("SELECT id, image_key FROM posts WHERE expires_at <= ? LIMIT ?")
      .bind(now, CHUNK)
      .all<{ id: string; image_key: string }>();
    if (!results.length) break;
    await deletePosts(env, results, "expired");
    purged += results.length;
    if (results.length < CHUNK) break;
  }
  return purged;
}

export async function purgeHousekeeping(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").bind(now),
  ]);
}

/**
 * Safety net for R2: deletes any object older than 24h (+ grace), and any object older
 * than 1h that no post row references (e.g. an upload whose DB insert failed).
 * Guarantees no photo outlives its window even if a DB delete was missed.
 */
export async function sweepOrphanImages(env: Env, now = Date.now()): Promise<number> {
  let cursor: string | undefined;
  let removed = 0;
  for (let page = 0; page < 10; page++) {
    const listing = await env.IMAGES.list({ prefix: "posts/", cursor, limit: 500 });
    const tooOld: string[] = [];
    const candidates: string[] = [];
    for (const obj of listing.objects) {
      const age = now - obj.uploaded.getTime();
      if (age > POST_TTL_MS + 15 * 60_000) tooOld.push(obj.key);
      else if (age > 60 * 60_000) candidates.push(obj.key);
    }
    const orphans: string[] = [];
    for (const batch of chunks(candidates)) {
      const { results } = await env.DB.prepare(`SELECT image_key FROM posts WHERE image_key IN (${batch.map(() => "?").join(",")})`)
        .bind(...batch)
        .all<{ image_key: string }>();
      const referenced = new Set(results.map((r) => r.image_key));
      orphans.push(...batch.filter((k) => !referenced.has(k)));
    }
    // Rows for too-old objects are expired too; purge them properly so nothing dangles.
    for (const batch of chunks(tooOld)) {
      const { results } = await env.DB.prepare(`SELECT id, image_key FROM posts WHERE image_key IN (${batch.map(() => "?").join(",")})`)
        .bind(...batch)
        .all<{ id: string; image_key: string }>();
      await deletePosts(env, results, "expired");
    }
    const doomed = [...tooOld, ...orphans];
    for (const batch of chunks(doomed, 500)) await env.IMAGES.delete(batch);
    removed += doomed.length;
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
  return removed;
}

export async function runScheduled(env: Env, cron: string): Promise<void> {
  const now = Date.now();
  const purged = await purgeExpiredPosts(env, now);
  await purgeHousekeeping(env, now);
  let swept = 0;
  if (cron === "17 * * * *") swept = await sweepOrphanImages(env, now);
  console.log(JSON.stringify({ event: "cleanup", cron, purged, swept }));
}

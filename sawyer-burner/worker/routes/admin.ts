import { Hono } from "hono";
import type {
  AdminComment, AdminPost, AdminReportGroup, AdminStats, AdminUser, AdminUserDetail, ArchivedBurn, ArchivedPost, ArchivedReport,
} from "../../shared/types";
import { deleteComment, deletePostById, deleteUser } from "../lib/cleanup";
import { hashPassword, temporaryPassword } from "../lib/crypto";
import { ApiError, imageUrl, readJson, requireAdmin, type AppContext, type AppEnv } from "../lib/http";

const PAGE = 50;

function offsetOf(c: AppContext): number {
  const n = Number(c.req.query("offset") ?? 0);
  return Number.isInteger(n) && n >= 0 && n < 100_000 ? n : 0;
}

async function targetUser(c: AppContext) {
  const admin = requireAdmin(c);
  const row = await c.env.DB.prepare("SELECT id, role FROM users WHERE username = ?")
    .bind(c.req.param("username")?.toLowerCase() ?? "")
    .first<{ id: string; role: string }>();
  if (!row) throw new ApiError(404, "User not found.");
  if (row.id === admin.id) throw new ApiError(400, "You can't do that to your own account.");
  if (row.role === "admin") throw new ApiError(403, "Other admins can't be changed from the panel. Demote them in D1 first.");
  return row;
}

function parseReports(json: unknown): ArchivedReport[] {
  try {
    const list = JSON.parse(String(json ?? "[]"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const toArchivedBurn = (r: Record<string, never>): ArchivedBurn => ({
  id: r.id, postId: r.post_id, author: r.author_username, photoOwner: r.photo_owner_username, body: r.body,
  fireCount: r.fire_count, reports: parseReports(r.reports_json), createdAt: r.created_at, deletedAt: r.deleted_at,
  deletionReason: r.deletion_reason,
});

const toArchivedPost = (r: Record<string, never>): ArchivedPost => ({
  id: r.id, owner: r.owner_username, caption: r.caption, commentCount: r.comment_count, reports: parseReports(r.reports_json),
  createdAt: r.created_at, deletedAt: r.deleted_at, deletionReason: r.deletion_reason,
});

export const admin = new Hono<AppEnv>()
  // Every admin route independently verifies the role from D1 (loaded fresh per request).
  .use("*", async (c, next) => {
    requireAdmin(c);
    await next();
  })

  .get("/stats", async (c) => {
    const now = Date.now();
    const q = (sql: string, ...args: unknown[]) => c.env.DB.prepare(sql).bind(...args);
    const rows = await c.env.DB.batch<{ n: number }>([
      q("SELECT COUNT(*) AS n FROM posts WHERE status = 'active' AND expires_at > ?", now),
      q("SELECT COUNT(*) AS n FROM posts WHERE status = 'hidden' AND expires_at > ?", now),
      q("SELECT COUNT(*) AS n FROM users"),
      q("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'"),
      q("SELECT COUNT(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.expires_at > ?", now),
      q("SELECT COUNT(DISTINCT target_type || ':' || target_id) AS n FROM reports WHERE status = 'open'"),
      q("SELECT COUNT(*) AS n FROM posts WHERE created_at > ?", now - 24 * 3600_000),
    ]);
    const [activePhotos, hiddenPhotos, users, suspendedUsers, comments, openReports, uploads24h] = rows.map((r) => r.results[0]?.n ?? 0);
    const stats: AdminStats = { activePhotos, hiddenPhotos, users, suspendedUsers, comments, openReports, uploads24h };
    return c.json({ stats });
  })

  // ───────────── photos ─────────────
  .get("/posts", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT p.id, u.username, p.caption, p.created_at, p.expires_at, p.report_count, p.status,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
         FROM posts p JOIN users u ON u.id = p.user_id
        WHERE p.expires_at > ?
        ORDER BY ${c.req.query("sort") === "reports" ? "p.report_count DESC," : ""} p.created_at DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(Date.now(), PAGE + 1, offsetOf(c))
      .all<Record<string, never>>();
    const posts: AdminPost[] = results.slice(0, PAGE).map((r) => ({
      id: r.id, imageUrl: imageUrl(r.id), uploader: r.username, caption: r.caption, createdAt: r.created_at,
      expiresAt: r.expires_at, commentCount: r.comment_count, reportCount: r.report_count, status: r.status,
    }));
    return c.json({ posts, hasMore: results.length > PAGE });
  })

  .delete("/posts/:id", async (c) => {
    if (!(await deletePostById(c.env, c.req.param("id"), "removed_by_admin"))) throw new ApiError(404, "Post not found.");
    return c.json({ ok: true });
  })

  // ───────────── burns ─────────────
  .get("/comments", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT c.id, c.body, u.username, c.post_id, c.created_at, c.report_count, c.status
         FROM comments c JOIN users u ON u.id = c.user_id JOIN posts p ON p.id = c.post_id
        WHERE p.expires_at > ?
        ORDER BY ${c.req.query("sort") === "reports" ? "c.report_count DESC," : ""} c.created_at DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(Date.now(), PAGE + 1, offsetOf(c))
      .all<Record<string, never>>();
    const comments: AdminComment[] = results.slice(0, PAGE).map((r) => ({
      id: r.id, body: r.body, author: r.username, postId: r.post_id, postImageUrl: imageUrl(r.post_id),
      createdAt: r.created_at, reportCount: r.report_count, status: r.status,
    }));
    return c.json({ comments, hasMore: results.length > PAGE });
  })

  .delete("/comments/:id", async (c) => {
    const exists = await c.env.DB.prepare("SELECT 1 FROM comments WHERE id = ?").bind(c.req.param("id")).first();
    if (!exists) throw new ApiError(404, "Comment not found.");
    await deleteComment(c.env, c.req.param("id"), "removed_by_admin");
    return c.json({ ok: true });
  })

  // ───────────── moderation queue ─────────────
  .get("/reports", async (c) => {
    const { results: reports } = await c.env.DB.prepare(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.created_at, u.username AS reporter
         FROM reports r LEFT JOIN users u ON u.id = r.reporter_user_id
        WHERE r.status = 'open'
        ORDER BY r.created_at DESC
        LIMIT 1000`,
    ).all<{ id: string; target_type: "post" | "comment"; target_id: string; reason: string; details: string | null; created_at: number; reporter: string | null }>();

    const groups = new Map<string, AdminReportGroup>();
    for (const r of reports) {
      const k = `${r.target_type}:${r.target_id}`;
      let g = groups.get(k);
      if (!g) {
        g = { targetType: r.target_type, targetId: r.target_id, reportCount: 0, firstReportedAt: r.created_at, lastReportedAt: r.created_at, hasItsMe: false, targetStatus: "gone", content: { author: null }, reports: [] };
        groups.set(k, g);
      }
      g.reportCount++;
      g.firstReportedAt = Math.min(g.firstReportedAt, r.created_at);
      g.lastReportedAt = Math.max(g.lastReportedAt, r.created_at);
      g.hasItsMe ||= r.reason === "its_me";
      g.reports.push({ id: r.id, reporter: r.reporter, reason: r.reason, details: r.details, createdAt: r.created_at });
    }

    const list = [...groups.values()];
    const postIds = list.filter((g) => g.targetType === "post").map((g) => g.targetId);
    const commentIds = list.filter((g) => g.targetType === "comment").map((g) => g.targetId);
    for (let i = 0; i < postIds.length; i += 50) {
      const ids = postIds.slice(i, i + 50);
      const { results } = await c.env.DB.prepare(
        `SELECT p.id, p.caption, p.status, u.username FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id IN (${ids.map(() => "?").join(",")})`,
      ).bind(...ids).all<{ id: string; caption: string | null; status: "active" | "hidden"; username: string }>();
      for (const p of results) {
        const g = groups.get(`post:${p.id}`)!;
        g.targetStatus = p.status;
        g.content = { author: p.username, imageUrl: imageUrl(p.id), caption: p.caption, postId: p.id };
      }
    }
    for (let i = 0; i < commentIds.length; i += 50) {
      const ids = commentIds.slice(i, i + 50);
      const { results } = await c.env.DB.prepare(
        `SELECT c.id, c.body, c.status, c.post_id, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id IN (${ids.map(() => "?").join(",")})`,
      ).bind(...ids).all<{ id: string; body: string; status: "active" | "hidden"; post_id: string; username: string }>();
      for (const cm of results) {
        const g = groups.get(`comment:${cm.id}`)!;
        g.targetStatus = cm.status;
        g.content = { author: cm.username, body: cm.body, postId: cm.post_id, imageUrl: imageUrl(cm.post_id) };
      }
    }

    // "This is me" takedowns first, then most-reported, then most recent.
    list.sort((a, b) => Number(b.hasItsMe) - Number(a.hasItsMe) || b.reportCount - a.reportCount || b.lastReportedAt - a.lastReportedAt);
    return c.json({ groups: list });
  })

  .post("/reports/resolve", async (c) => {
    const body = await readJson<{ targetType: string; targetId: string; action: string }>(c);
    const { targetType, targetId, action } = body;
    if ((targetType !== "post" && targetType !== "comment") || typeof targetId !== "string") throw new ApiError(400, "Invalid target.");
    if (action === "remove") {
      if (targetType === "post") await deletePostById(c.env, targetId, "removed_by_admin");
      else await deleteComment(c.env, targetId, "removed_by_admin");
      // Content deletion also deletes its reports; clear any stragglers.
      await c.env.DB.prepare("DELETE FROM reports WHERE target_type = ? AND target_id = ?").bind(targetType, targetId).run();
    } else if (action === "dismiss") {
      const table = targetType === "post" ? "posts" : "comments";
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE reports SET status = 'dismissed', resolved_at = ? WHERE target_type = ? AND target_id = ? AND status = 'open'").bind(Date.now(), targetType, targetId),
        c.env.DB.prepare(`UPDATE ${table} SET status = 'active' WHERE id = ?`).bind(targetId),
      ]);
    } else throw new ApiError(400, "Unknown action.");
    return c.json({ ok: true });
  })

  // ───────────── review archive: reported content that has left the site ─────────────
  .get("/archive", async (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 60);
    const photos = c.req.query("type") === "photos";
    const { results } = await c.env.DB.prepare(
      photos
        ? `SELECT * FROM post_archive
            WHERE (?1 = '' OR instr(owner_username, ?1) > 0 OR instr(lower(COALESCE(caption, '')), ?1) > 0)
            ORDER BY deleted_at DESC LIMIT ?2 OFFSET ?3`
        : `SELECT * FROM burn_archive
            WHERE (?1 = '' OR instr(author_username, ?1) > 0 OR instr(lower(body), ?1) > 0)
            ORDER BY deleted_at DESC LIMIT ?2 OFFSET ?3`,
    )
      .bind(q, PAGE + 1, offsetOf(c))
      .all<Record<string, never>>();
    const page = results.slice(0, PAGE);
    return c.json(
      photos
        ? { posts: page.map(toArchivedPost), hasMore: results.length > PAGE }
        : { burns: page.map(toArchivedBurn), hasMore: results.length > PAGE },
    );
  })

  // ───────────── users ─────────────
  .get("/users", async (c) => {
    const q = (c.req.query("q") ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    const { results } = await c.env.DB.prepare(
      `SELECT u.username, u.role, u.status, u.created_at, u.reports_received,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.expires_at > ?1) AS post_count,
              (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comment_count
         FROM users u
        WHERE (?2 = '' OR u.username LIKE ?2 || '%')
        ORDER BY ${c.req.query("sort") === "reports" ? "u.reports_received DESC," : ""} u.created_at DESC
        LIMIT ?3 OFFSET ?4`,
    )
      .bind(Date.now(), q, PAGE + 1, offsetOf(c))
      .all<Record<string, never>>();
    const users: AdminUser[] = results.slice(0, PAGE).map((r) => ({
      username: r.username, role: r.role, status: r.status, createdAt: r.created_at,
      postCount: r.post_count, commentCount: r.comment_count, reportsReceived: r.reports_received,
    }));
    return c.json({ users, hasMore: results.length > PAGE });
  })

  // Everything one person has posted: live photos/burns plus their reported content that has
  // since been deleted. (Unreported content is gone for good once deleted.)
  .get("/users/:username", async (c) => {
    const now = Date.now();
    const u = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.role, u.status, u.created_at, u.reports_received,
              (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.expires_at > ?2) AS post_count,
              (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comment_count
         FROM users u WHERE u.username = ?1`,
    )
      .bind(c.req.param("username").toLowerCase(), now)
      .first<Record<string, never>>();
    if (!u) throw new ApiError(404, "User not found.");

    const [livePosts, liveBurns, archivedPosts, archivedBurns] = await c.env.DB.batch<Record<string, never>>([
      c.env.DB.prepare(
        `SELECT p.id, p.caption, p.created_at, p.expires_at, p.report_count, p.status,
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
           FROM posts p WHERE p.user_id = ? AND p.expires_at > ? ORDER BY p.created_at DESC LIMIT 100`,
      ).bind(u.id, now),
      c.env.DB.prepare(
        `SELECT c.id, c.body, c.post_id, c.created_at, c.report_count, c.status
           FROM comments c JOIN posts p ON p.id = c.post_id
          WHERE c.user_id = ? AND p.expires_at > ? ORDER BY c.created_at DESC LIMIT 200`,
      ).bind(u.id, now),
      c.env.DB.prepare("SELECT * FROM post_archive WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200").bind(u.id),
      c.env.DB.prepare("SELECT * FROM burn_archive WHERE author_id = ? ORDER BY created_at DESC LIMIT 500").bind(u.id),
    ]);

    const detail: AdminUserDetail = {
      user: {
        username: u.username, role: u.role, status: u.status, createdAt: u.created_at,
        postCount: u.post_count, commentCount: u.comment_count, reportsReceived: u.reports_received,
      },
      livePosts: livePosts.results.map((r) => ({
        id: r.id, imageUrl: imageUrl(r.id), uploader: u.username, caption: r.caption, createdAt: r.created_at,
        expiresAt: r.expires_at, commentCount: r.comment_count, reportCount: r.report_count, status: r.status,
      })),
      liveBurns: liveBurns.results.map((r) => ({
        id: r.id, body: r.body, author: u.username, postId: r.post_id, postImageUrl: imageUrl(r.post_id),
        createdAt: r.created_at, reportCount: r.report_count, status: r.status,
      })),
      archivedPosts: archivedPosts.results.map(toArchivedPost),
      archivedBurns: archivedBurns.results.map(toArchivedBurn),
    };
    return c.json(detail);
  })

  // Issues a one-time temporary password (shown to the admin once) and signs the user out
  // everywhere. The user must choose a new password on their next login. Real passwords
  // are never stored or viewable — only a one-way hash.
  .post("/users/:username/reset-password", async (c) => {
    const u = await targetUser(c);
    const temp = temporaryPassword();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").bind(await hashPassword(temp), u.id),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
      c.env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`loginfail:${c.req.param("username").toLowerCase()}`),
    ]);
    return c.json({ temporaryPassword: temp });
  })

  .post("/users/:username/suspend", async (c) => {
    const u = await targetUser(c);
    await c.env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(u.id).run();
    return c.json({ ok: true });
  })

  .post("/users/:username/unsuspend", async (c) => {
    const u = await targetUser(c);
    await c.env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(u.id).run();
    return c.json({ ok: true });
  })

  .delete("/users/:username", async (c) => {
    const u = await targetUser(c);
    await deleteUser(c.env, u.id);
    return c.json({ ok: true });
  });

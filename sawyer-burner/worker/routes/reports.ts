import { Hono } from "hono";
import { AUTO_HIDE_REPORT_THRESHOLD, REPORT_DETAILS_MAX, REPORT_REASON_VALUES } from "../../shared/rules";
import { randomId } from "../lib/crypto";
import { ApiError, readJson, requireUser, type AppEnv } from "../lib/http";
import { cleanText } from "../lib/moderation";
import { enforce, HOUR } from "../lib/ratelimit";

export const reports = new Hono<AppEnv>().post("/", async (c) => {
  const user = requireUser(c); // suspended users can still report — safety first
  const body = await readJson<{ targetType: string; targetId: string; reason: string; details: string }>(c);
  const targetType = body.targetType;
  const targetId = typeof body.targetId === "string" ? body.targetId : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (targetType !== "post" && targetType !== "comment") throw new ApiError(400, "Invalid report target.");
  if (!REPORT_REASON_VALUES.includes(reason)) throw new ApiError(400, "Pick a reason.");
  if (reason === "its_me" && targetType !== "post") throw new ApiError(400, "Use this reason on the photo itself.");
  const detailsRaw = cleanText(body.details, REPORT_DETAILS_MAX);
  if (detailsRaw.startsWith("\u0000")) throw new ApiError(400, `Details max out at ${REPORT_DETAILS_MAX} characters.`);
  const details = detailsRaw || null;

  await enforce(c, `report:${user.id}`, 30, HOUR, "You've sent a lot of reports. Our mods are on it — try again later.");

  const now = Date.now();
  const target =
    targetType === "post"
      ? await c.env.DB.prepare("SELECT user_id FROM posts WHERE id = ? AND expires_at > ?").bind(targetId, now).first<{ user_id: string }>()
      : await c.env.DB.prepare(
          "SELECT c.user_id FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ? AND p.expires_at > ?",
        )
          .bind(targetId, now)
          .first<{ user_id: string }>();
  if (!target) throw new ApiError(404, "That content is already gone.");
  if (target.user_id === user.id) throw new ApiError(400, "You can't report your own content — just delete it.");

  const table = targetType === "post" ? "posts" : "comments";
  const inserted = await c.env.DB.prepare(
    `INSERT INTO reports (id, reporter_user_id, target_type, target_id, target_user_id, reason, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(reporter_user_id, target_type, target_id) DO NOTHING`,
  )
    .bind(randomId(), user.id, targetType, targetId, target.user_id, reason, details, now)
    .run();

  if (!inserted.meta.changes) return c.json({ ok: true, alreadyReported: true, hidden: false });

  const [, , open] = await c.env.DB.batch<{ n: number }>([
    c.env.DB.prepare(`UPDATE ${table} SET report_count = report_count + 1 WHERE id = ?`).bind(targetId),
    c.env.DB.prepare("UPDATE users SET reports_received = reports_received + 1 WHERE id = ?").bind(target.user_id),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open'").bind(targetType, targetId),
  ]);

  // "This is me" pulls the photo immediately; otherwise enough distinct reporters
  // pull it automatically. Either way an admin makes the final call.
  const hide = reason === "its_me" || (open.results[0]?.n ?? 0) >= AUTO_HIDE_REPORT_THRESHOLD;
  if (hide) await c.env.DB.prepare(`UPDATE ${table} SET status = 'hidden' WHERE id = ?`).bind(targetId).run();

  return c.json({ ok: true, alreadyReported: false, hidden: hide }, 201);
});

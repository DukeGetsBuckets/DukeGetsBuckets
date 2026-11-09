import { Hono } from "hono";
import { requireUser, type AppEnv } from "../lib/http";

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  const rand = new Uint32Array(a.length);
  crypto.getRandomValues(rand);
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Fair rotating queue of currently-live photo ids for this user:
 *   1. photos they haven't seen yet, shuffled
 *   2. photos they have seen, least-recently-seen first (with jitter so it isn't rigid)
 *   3. ids the client says it just showed (`recent`) go last, least-recently-shown first
 * The client keeps its own back/forward history and asks for a fresh queue when it runs out.
 */
export const feed = new Hono<AppEnv>().get("/queue", async (c) => {
  const user = requireUser(c);
  const now = Date.now();
  // `recent` is in display order (oldest first); remember each id's last position.
  const recentOrder = new Map<string, number>();
  (c.req.query("recent") ?? "")
    .split(",")
    .filter((s) => /^[A-Za-z0-9_-]{8,32}$/.test(s))
    .slice(-50)
    .forEach((id, i) => recentOrder.set(id, i));
  const recent = new Set(recentOrder.keys());

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, v.seen_at
       FROM posts p
       LEFT JOIN post_views v ON v.post_id = p.id AND v.user_id = ?
      WHERE p.status = 'active' AND p.expires_at > ?
      ORDER BY p.created_at DESC
      LIMIT 500`,
  )
    .bind(user.id, now)
    .all<{ id: string; seen_at: number | null }>();

  const unseen = shuffle(results.filter((r) => r.seen_at === null && !recent.has(r.id)));
  const seen = results
    .filter((r) => r.seen_at !== null && !recent.has(r.id))
    .map((r) => ({ id: r.id, k: (r.seen_at ?? 0) + Math.random() * 10 * 60_000 }))
    .sort((a, b) => a.k - b.k);
  // Round-robin: whatever was shown longest ago comes back first.
  const tail = results.filter((r) => recent.has(r.id)).sort((a, b) => recentOrder.get(a.id)! - recentOrder.get(b.id)!);

  return c.json({ ids: [...unseen, ...seen, ...tail].map((r) => r.id), serverNow: now });
});

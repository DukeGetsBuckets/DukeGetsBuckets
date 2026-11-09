// Sawyer Burner — Cloudflare Worker entry.
// Serves the JSON API (/api/*), authenticated photo delivery (/img/*) and the
// scheduled 24-hour purge. Static SPA assets are served by Workers Static Assets.

import { Hono } from "hono";
import { runScheduled } from "./lib/cleanup";
import { ApiError, requireUser, type AppEnv } from "./lib/http";
import { loadSessionUser } from "./lib/session";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";
import { comments } from "./routes/comments";
import { feed } from "./routes/feed";
import { canSeePost, posts } from "./routes/posts";
import { reports } from "./routes/reports";
import { users } from "./routes/users";

const app = new Hono<AppEnv>();

// ───────────── security headers ─────────────
app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "same-origin");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (new URL(c.req.url).protocol === "https:") h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (c.req.path.startsWith("/api/")) {
    h.set("Cache-Control", "no-store");
    h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  }
});

// ───────────── CSRF ─────────────
// State-changing API calls must (1) come from our own origin and (2) carry a custom
// header, which cross-site forms can't send and cross-origin fetch can't send without
// a CORS preflight we never approve. SameSite=Lax cookies are a third layer.
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if (origin && origin !== new URL(c.req.url).origin) throw new ApiError(403, "Cross-site request blocked.");
    if (site && site !== "same-origin" && site !== "none") throw new ApiError(403, "Cross-site request blocked.");
    if (c.req.header("x-bb2-csrf") !== "1") throw new ApiError(403, "Missing CSRF header.");
  }
  await next();
});

// ───────────── session ─────────────
app.use("*", async (c, next) => {
  c.set("user", await loadSessionUser(c));
  await next();
});

app.route("/api/auth", auth);
app.route("/api/feed", feed);
app.route("/api/posts", posts);
app.route("/api/comments", comments);
app.route("/api/reports", reports);
app.route("/api/users", users);
app.route("/api/admin", admin);
app.all("/api/*", () => {
  throw new ApiError(404, "Not found.");
});

// ───────────── photos ─────────────
// Images are only served to signed-in users and only while the post is live.
// The R2 key is never exposed; clients address photos by their opaque post id.
app.get("/img/:id", async (c) => {
  const user = requireUser(c);
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw new ApiError(404, "Not found.");
  const post = await c.env.DB.prepare("SELECT user_id, status, expires_at, image_key, mime_type FROM posts WHERE id = ?")
    .bind(id)
    .first<{ user_id: string; status: string; expires_at: number; image_key: string; mime_type: string }>();
  if (!post || !canSeePost(post, user)) throw new ApiError(404, "Not found.");

  const obj = await c.env.IMAGES.get(post.image_key, { onlyIf: c.req.raw.headers });
  if (!obj) throw new ApiError(404, "Not found.");
  const maxAge = Math.max(0, Math.min(3600, Math.floor((post.expires_at - Date.now()) / 1000)));
  const headers = new Headers({
    "Content-Type": post.mime_type,
    "Cache-Control": `private, max-age=${maxAge}`,
    ETag: obj.httpEtag,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
  });
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
});

// ───────────── errors ─────────────
app.onError((err, c) => {
  if (err instanceof ApiError) {
    if (err.retryAfter) c.header("Retry-After", String(err.retryAfter));
    return c.json({ error: err.message, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) }, err.status);
  }
  console.error(JSON.stringify({ event: "unhandled_error", path: c.req.path, message: String(err), stack: (err as Error)?.stack }));
  return c.json({ error: "Something broke on our end. Try again." }, 500);
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, controller.cron));
  },
} satisfies ExportedHandler<Env>;

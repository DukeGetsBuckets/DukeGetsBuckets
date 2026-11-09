import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker/index";
import { Client, makeAdmin, makeJpegWithExif, makePng, signup, uniqueName, uploadForm, uploadPng } from "./helpers";

async function imageKeyOf(postId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT image_key FROM posts WHERE id = ?").bind(postId).first<{ image_key: string }>();
  return row?.image_key ?? null;
}

async function runCron(cron = "*/5 * * * *") {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), env, ctx);
  await waitOnExecutionContext(ctx);
}

async function insertExpiredPost(owner: string): Promise<{ id: string; key: string }> {
  const user = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(owner).first<{ id: string }>();
  const id = `expired${Math.random().toString(36).slice(2, 12)}`;
  const key = `posts/${id}.png`;
  const created = Date.now() - 25 * 3600_000;
  await env.IMAGES.put(key, await makePng());
  await env.DB.prepare(
    `INSERT INTO posts (id, user_id, image_key, mime_type, width, height, size_bytes, created_at, expires_at)
     VALUES (?, ?, ?, 'image/png', 64, 48, 100, ?, ?)`,
  )
    .bind(id, user!.id, key, created, created + 24 * 3600_000)
    .run();
  return { id, key };
}

// ─────────────────────────────── auth ───────────────────────────────

describe("auth", () => {
  it("signs up, sets a secure HttpOnly session cookie, and returns /me", async () => {
    const client = new Client();
    const username = uniqueName("Roaster");
    const res = await client.fetch("POST", "/api/auth/signup", { username, password: "hunter2hunter2", confirmPassword: "hunter2hunter2", agree: true });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-bb2_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const me = await client.get("/api/auth/me");
    expect(me.data.user).toMatchObject({ username: username.toLowerCase(), role: "user", suspended: false });
    expect(Object.keys(me.data.user).sort()).toEqual(["createdAt", "mustChangePassword", "role", "suspended", "username"]);
    expect(JSON.stringify(me.data)).not.toMatch(/hash|pbkdf2|"id"/i);
  });

  it("stores only a PBKDF2 hash, never the plain password", async () => {
    const c = await signup(undefined, "super secret pw 1");
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE username = ?").bind(c.username).first<{ password_hash: string }>();
    expect(row!.password_hash).toMatch(/^pbkdf2_sha256\$100000\$/);
    expect(row!.password_hash).not.toContain("super secret");
  });

  it("rejects duplicate usernames case-insensitively", async () => {
    const c = await signup();
    const again = await new Client().post("/api/auth/signup", { username: c.username.toUpperCase(), password: "another pass 9", confirmPassword: "another pass 9", agree: true });
    expect(again.status).toBe(409);
    expect(again.data.error).toMatch(/taken/);
  });

  it("validates username, password confirmation and rules agreement", async () => {
    const c = new Client();
    const base = { password: "goodpassword1", confirmPassword: "goodpassword1", agree: true };
    expect((await c.post("/api/auth/signup", { ...base, username: "ab" })).status).toBe(400);
    expect((await c.post("/api/auth/signup", { ...base, username: "has space" })).status).toBe(400);
    expect((await c.post("/api/auth/signup", { ...base, username: "<script>" })).status).toBe(400);
    expect((await c.post("/api/auth/signup", { ...base, username: "admin" })).status).toBe(400);
    expect((await c.post("/api/auth/signup", { ...base, username: uniqueName(), confirmPassword: "different1" })).status).toBe(400);
    expect((await c.post("/api/auth/signup", { ...base, username: uniqueName(), password: "short", confirmPassword: "short" })).status).toBe(400);
    expect((await c.post("/api/auth/signup", { ...base, username: uniqueName(), agree: false })).status).toBe(400);
  });

  it("logs in, rejects a wrong password, and logs out", async () => {
    const c = await signup(undefined, "right password 1");
    const fresh = new Client();
    const bad = await fresh.post("/api/auth/login", { username: c.username, password: "wrong password" });
    expect(bad.status).toBe(401);
    expect(bad.data.error).toBe("Wrong username or password.");
    const unknown = await fresh.post("/api/auth/login", { username: "nobody_here_123", password: "whatever12" });
    expect(unknown.status).toBe(401);
    expect(unknown.data.error).toBe(bad.data.error); // no user enumeration

    const ok = await fresh.post("/api/auth/login", { username: c.username.toUpperCase(), password: "right password 1" });
    expect(ok.status).toBe(200);
    expect(ok.data.user.username).toBe(c.username);
    expect((await fresh.get("/api/feed/queue")).status).toBe(200);

    const sessionCookie = fresh.cookie;
    expect((await fresh.post("/api/auth/logout")).status).toBe(200);
    expect(fresh.cookie).toBe("");
    expect((await fresh.get("/api/auth/me")).data.user).toBeNull();
    // The old token is revoked server-side, not just cleared client-side.
    fresh.cookie = sessionCookie;
    expect((await fresh.get("/api/feed/queue")).status).toBe(401);
  });

  it("rate-limits brute-force attempts against one account", async () => {
    const c = await signup();
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const attacker = new Client(); // different IP every time
      last = (await attacker.post("/api/auth/login", { username: c.username, password: `guess-${i}-xx` })).status;
    }
    expect(last).toBe(429);
  });

  it("rate-limits login attempts per IP", async () => {
    const attacker = new Client("198.51.100.7");
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await attacker.post("/api/auth/login", { username: `victim_${i}`, password: "nope-nope" })).status);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[21]).toBe(429);
  });
});

// ─────────────────────────────── security middleware ───────────────────────────────

describe("security", () => {
  it("blocks state-changing requests without the CSRF header or from another origin", async () => {
    const c = await signup();
    const noHeader = await c.json("POST", "/api/auth/logout", {}, { "x-bb2-csrf": "" });
    expect(noHeader.status).toBe(403);
    const evil = await c.json("POST", "/api/auth/logout", {}, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const crossSite = await c.json("POST", "/api/auth/logout", {}, { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect((await c.get("/api/auth/me")).data.user).not.toBeNull();
  });

  it("requires login for the feed, posts, profiles and images", async () => {
    const anon = new Client();
    for (const path of ["/api/feed/queue", "/api/posts/abcdefghijkl", "/api/users/someone", "/img/abcdefghijkl"]) {
      expect((await anon.fetch("GET", path)).status).toBe(401);
    }
  });

  it("sends hardening headers on API responses", async () => {
    const res = await new Client().fetch("GET", "/api/auth/me");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age/);
  });
});

// ─────────────────────────────── uploads ───────────────────────────────

describe("uploads", () => {
  it("uploads a PNG, stores it in R2 with a 24h expiry, strips metadata", async () => {
    const c = await signup();
    const png = await makePng(80, 60, "GPS 40.7128,-74.0060");
    const { status, data } = await c.json("POST", "/api/posts", uploadForm(png, { caption: "roast my haircut" }));
    expect(status).toBe(201);
    expect(data.post).toMatchObject({ author: c.username, width: 80, height: 60, caption: "roast my haircut", isMine: true, commentCount: 0 });
    expect(data.post.expiresAt - data.post.createdAt).toBe(24 * 3600_000);
    expect(data.post.imageUrl).toBe(`/img/${data.post.id}`);

    const key = (await imageKeyOf(data.post.id))!;
    expect(key).toMatch(/^posts\/[A-Za-z0-9_-]+\.png$/);
    const obj = await env.IMAGES.get(key);
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(new TextDecoder().decode(stored)).not.toContain("40.7128");
    expect(obj!.httpMetadata?.contentType).toBe("image/png");

    const img = await c.fetch("GET", data.post.imageUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toMatch(/^private/);
    await img.arrayBuffer();
  });

  it("strips EXIF (GPS) from JPEGs", async () => {
    const c = await signup();
    const jpeg = makeJpegWithExif(400, 300, "GPSLatitude=51.5074");
    const { status, data } = await c.json("POST", "/api/posts", uploadForm(jpeg, { name: "x.jpg", type: "image/jpeg" }));
    expect(status).toBe(201);
    expect(data.post).toMatchObject({ width: 400, height: 300 });
    const stored = await (await env.IMAGES.get((await imageKeyOf(data.post.id))!))!.text();
    expect(stored).not.toContain("GPSLatitude");
    expect(stored).toContain("JFIF");
  });

  it("rejects non-images, SVG/GIF disguised as JPG, missing consent and junk captions", async () => {
    const c = await signup();
    const enc = new TextEncoder();
    const svg = enc.encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect((await c.json("POST", "/api/posts", uploadForm(svg, { name: "a.jpg", type: "image/jpeg" }))).status).toBe(415);
    const gif = enc.encode("GIF89a\x01\x00\x01\x00\x00\x00\x00;");
    expect((await c.json("POST", "/api/posts", uploadForm(gif, { name: "a.png", type: "image/png" }))).status).toBe(415);
    expect((await c.json("POST", "/api/posts", uploadForm(enc.encode("hello"), { name: "notes.txt", type: "text/plain" }))).status).toBe(415);
    const truncated = (await makePng()).slice(0, 60);
    expect((await c.json("POST", "/api/posts", uploadForm(truncated))).status).toBe(415);

    const noConsent = await c.json("POST", "/api/posts", uploadForm(await makePng(), { consent: false }));
    expect(noConsent.status).toBe(400);
    expect(noConsent.data.error).toMatch(/permission/);

    const dox = await c.json("POST", "/api/posts", uploadForm(await makePng(), { caption: "call him 555-867-5309" }));
    expect(dox.status).toBe(422);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts p JOIN users u ON u.id = p.user_id WHERE u.username = ?").bind(c.username).all<{ n: number }>();
    expect(results[0].n).toBe(0);
  });

  it("rejects oversized uploads", async () => {
    const c = await signup();
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(await makePng());
    expect((await c.json("POST", "/api/posts", uploadForm(big))).status).toBe(413);
  });

  it("rate-limits uploads", async () => {
    const c = await signup();
    const png = await makePng();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await c.json("POST", "/api/posts", uploadForm(png))).status);
    expect(statuses.slice(0, 6)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(statuses[6]).toBe(429);
  });
});

// ─────────────────────────────── feed ───────────────────────────────

describe("feed", () => {
  it("returns live photos, unseen first, and hides expired ones even before cleanup", async () => {
    const poster = await signup();
    const a = await uploadPng(poster);
    const b = await uploadPng(poster);
    const expired = await insertExpiredPost(poster.username);

    const viewer = await signup();
    const q1 = await viewer.get("/api/feed/queue");
    expect(q1.status).toBe(200);
    expect(q1.data.ids).toEqual(expect.arrayContaining([a, b]));
    expect(q1.data.ids).not.toContain(expired.id);

    // Viewing `a` marks it seen → unseen `b` comes first next time.
    expect((await viewer.get(`/api/posts/${a}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // waitUntil view write
    const q2 = await viewer.get("/api/feed/queue");
    expect(q2.data.ids.indexOf(b)).toBeLessThan(q2.data.ids.indexOf(a));

    // `recent` pushes just-shown ids to the end of the next queue.
    const q3 = await viewer.get(`/api/feed/queue?recent=${b}`);
    expect(q3.data.ids.at(-1)).toBe(b);
    // Recently shown photos come back round-robin: least-recently-shown first.
    expect((await viewer.get(`/api/feed/queue?recent=${a},${b}`)).data.ids.slice(-2)).toEqual([a, b]);
    expect((await viewer.get(`/api/feed/queue?recent=${b},${a}`)).data.ids.slice(-2)).toEqual([b, a]);

    expect((await viewer.get(`/api/posts/${expired.id}`)).status).toBe(404);
    expect((await viewer.fetch("GET", `/img/${expired.id}`)).status).toBe(404);
  });

  it("returns post details without private fields", async () => {
    const poster = await signup();
    const id = await uploadPng(poster, "rate my fit");
    const viewer = await signup();
    const { data } = await viewer.get(`/api/posts/${id}`);
    expect(data.post).toMatchObject({ id, author: poster.username, caption: "rate my fit", isMine: false });
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/user_id|image_key|posts\/|password|report/);
  });
});

// ─────────────────────────────── burns + reactions ───────────────────────────────

describe("burns", () => {
  it("posts burns, lists newest/hottest, reacts once, and un-reacts", async () => {
    const poster = await signup();
    const id = await uploadPng(poster);
    const roaster = await signup();
    const fan = await signup();

    const first = await roaster.post(`/api/posts/${id}/comments`, { body: "That haircut has a restraining order against combs." });
    expect(first.status).toBe(201);
    expect(first.data.comment).toMatchObject({ author: roaster.username, fireCount: 0, isMine: true, canDelete: true });
    const second = await roaster.post(`/api/posts/${id}/comments`, { body: "<img src=x onerror=alert(1)> lol" });
    expect(second.status).toBe(201);
    expect(second.data.comment.body).toBe("<img src=x onerror=alert(1)> lol"); // stored as text; React escapes on render

    const c1 = first.data.comment.id;
    const r1 = await fan.post(`/api/comments/${c1}/fire`);
    expect(r1.data).toEqual({ fireCount: 1, firedByMe: true });
    const r2 = await fan.post(`/api/comments/${c1}/fire`); // duplicate
    expect(r2.data).toEqual({ fireCount: 1, firedByMe: true });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM comment_reactions WHERE comment_id = ?").bind(c1).first<{ n: number }>();
    expect(rows!.n).toBe(1);

    const hot = await fan.get(`/api/posts/${id}/comments?sort=hot`);
    expect(hot.data.comments[0]).toMatchObject({ id: c1, fireCount: 1, firedByMe: true, isMine: false, canDelete: false });
    const fresh = await fan.get(`/api/posts/${id}/comments?sort=new`);
    expect(fresh.data.comments[0].id).toBe(second.data.comment.id);
    expect(fresh.data.commentCount).toBe(2);

    const un = await fan.del(`/api/comments/${c1}/fire`);
    expect(un.data).toEqual({ fireCount: 0, firedByMe: false });

    // Post owner can clear burns off their own photo.
    const ownerView = await poster.get(`/api/posts/${id}/comments`);
    expect(ownerView.data.comments.every((c: any) => c.canDelete)).toBe(true);
  });

  it("blocks doxxing, threats, slurs, links and over-length burns", async () => {
    const poster = await signup();
    const id = await uploadPng(poster);
    const c = await signup();
    const bad = [
      "his number is 415 555 0199 call him",
      "she lives at 1420 Maple Street lol",
      "email him at loser@example.com",
      "kys",
      "i'm gonna find you after school",
      "i know where you live",
      "check out bit.ly/abc",
      "f4ggot",
      "x".repeat(281),
    ];
    for (const body of bad) {
      const r = await c.post(`/api/posts/${id}/comments`, { body });
      expect([400, 422], `should reject: ${body.slice(0, 30)}`).toContain(r.status);
    }
    expect((await c.post(`/api/posts/${id}/comments`, { body: "   " })).status).toBe(400);
    // A normal roast with a number that isn't a phone number is fine.
    expect((await c.post(`/api/posts/${id}/comments`, { body: "Bro looks like he lost 3 fights to 1 pigeon" })).status).toBe(201);
  });

  it("rate-limits burns", async () => {
    const poster = await signup();
    const id = await uploadPng(poster);
    const c = await signup();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await c.post(`/api/posts/${id}/comments`, { body: `burn number ${i} of the day` })).status);
    expect(statuses.slice(0, 6).every((s) => s === 201)).toBe(true);
    expect(statuses[6]).toBe(429);
  });
});

// ─────────────────────────────── ownership ───────────────────────────────

describe("ownership", () => {
  it("lets users delete their own post (and its R2 object) but not others'", async () => {
    const owner = await signup();
    const other = await signup();
    const id = await uploadPng(owner);
    const key = (await imageKeyOf(id))!;
    const cm = await other.post(`/api/posts/${id}/comments`, { body: "nice try" });

    expect((await other.del(`/api/posts/${id}`)).status).toBe(403);
    expect((await owner.del(`/api/posts/${id}`)).status).toBe(200);
    expect(await imageKeyOf(id)).toBeNull();
    expect(await env.IMAGES.head(key)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM comments WHERE id = ?").bind(cm.data.comment.id).first()).toBeNull();
    expect((await other.get(`/api/posts/${id}`)).status).toBe(404);
  });

  it("lets users delete their own burns but not someone else's", async () => {
    const owner = await signup();
    const id = await uploadPng(owner);
    const a = await signup();
    const b = await signup();
    const cm = (await a.post(`/api/posts/${id}/comments`, { body: "burn by a" })).data.comment.id;
    expect((await b.del(`/api/comments/${cm}`)).status).toBe(403);
    expect((await a.del(`/api/comments/${cm}`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM comments WHERE id = ?").bind(cm).first()).toBeNull();
  });
});

// ─────────────────────────────── reports ───────────────────────────────

describe("reports", () => {
  it("reports a photo and a burn, once per user, and not your own content", async () => {
    const owner = await signup();
    const id = await uploadPng(owner);
    const troll = await signup();
    const cm = (await troll.post(`/api/posts/${id}/comments`, { body: "mean but legal" })).data.comment.id;
    const reporter = await signup();

    const r1 = await reporter.post("/api/reports", { targetType: "post", targetId: id, reason: "harassment", details: "targeting a classmate" });
    expect(r1.status).toBe(201);
    expect(r1.data.hidden).toBe(false);
    const dup = await reporter.post("/api/reports", { targetType: "post", targetId: id, reason: "spam" });
    expect(dup.data.alreadyReported).toBe(true);

    expect((await reporter.post("/api/reports", { targetType: "comment", targetId: cm, reason: "threats" })).status).toBe(201);
    expect((await owner.post("/api/reports", { targetType: "post", targetId: id, reason: "spam" })).status).toBe(400);
    expect((await reporter.post("/api/reports", { targetType: "post", targetId: id, reason: "bogus" })).status).toBe(400);

    const post = await env.DB.prepare("SELECT report_count FROM posts WHERE id = ?").bind(id).first<{ report_count: number }>();
    expect(post!.report_count).toBe(1);
    const u = await env.DB.prepare("SELECT reports_received FROM users WHERE username = ?").bind(owner.username).first<{ reports_received: number }>();
    expect(u!.reports_received).toBe(1);
  });

  it("'This is me' pulls the photo immediately; owner still sees it, others don't", async () => {
    const owner = await signup();
    const id = await uploadPng(owner);
    const subject = await signup();
    const r = await subject.post("/api/reports", { targetType: "post", targetId: id, reason: "its_me", details: "that's me, I never agreed" });
    expect(r.data.hidden).toBe(true);
    expect((await subject.get("/api/feed/queue")).data.ids).not.toContain(id);
    expect((await subject.get(`/api/posts/${id}`)).status).toBe(404);
    expect((await subject.fetch("GET", `/img/${id}`)).status).toBe(404);
    const own = await owner.get(`/api/posts/${id}`);
    expect(own.data.post.hidden).toBe(true);
  });

  it("auto-hides content after 3 distinct reports", async () => {
    const owner = await signup();
    const id = await uploadPng(owner);
    for (let i = 0; i < 3; i++) {
      const r = await (await signup()).post("/api/reports", { targetType: "post", targetId: id, reason: "harassment" });
      expect(r.data.hidden).toBe(i === 2);
    }
  });
});

// ─────────────────────────────── admin ───────────────────────────────

describe("admin", () => {
  it("blocks non-admins and anonymous users from every admin API", async () => {
    const user = await signup();
    const anon = new Client();
    const routes: Array<[string, string]> = [
      ["GET", "/api/admin/stats"], ["GET", "/api/admin/posts"], ["GET", "/api/admin/comments"],
      ["GET", "/api/admin/reports"], ["GET", "/api/admin/users"], ["DELETE", "/api/admin/posts/abcdefghijkl"],
      ["DELETE", "/api/admin/comments/abcdefghijkl"], ["POST", "/api/admin/reports/resolve"],
      ["POST", `/api/admin/users/${user.username}/suspend`], ["DELETE", `/api/admin/users/${user.username}`],
    ];
    for (const [method, path] of routes) {
      expect((await user.json(method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(403);
      expect((await anon.json(method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(401);
    }
    // Forged role in the request body means nothing: role is only ever read from D1.
    expect((await user.json("GET", "/api/admin/stats", undefined, { "x-role": "admin" })).status).toBe(403);
  });

  it("gives admins stats, lists, and the ability to delete photos and burns", async () => {
    const admin = await signup();
    await makeAdmin(admin.username);
    const me = await admin.get("/api/auth/me");
    expect(me.data.user.role).toBe("admin");

    const poster = await signup();
    const id = await uploadPng(poster);
    const key = (await imageKeyOf(id))!;
    const burner = await signup();
    const cm = (await burner.post(`/api/posts/${id}/comments`, { body: "admin will delete this" })).data.comment.id;
    const cm2 = (await burner.post(`/api/posts/${id}/comments`, { body: "and this one via photo" })).data.comment.id;
    await (await signup()).post(`/api/comments/${cm2}/fire`);

    const stats = await admin.get("/api/admin/stats");
    expect(stats.status).toBe(200);
    expect(stats.data.stats.activePhotos).toBeGreaterThanOrEqual(1);
    expect(stats.data.stats.uploads24h).toBeGreaterThanOrEqual(1);

    const list = await admin.get("/api/admin/posts");
    expect(list.data.posts.find((p: any) => p.id === id)).toMatchObject({ uploader: poster.username, commentCount: 2 });

    expect((await admin.del(`/api/admin/comments/${cm}`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM comments WHERE id = ?").bind(cm).first()).toBeNull();

    expect((await admin.del(`/api/admin/posts/${id}`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM posts WHERE id = ?").bind(id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM comments WHERE post_id = ?").bind(id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM comment_reactions WHERE comment_id = ?").bind(cm2).first()).toBeNull();
    expect(await env.IMAGES.head(key)).toBeNull();
  });

  it("runs the moderation queue: prioritises, removes and dismisses", async () => {
    const admin = await signup();
    await makeAdmin(admin.username);
    const poster = await signup();
    const once = await uploadPng(poster);
    const twice = await uploadPng(poster);
    await (await signup()).post("/api/reports", { targetType: "post", targetId: once, reason: "spam" });
    await (await signup()).post("/api/reports", { targetType: "post", targetId: twice, reason: "harassment" });
    await (await signup()).post("/api/reports", { targetType: "post", targetId: twice, reason: "personal_info", details: "shows a street sign" });

    const q = await admin.get("/api/admin/reports");
    const mine = q.data.groups.filter((g: any) => [once, twice].includes(g.targetId));
    expect(mine[0]).toMatchObject({ targetId: twice, reportCount: 2, targetStatus: "active" });
    expect(mine[0].reports[0].reporter).toBeTruthy();
    expect(mine[1]).toMatchObject({ targetId: once, reportCount: 1 });

    expect((await admin.post("/api/admin/reports/resolve", { targetType: "post", targetId: once, action: "dismiss" })).status).toBe(200);
    expect((await admin.post("/api/admin/reports/resolve", { targetType: "post", targetId: twice, action: "remove" })).status).toBe(200);
    expect(await imageKeyOf(twice)).toBeNull();
    expect(await imageKeyOf(once)).not.toBeNull();
    const after = await admin.get("/api/admin/reports");
    expect(after.data.groups.some((g: any) => [once, twice].includes(g.targetId))).toBe(false);
  });

  it("suspends a user (blocking posts, burns and reactions) and unsuspends", async () => {
    const admin = await signup();
    await makeAdmin(admin.username);
    const target = await signup();
    const other = await signup();
    const id = await uploadPng(other);
    const cm = (await other.post(`/api/posts/${id}/comments`, { body: "a burn" })).data.comment.id;

    expect((await admin.post(`/api/admin/users/${target.username}/suspend`)).status).toBe(200);
    expect((await target.get("/api/auth/me")).data.user.suspended).toBe(true);
    expect((await target.json("POST", "/api/posts", uploadForm(await makePng()))).status).toBe(403);
    expect((await target.post(`/api/posts/${id}/comments`, { body: "can't post this" })).status).toBe(403);
    expect((await target.post(`/api/comments/${cm}/fire`)).status).toBe(403);

    const users = await admin.get(`/api/admin/users?q=${target.username}`);
    expect(users.data.users[0]).toMatchObject({ username: target.username, status: "suspended" });

    expect((await admin.post(`/api/admin/users/${target.username}/unsuspend`)).status).toBe(200);
    expect((await target.post(`/api/posts/${id}/comments`, { body: "i'm back baby" })).status).toBe(201);
  });

  it("cannot suspend or delete admins (including itself)", async () => {
    const a = await signup();
    const b = await signup();
    await makeAdmin(a.username);
    await makeAdmin(b.username);
    expect((await a.post(`/api/admin/users/${a.username}/suspend`)).status).toBe(400);
    expect((await a.post(`/api/admin/users/${b.username}/suspend`)).status).toBe(403);
  });

  it("deletes a user with all their content and images", async () => {
    const admin = await signup();
    await makeAdmin(admin.username);
    const doomed = await signup();
    const id = await uploadPng(doomed);
    const key = (await imageKeyOf(id))!;
    const other = await signup();
    const otherPost = await uploadPng(other);
    await doomed.post(`/api/posts/${otherPost}/comments`, { body: "last words" });

    expect((await admin.del(`/api/admin/users/${doomed.username}`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(doomed.username).first()).toBeNull();
    expect(await env.IMAGES.head(key)).toBeNull();
    expect((await other.get(`/api/posts/${otherPost}/comments`)).data.comments).toHaveLength(0);
    expect((await doomed.get("/api/auth/me")).data.user).toBeNull();
  });
});

// ─────────────────────────────── review archive (reported content only) ───────────────────────────────

describe("review archive", () => {
  it("keeps reported burns/photos for admins, deletes unreported ones completely", async () => {
    const admin = await signup();
    await makeAdmin(admin.username);
    const owner = await signup();
    const troll = await signup();
    const reporter = await signup();

    const id = await uploadPng(owner, "reported photo");
    const key = (await imageKeyOf(id))!;
    const reportedBurn = (await troll.post(`/api/posts/${id}/comments`, { body: "you look like a thumb" })).data.comment.id;
    const cleanBurn = (await troll.post(`/api/posts/${id}/comments`, { body: "nice lighting though" })).data.comment.id;
    const deletedReported = (await troll.post(`/api/posts/${id}/comments`, { body: "this one I will delete myself" })).data.comment.id;
    await reporter.post("/api/reports", { targetType: "comment", targetId: reportedBurn, reason: "harassment", details: "targeting" });
    await reporter.post("/api/reports", { targetType: "comment", targetId: deletedReported, reason: "threats" });
    await reporter.post("/api/reports", { targetType: "post", targetId: id, reason: "non_consensual" });

    // Author deletes a reported burn → archived as evidence.
    expect((await troll.del(`/api/comments/${deletedReported}`)).status).toBe(200);
    // Expire the photo and run the cron.
    await env.DB.prepare("UPDATE posts SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, id).run();
    await runCron();

    expect(await env.IMAGES.head(key)).toBeNull(); // the image itself is always deleted
    expect(await env.DB.prepare("SELECT 1 FROM comments WHERE post_id = ?").bind(id).first()).toBeNull();

    const burns = (await admin.get(`/api/admin/archive?q=${troll.username}`)).data.burns;
    const byId = Object.fromEntries(burns.map((b: any) => [b.id, b]));
    expect(byId[reportedBurn]).toMatchObject({ author: troll.username, photoOwner: owner.username, body: "you look like a thumb", deletionReason: "expired" });
    expect(byId[reportedBurn].reports[0]).toMatchObject({ reason: "harassment", details: "targeting", reporter: reporter.username });
    expect(byId[deletedReported]).toMatchObject({ deletionReason: "deleted_by_author" });
    expect(byId[cleanBurn]).toBeUndefined(); // never reported → gone for good
    expect(await env.DB.prepare("SELECT 1 FROM burn_archive WHERE id = ?").bind(cleanBurn).first()).toBeNull();

    const photos = (await admin.get(`/api/admin/archive?type=photos&q=${owner.username}`)).data.posts;
    expect(photos[0]).toMatchObject({ id, owner: owner.username, caption: "reported photo", deletionReason: "expired" });
    expect(photos[0].reports[0].reason).toBe("non_consensual");
    expect(JSON.stringify(photos)).not.toMatch(/imageUrl|posts\//);

    // Unreported photo → nothing archived.
    const plain = await uploadPng(owner);
    await owner.del(`/api/posts/${plain}`);
    expect(await env.DB.prepare("SELECT 1 FROM post_archive WHERE id = ?").bind(plain).first()).toBeNull();

    // Non-admins can't read the archive.
    expect((await troll.get("/api/admin/archive")).status).toBe(403);
  });

  it("shows an admin everything one user has posted, live and reported history", async () => {
    const admin = await signup();
    await makeAdmin(admin.username);
    const u = await signup();
    const other = await signup();
    const live = await uploadPng(u, "still up");
    const otherPost = await uploadPng(other);
    const liveBurn = (await u.post(`/api/posts/${otherPost}/comments`, { body: "live burn" })).data.comment.id;
    const gone = (await u.post(`/api/posts/${otherPost}/comments`, { body: "reported then removed" })).data.comment.id;
    await other.post("/api/reports", { targetType: "comment", targetId: gone, reason: "spam" });
    await admin.del(`/api/admin/comments/${gone}`);

    const { status, data } = await admin.get(`/api/admin/users/${u.username}`);
    expect(status).toBe(200);
    expect(data.user.username).toBe(u.username);
    expect(data.livePosts.map((p: any) => p.id)).toEqual([live]);
    expect(data.liveBurns.map((b: any) => b.id)).toEqual([liveBurn]);
    expect(data.archivedBurns[0]).toMatchObject({ id: gone, deletionReason: "removed_by_admin" });
    expect(JSON.stringify(data)).not.toMatch(/password|hash/i);
    expect((await u.get(`/api/admin/users/${u.username}`)).status).toBe(403);
  });
});

// ─────────────────────────────── passwords ───────────────────────────────

describe("password reset and change", () => {
  it("admin issues a temporary password; user must change it; old password and sessions die", async () => {
    const admin = await signup();
    await makeAdmin(admin.username);
    const u = await signup(undefined, "original password 1");

    expect((await u.post(`/api/admin/users/${u.username}/reset-password`)).status).toBe(403); // non-admin
    const reset = await admin.post(`/api/admin/users/${u.username}/reset-password`);
    expect(reset.status).toBe(200);
    const temp = reset.data.temporaryPassword as string;
    expect(temp).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

    // Existing session was revoked.
    expect((await u.get("/api/auth/me")).data.user).toBeNull();
    const fresh = new Client();
    expect((await fresh.post("/api/auth/login", { username: u.username, password: "original password 1" })).status).toBe(401);
    const login = await fresh.post("/api/auth/login", { username: u.username, password: temp });
    expect(login.status).toBe(200);
    expect(login.data.user.mustChangePassword).toBe(true);

    // Temporary password only unlocks the change-password screen.
    expect((await fresh.get("/api/feed/queue")).status).toBe(403);
    expect((await fresh.post("/api/auth/change-password", { currentPassword: "wrong", newPassword: "brand new pass 7", confirmPassword: "brand new pass 7" })).status).toBe(401);
    const changed = await fresh.post("/api/auth/change-password", { currentPassword: temp, newPassword: "brand new pass 7", confirmPassword: "brand new pass 7" });
    expect(changed.status).toBe(200);
    expect(changed.data.user.mustChangePassword).toBe(false);
    expect((await fresh.get("/api/feed/queue")).status).toBe(200);

    const again = new Client();
    expect((await again.post("/api/auth/login", { username: u.username, password: temp })).status).toBe(401);
    expect((await again.post("/api/auth/login", { username: u.username, password: "brand new pass 7" })).status).toBe(200);
  });

  it("lets a user change their own password and signs out their other sessions", async () => {
    const a = await signup(undefined, "first password 11");
    const other = new Client();
    await other.post("/api/auth/login", { username: a.username, password: "first password 11" });
    const r = await a.post("/api/auth/change-password", { currentPassword: "first password 11", newPassword: "second password 22", confirmPassword: "second password 22" });
    expect(r.status).toBe(200);
    expect((await a.get("/api/feed/queue")).status).toBe(200); // this session survives
    expect((await other.get("/api/feed/queue")).status).toBe(401); // the other one is signed out
  });
});

// ─────────────────────────────── profiles ───────────────────────────────

describe("profiles", () => {
  it("shows only safe public info", async () => {
    const u = await signup();
    const id = await uploadPng(u);
    await u.post(`/api/posts/${id}/comments`, { body: "self-roast" });
    const viewer = await signup();
    const { status, data } = await viewer.get(`/api/users/${u.username}`);
    expect(status).toBe(200);
    expect(data.profile.username).toBe(u.username);
    expect(data.profile.posts.map((p: any) => p.id)).toEqual([id]);
    expect(data.profile.recentComments[0].body).toBe("self-roast");
    const keys = JSON.stringify(data).match(/"(\w+)":/g)!.map((k) => k.slice(1, -2));
    expect(new Set(keys)).toEqual(
      new Set(["profile", "username", "joinedAt", "posts", "id", "imageUrl", "createdAt", "expiresAt", "commentCount", "width", "height", "recentComments", "body", "postId", "fireCount"]),
    );
    expect((await viewer.get("/api/users/does_not_exist")).status).toBe(404);
  });
});

// ─────────────────────────────── 24h expiry + cron ───────────────────────────────

describe("scheduled cleanup", () => {
  it("purges expired posts with their comments, reactions, reports, views and R2 image", async () => {
    const owner = await signup();
    const other = await signup();
    const live = await uploadPng(owner);
    const liveKey = (await imageKeyOf(live))!;
    const exp = await insertExpiredPost(owner.username);

    const ownerId = (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(owner.username).first<{ id: string }>())!.id;
    const otherId = (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(other.username).first<{ id: string }>())!.id;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO comments (id, post_id, user_id, body, created_at) VALUES ('cexp1234567', ?, ?, 'old burn', ?)").bind(exp.id, otherId, now - 90_000_000),
      env.DB.prepare("INSERT INTO comment_reactions (id, comment_id, user_id, created_at) VALUES ('rexp1234567', 'cexp1234567', ?, ?)").bind(ownerId, now),
      env.DB.prepare("INSERT INTO reports (id, reporter_user_id, target_type, target_id, reason, created_at) VALUES ('pexp1234567', ?, 'post', ?, 'spam', ?)").bind(otherId, exp.id, now),
      env.DB.prepare("INSERT INTO reports (id, reporter_user_id, target_type, target_id, reason, created_at) VALUES ('qexp1234567', ?, 'comment', 'cexp1234567', 'spam', ?)").bind(ownerId, now),
      env.DB.prepare("INSERT INTO post_views (user_id, post_id, seen_at) VALUES (?, ?, ?)").bind(otherId, exp.id, now),
    ]);

    await runCron();

    expect(await env.DB.prepare("SELECT 1 FROM posts WHERE id = ?").bind(exp.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM comments WHERE id = 'cexp1234567'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM comment_reactions WHERE id = 'rexp1234567'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM reports WHERE id IN ('pexp1234567', 'qexp1234567')").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM post_views WHERE post_id = ?").bind(exp.id).first()).toBeNull();
    expect(await env.IMAGES.head(exp.key)).toBeNull();

    // Live content is untouched.
    expect(await imageKeyOf(live)).toBe(liveKey);
    expect(await env.IMAGES.head(liveKey)).not.toBeNull();
  });

  it("purges expired sessions and rate-limit rows", async () => {
    await env.DB.prepare("INSERT INTO rate_limits (key, count, reset_at) VALUES ('stale-key', 3, ?)").bind(Date.now() - 1000).run();
    await runCron();
    expect(await env.DB.prepare("SELECT 1 FROM rate_limits WHERE key = 'stale-key'").first()).toBeNull();
  });

  it("hourly sweep removes orphaned R2 objects that no post references", async () => {
    await env.IMAGES.put("posts/orphan-test.png", await makePng(), { customMetadata: {} });
    // Fresh orphan (< 1h old) is left alone in case its DB insert is in flight.
    await runCron("17 * * * *");
    expect(await env.IMAGES.head("posts/orphan-test.png")).not.toBeNull();
  });
});

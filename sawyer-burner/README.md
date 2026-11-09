# Sawyer Burner

**24 HOURS. POST IT. IT BURNS UP TOMORROW.**

A fast, mobile-first photo-roasting app. Signed-in users post a photo, everyone else leaves "burns" (roast comments) and 🔥 the best ones, and people swipe through photos one at a time. Every photo, and every burn, reaction and report on it, is **permanently deleted 24 hours after posting**. The only exception: a private text record of anything that was *reported* is kept for moderators (images are still deleted).

It runs entirely on Cloudflare: one Worker serves the React app and the API, D1 holds relational data, R2 stores photos, and a Cron Trigger handles deletion.

---

## Contents

1. [Architecture](#architecture)
2. [Directory structure](#directory-structure)
3. [Database](#database)
4. [Cloudflare resources](#cloudflare-resources)
5. [Local development](#local-development)
6. [Deploying to Cloudflare](#deploying-to-cloudflare)
7. [Admin setup](#admin-setup)
8. [Environment variables and secrets](#environment-variables-and-secrets)
9. [How 24-hour deletion works](#how-24-hour-deletion-works)
10. [Safety and moderation](#safety-and-moderation)
11. [Security model](#security-model)
12. [Testing](#testing)
13. [Known limitations](#known-limitations)
14. [Recommended next steps](#recommended-next-steps)

---

## Architecture

```
                    ┌──────────────────────── Cloudflare Worker "sawyer-burner" ─────────────────────────┐
 Browser ──HTTPS──► │  Static Assets (React SPA, _headers CSP)      ← every path except /api/* and /img/*  │
 (React SPA)        │                                                                                     │
                    │  Hono app  /api/*  ── auth · feed · posts · burns · 🔥 · reports · profiles · admin │──► D1  (users, sessions, posts,
                    │            /img/:id ─ session-checked photo delivery (R2 key never exposed)         │        comments, reactions, reports,
                    │                                                                                     │        post_views, rate_limits)
                    │  scheduled()  */5 * * * *  purge expired posts + comments + 🔥 + reports + images   │──► R2  (sawyer-burner-images)
                    │               17 * * * *   + R2 orphan sweep (safety net)                           │
                    └─────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + TypeScript, built by Vite 8 | Fast SPA with a tiny custom router, no UI framework. Self-hosted fonts keep the CSP at `'self'`. |
| Hosting | Workers Static Assets via `@cloudflare/vite-plugin` | Cloudflare's current recommended setup for full-stack apps: one deploy, one origin, no CORS. |
| API | Hono on Workers | Small, typed routing. |
| Data | D1 (SQLite) | Relational schema with foreign keys, unique constraints and indexes. |
| Photos | R2 | Cheap object storage with no egress fees. |
| Expiry | Cron Triggers | Native scheduled cleanup. Feed queries also ignore expired rows, so content never shows past 24h even between runs. |

Everything is authenticated. Photos are only reachable through `/img/:postId`, which checks the session and the post's status and expiry on every request.

## Directory structure

```
.
├── wrangler.jsonc            # Worker, D1, R2, Cron, assets config
├── vite.config.ts            # React + Cloudflare Vite plugin
├── vitest.config.ts          # Tests run inside workerd with real D1/R2 (Miniflare)
├── index.html
├── migrations/
│   ├── 0001_init.sql         # Full schema
│   └── 0002_archive_and_password_reset.sql  # Reported-content archive + temp passwords
├── shared/                   # Used by both Worker and client
│   ├── rules.ts              # Limits: TTL, lengths, upload size, report reasons
│   └── types.ts              # API response shapes (public-safe fields only)
├── worker/
│   ├── index.ts              # Hono app, security headers, CSRF, /img, scheduled()
│   ├── lib/
│   │   ├── cleanup.ts        # Hard delete of posts/comments/users + 24h purge + R2 sweep
│   │   ├── crypto.ts         # PBKDF2 password hashing, ids, HMAC
│   │   ├── http.ts           # Context types, ApiError, auth guards
│   │   ├── image.ts          # Magic-byte validation, dimensions, EXIF/GPS stripping
│   │   ├── moderation.ts     # Username/password rules, doxxing/threat/slur/link filters
│   │   ├── ratelimit.ts      # D1 fixed-window rate limiter
│   │   └── session.ts        # Session cookies (hashed tokens in D1)
│   └── routes/               # auth, feed, posts, comments, reports, users, admin
├── src/                      # React app
│   ├── App.tsx  main.tsx  styles.css
│   ├── components/           # Nav, Burns, Modal, ReportDialog, Toast, Icons
│   ├── lib/                  # api client, auth context, router, time, image compression
│   └── pages/                # Landing, Auth, Feed, Upload, Profile, Admin, Rules
├── public/                   # _headers (CSP etc.), favicon, robots.txt
├── scripts/seed-local.mjs    # Seeds a LOCAL dev server with demo users/photos/burns
└── test/                     # api.test.ts (integration), unit.test.ts, helpers
```

## Database

All primary keys are random 96-bit URL-safe strings (no sequential IDs). Timestamps are epoch milliseconds. See [`migrations/0001_init.sql`](migrations/0001_init.sql).

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | username, `password_hash`, `role` (`user`/`admin`), `status` (`active`/`suspended`), lifetime `reports_received` | `username` UNIQUE, NOCASE |
| `sessions` | SHA-256 of the session token, user, expiry | FK → users (cascade) |
| `posts` | uploader, R2 `image_key`, mime, width/height, caption, `status` (`active`/`hidden`), `report_count`, `created_at`, `expires_at` (= created + 24h) | FK → users; indexes on `(status, expires_at)` and `expires_at` |
| `comments` | burns: post, author, body, status, report_count | FK → posts, users |
| `comment_reactions` | 🔥 reactions | **UNIQUE(comment_id, user_id)**: one per user per burn |
| `reports` | reporter, target (post/comment), target owner, reason, details, status (`open`/`dismissed`/`actioned`) | UNIQUE(reporter, target) |
| `post_views` | which live posts a user has seen (feed fairness) | PK(user, post), dies with the post |
| `rate_limits` | fixed-window counters keyed by user id or HMAC'd IP | purged by cron |
| `burn_archive` / `post_archive` | text records of **reported** burns/photos after deletion (author snapshot, reports as JSON, deletion reason) | written in the same transaction as the delete |

## Cloudflare resources

| Resource | Name | Binding |
|---|---|---|
| Worker (with Static Assets) | `sawyer-burner` | n/a |
| D1 database | `sawyer-burner` | `DB` |
| R2 bucket | `sawyer-burner-images` | `IMAGES` |
| Cron Triggers | `*/5 * * * *` (purge) and `17 * * * *` (purge + R2 sweep) | `scheduled()` |
| Secret | `IP_HASH_SECRET` | `env.IP_HASH_SECRET` |

> **Plan note:** passwords are hashed with PBKDF2-SHA256 at 100,000 iterations, which uses more CPU than the Workers **Free** plan's 10 ms per request allows. Signup and login need the **Workers Paid** plan ($5/month), which also raises D1/R2 limits.

## Local development

Requires Node.js 20+ (tested on Node 24).

```bash
# 1. Install dependencies
npm install

# 2. Local secrets
cp .dev.vars.example .dev.vars        # then put any long random string in IP_HASH_SECRET

# 3. Create the local D1 schema (stored in .wrangler/state)
npm run db:migrate:local

# 4. Start the dev server (Vite + the Worker running in workerd, with local D1/R2)
npm run dev                           # → http://localhost:5173
```

Optional: seed demo accounts, photos and burns into the running dev server. It prints the generated passwords:

```bash
npm run seed
```

Trigger the cron cleanup locally while `npm run dev` is running:

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"
```

## Deploying to Cloudflare

> **Already provisioned.** The D1 database `sawyer-burner`
> (`f2964459-1926-4597-a081-0fffbd8a252c`) and the R2 bucket `sawyer-burner-images`
> have been created, both migrations are applied to the remote database, and
> `wrangler.jsonc` already holds the real `database_id`. On this account you only need
> steps 1, 2 and 6–8 below. Steps 3–5 are for setting the app up on a fresh account.

Run these from the `sawyer-burner/` directory. You need a Cloudflare account on the
Workers Paid plan (PBKDF2 password hashing exceeds the Free plan's 10 ms CPU limit).

**1. Install dependencies**
```bash
npm install
```

**2. Log in to Cloudflare**
```bash
npx wrangler login
```

**3. Create the D1 database** *(fresh account only)*
```bash
npx wrangler d1 create sawyer-burner
```
Copy the printed `database_id` into `wrangler.jsonc`.

**4. Create the R2 bucket** *(fresh account only)*
```bash
npx wrangler r2 bucket create sawyer-burner-images
```
Optional extra safety net, so R2 itself drops anything older than 2 days even if the
Worker somehow did not:
```bash
npx wrangler r2 bucket lifecycle add sawyer-burner-images expire-old-photos --expire-days 2
```

**5. Run the migrations on the remote database** *(fresh account only)*
```bash
npm run db:migrate:remote
```

**6. Set the secret**
```bash
npx wrangler secret put IP_HASH_SECRET
```
Paste a long random value, for example the output of `openssl rand -base64 32`. If the
Worker does not exist yet, Wrangler offers to create it.

**7. Build**
```bash
npm run build
```
This typechecks everything, then builds the client into `dist/client` and the Worker
into `dist/sawyer_burner`.

**8. Deploy**
```bash
npm run deploy
```
`npm run deploy` does steps 7 and 8 together. The Worker is served at
`https://sawyer-burner.<your-subdomain>.workers.dev` — on this account that will be
https://sawyer-burner.duke-rhodes.workers.dev. To use your own domain, add a Custom
Domain under **Workers & Pages → sawyer-burner → Settings → Domains & Routes**.

Check the cron schedule and live logs:
```bash
npx wrangler tail
```

## Admin setup

Admin rights are a `role` column in D1, checked server-side on every request. There's no way to become an admin through the app.

1. Sign up normally on the deployed site.
2. Promote that account:
   ```bash
   npx wrangler d1 execute sawyer-burner --remote -c wrangler.jsonc --command "UPDATE users SET role = 'admin' WHERE username = 'your_username'"
   ```
3. Reload the site. **Admin** now appears in the nav, and `/admin` works.

To demote: the same command with `role = 'user'`. Admins can't suspend or delete other admins from the panel; demote them first.

The admin panel has:
- **Overview:** live photos, users, burns, open reports, uploads in the last 24h
- **Reports:** a queue grouped by content. "This is me" takedowns come first, then items with the most reports. Each item offers **Remove content** or **Dismiss report**.
- **Photos:** every live photo with uploader, times, burn and report counts, and **Delete**
- **Burns:** every burn with author, photo, time, reports, and **Delete**
- **Users:** search, post/burn/report counts, **Suspend / Unsuspend / Delete** (delete removes all of the user's photos, including the R2 images). Click a username for their full history: live photos and burns, plus any reported content that has since been deleted, and **Reset password**.
- **Review archive:** reported burns and photos kept after they leave the site (text, reporter, reasons, and why it was deleted). Unreported content is never kept. Photo images are always deleted.

**Forgotten passwords:** passwords are stored only as one-way hashes, so nobody (including admins) can see them. Use **Reset password** on the user's page: you get a one-time temporary password to give them, their sessions are signed out, and they must pick a new password when they log in. Users can also change their own password from their profile.

## Environment variables and secrets

| Name | Type | Where | Purpose |
|---|---|---|---|
| `IP_HASH_SECRET` | **secret** | `wrangler secret put` / `.dev.vars` | HMAC key for turning client IPs into rate-limit keys. Raw IPs are never stored. Required in production. |
| `APP_NAME` | var | `wrangler.jsonc` | Display name. |

No database passwords or API keys are needed: D1 and R2 are accessed through bindings.

## How 24-hour deletion works

1. **At upload:** `expires_at = created_at + 24h`, exactly.
2. **Always:** every feed, post, burn, profile and image query requires `expires_at > now`. An expired photo is unreachable the instant it expires, even if cleanup hasn't run yet. Image responses are `Cache-Control: private` with a `max-age` that never outlasts the post.
3. **Reported content:** before anything with at least one report is deleted, a text record (burn text or caption, author, reports) is copied to `burn_archive` / `post_archive` in the same transaction, for admin review. Images are never archived.
4. **Every 5 minutes (Cron):** `purgeExpiredPosts` finds expired posts in batches of 40 and, for each batch:
   - deletes the images from **R2** first,
   - then, in one D1 transaction, deletes the reports on the post and its burns, the 🔥 reactions, the burns, the view records and the post rows.

   If R2 fails, nothing is removed from D1 and the next run retries. Expired sessions and stale rate-limit rows are also purged.
4. **Hourly (Cron `17 * * * *`):** an R2 sweep deletes any object older than 24h15m (and any row still pointing at it), plus any object older than 1h that no post references (for example an upload whose DB insert failed).
5. **Optional:** the R2 lifecycle rule from deploy step 4.

Manual deletions (owner deletes a photo, admin removes content, admin deletes a user) use the same code path, so they also remove R2 objects immediately.

## Safety and moderation

- **Consent at upload:** you must check "I have permission to post this image" or the server rejects the upload.
- **"This is me — take it down":** a report reason on photos that pulls the photo from the feed **immediately** and puts it at the top of the admin queue.
- **Auto-hide:** 3 distinct open reports hide a photo or burn until an admin decides.
- **Report button** on every photo and burn, with reasons: harassment, posted without permission, this is me, personal info, threats, sexual content, spam, other. One report per user per item.
- **Content filter** on burns and captions blocks phone numbers, emails, street addresses, ID numbers, "his password is…"-style leaks, links, threats ("kys", "I know where you live", "I'm gonna find you"…), sexual comments about minors, and slurs (including leetspeak and spaced-out spellings). It runs on individual words, so "Scunthorpe" and "sniggering" still pass.
- **Photo metadata stripped:** EXIF, XMP and text chunks (GPS, device serials) are removed server-side from JPEG, PNG and WEBP. The client also re-encodes through a canvas before upload.
- **Delete controls:** users can delete their own photos and burns, and can also delete burns left on their own photos.
- **Suspension:** suspended users can browse and report but can't post, burn or react.
- **Community Rules** at `/rules`, public and linked from signup (agreement required), the landing page and the upload page.
- **Public profiles** show only the username, join date, live photos and recent burns.

## Security model

| Threat | Mitigation |
|---|---|
| Password theft | PBKDF2-SHA256, 100k iterations, 128-bit per-user salt, constant-time compare. Unknown usernames still run a full hash, so timing doesn't reveal which accounts exist. |
| Session theft / fixation | 256-bit random token in an `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefixed cookie. Only its SHA-256 is stored. A fresh token is issued on every login. Logout revokes the token server-side. 30-day sliding expiry. |
| Brute force | 20 login attempts / 15 min per IP, and 8 failures / 15 min per account. Signup: 5 accounts / hour per IP. |
| CSRF | Mutating requests need a custom `X-BB2-CSRF` header (cross-site forms can't send it, and cross-origin fetch would need a CORS preflight we never approve), plus an `Origin` / `Sec-Fetch-Site` check and SameSite cookies. |
| XSS | React escapes everything; no `dangerouslySetInnerHTML`. Strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`). Invisible and bidi-override characters are stripped from text. |
| SQL injection | Every value is a bound parameter. The only interpolated SQL is constant: fixed table names, `ORDER BY` clauses picked from two options, and generated `?, ?, …` placeholder lists. |
| IDOR / privilege escalation | Ownership checked server-side on every delete. Admin role re-read from D1 on every request; every `/api/admin/*` route enforces it. |
| Upload abuse | 10 MB cap, format decided by magic bytes (SVG, GIF and HTML are rejected), dimension and pixel limits, server-generated R2 keys (no path traversal), 6/hour and 20/day per user. |
| Spam | Burns: 6/min and 80/hour. 🔥: 60/min. Reports: 30/hour. Links are blocked. |
| Data exposure | API responses contain no internal user ids, hashes, IPs, session data or moderation details for normal users. The R2 object key is never sent to clients. |

## Testing

```bash
npm test          # 42 tests, run inside workerd against real (local) D1 + R2
npm run typecheck
```

`test/api.test.ts` drives the Worker over HTTP like the real client does and covers: signup, duplicate usernames (case-insensitive), username/password validation, login, invalid password, no user enumeration, logout with server-side revocation, per-account and per-IP brute-force limits, CSRF rejection, auth required everywhere, security headers, PNG upload with metadata stripping, JPEG EXIF/GPS stripping, rejection of SVG/GIF/text/truncated files, missing consent, doxxing captions, oversized uploads, upload rate limit, feed contents, unseen-first ordering, round-robin rotation, expired posts hidden before cleanup, no private fields in responses, burns (including stored-as-text HTML), newest/hottest sorting, 🔥 reactions, duplicate reaction prevention, un-reacting, doxxing/threat/slur/link/length filtering, burn rate limit, deleting your own post (and its R2 object), being blocked from deleting others' posts, deleting your own burns, reporting photos and burns, duplicate reports, "this is me" immediate takedown, auto-hide at 3 reports, non-admin and anonymous users blocked from all 10 admin endpoints, admin stats and lists, admin deleting photos (with R2) and burns, the moderation queue (priority, remove, dismiss), suspending (post/burn/react blocked) and unsuspending, admin self/peer protection, deleting a user with all content, safe profiles, and the scheduled cleanup (post, burns, reactions, both kinds of reports, views and R2 image deleted; live content untouched; sessions and rate limits purged; fresh orphans left alone).

`test/unit.test.ts` covers moderation false positives and negatives, text sanitising, WEBP EXIF/XMP stripping, and magic-byte sniffing.

Manually verified in a browser against the dev server and the production build: landing, feed, next/previous buttons, ←/→ keys, touch swipe (left = next, right = previous, vertical scrolls ignored), posting burns, 🔥, the report dialog, upload with preview, consent and compression (a 3000×4000 PNG became a 1536×2048 WEBP), deep links, profiles, the admin overview/reports/users flows, the suspended-user experience, the mobile layout (bottom nav), the real cron handler deleting D1 rows and the R2 object, and the production CSP with no violations.

## Known limitations

- **Content filtering is pattern-based.** It catches common doxxing, threats and slurs, but determined users can phrase around it. Reports, auto-hide and admin review are the backstop. It doesn't analyze image content (no nudity/CSAM detection).
- **No image moderation service.** Uploaded images aren't scanned. See next steps.
- **Rate limiting uses D1 writes.** That's fine at small to medium scale. At high traffic, Cloudflare's Rate Limiting binding or WAF rules are cheaper.
- **Comment updates poll** every 10 seconds (only while the tab is visible) rather than streaming.
- **No account self-deletion or password change yet.** An admin can delete an account.
- **PBKDF2 at 100k iterations** is the WebCrypto maximum on Workers. Argon2id would be stronger but needs WASM.
- **Deleting the last admin** has to be done in D1 directly (by design).

## Recommended next steps

1. **Turnstile** on signup and login to stop scripted account creation.
2. **Image safety scanning:** Cloudflare's CSAM Scanning Tool on a custom domain, plus a nudity classifier (for example Workers AI) before a photo goes live.
3. **Account settings:** change password, delete my account (self-service), sign out of other sessions.
4. **Real-time burns** with a Durable Object per photo (WebSockets), replacing polling.
5. **WAF rate-limiting rules** on `/api/auth/*` and `/api/posts` at the edge.
6. **Moderation audit log:** who removed what, and when.
7. **Block/mute** between users, and an appeals flow for suspensions.
8. **Image variants** (thumbnails) via Cloudflare Images for faster profile grids.
9. **Observability:** Workers Logs dashboards and alerts if a cleanup run fails or leaves a backlog.

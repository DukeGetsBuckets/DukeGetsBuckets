# Implementation status — Tempo

Last updated: 2026-11-20 (Play the bot; snapshot safety fix). Branch: `claude/trusting-volta-ikeo2c`.

## Summary

All ten milestones are implemented and exercised end to end on this machine against real
PostgreSQL 16, Redis 7 and Stockfish 16. The product acceptance scenarios A (random multiplayer),
B (friends), C (Stockfish review) and D (iPad gestures) pass as automated Playwright tests.

**Live demo: https://tempo-chess.launch2.workers.dev** (Cloudflare Worker + one always-on Cloudflare
Container running web, realtime, worker, PostgreSQL, Redis, Stockfish and nginx together). The
Playwright suite was run against that URL (7 passed, 5 skipped by design). This is a **demo-grade**
deployment, not the production topology: see "Known bugs and limitations" and `deploy/cloudflare/README.md`.
The production-grade path (managed Postgres/Redis, separate services) is still documented in
`docs/DEPLOYMENT.md`.

## Completed features

| Area | What exists | Where |
|---|---|---|
| Accounts | Email/password sign-up with unique username, login by username or email, logout, password change, password reset email, email verification (optional enforcement via `REQUIRE_EMAIL_VERIFICATION`), profile editing, privacy visibility, rate-limited auth routes | `apps/web/lib/auth.ts`, `app/(auth)/*`, `app/api/profile` |
| Chessboard | Original React board: tap-to-move, drag-and-drop, legal-move dots, capture rings, last-move/check/selection highlights, animated piece moves and captures, promotion dialog (touch-safe), coordinates, 6 board themes, 5 piece sets, premove highlights, right-click arrows/circles on desktop, annotation mode on touch, engine arrows, classification badges, synthesized sounds, haptics | `apps/web/components/board/*`, `lib/sounds.ts` |
| Rules | chess.js legality; checkmate, stalemate, insufficient material, fivefold/75-move automatic draws; threefold/50-move claims; timeout vs insufficient mating material = draw; first-move abort window | `packages/chess-core/src/rules.ts` |
| Live multiplayer | JWT-authenticated Socket.IO, server-authoritative games with per-game mutex, sequence numbers, idempotent `actionId`, structured rejections, server-side premoves, draw offer/accept/decline/claim, resign, abort, claim victory on abandonment, rematch with colour swap, chat (block-aware), presence, periodic clock sync, lag compensation (≤250 ms), snapshot resync on reconnect, restart recovery with clock checkpoints | `apps/realtime/src/games/*` |
| Clocks | Millisecond clocks, server timeouts, flagged moves rejected, untimed first moves with abort timer, checkpointed to Postgres every 5 s and on shutdown | `apps/realtime/src/games/clock.ts`, `GameManager.ts` |
| Matchmaking | Redis queues per category/rated, adaptive windows (`MATCHMAKING_RANGE_STEPS`), provisional bonus, block avoidance, recent-opponent cooldown, atomic pairing via Lua, lock for multi-instance, honest status pushes, cancel/replace, one game per player | `apps/realtime/src/matchmaking/Matchmaker.ts` |
| Ratings | Glicko-2 per category (verified against Glickman's example), provisional flag, inactivity RD inflation, transactional idempotent settlement, rating history, rated-pair daily cap (visible, not silent) | `packages/chess-core/src/glicko2.ts`, `apps/realtime/src/ratings/settle.ts` |
| Social | Live username search, quick add, requests (accept/decline/cancel), friend list with online/playing presence, challenges (direct, shareable token links, colour/time/rated options, expiry), notifications panel, block/unblock, report, moderation page (`/admin` for MODERATOR/ADMIN roles), fair-play signals (review only, never automatic punishment) | `apps/realtime/src/friends`, `challenges`, `apps/web/components/friends`, `app/(app)/admin` |
| Game screen | Landscape (board left, side panel) and portrait (stacked) layouts, player panels with captured material, clocks, move list with navigation, status line, draw/resign/abort/claim controls, chat, annotation toggle, flip, mute, result modal with real rating change, Game Review / Rematch / New game / Home | `apps/web/components/game/*` |
| History & profiles | Paginated history with category/outcome/rated filters, PGN export (with clock comments), profile stats, rating progression chart, recent games, leaderboards (global/friends/search, 5-game qualification) | `app/(app)/history`, `profile`, `leaderboards` |
| Settings | Board/pieces/legal moves/last move/coordinates/animation/arrow colour, premoves, default promotion, auto-queen, confirm resign, sounds + volume, opponent rating, chat, theme (system/dark/light), reduced motion, friend-request and challenge privacy; persisted per account (localStorage for guests) | `app/(app)/settings`, `app/api/settings` |
| Game Review | BullMQ worker with a bounded Stockfish pool, every position evaluated (MultiPV 2, depth 16 default, Redis-cached), per-move classification (Brilliant/Great/Best/Excellent/Good/Book/Inaccuracy/Mistake/Blunder/Forced), engine-grounded explanations, accuracy + ACPL, eval graph and eval bar, analysis board with variations, coaching report per side, retry-safe jobs, progress over socket + polling | `apps/worker/src/*`, `apps/web/components/review/*`, `docs/ANALYSIS.md` |
| Coaching & training | Deterministic coach (strengths, biggest mistakes, practice items, turning point, opening insight, lesson); optional Claude rewrite with strict move verification; training positions from mistakes with engine-verified attempts, hints, reveal, skip, progress; Improve dashboard (accuracy trend, mistake themes, openings with win rates, rating development, training progress); standalone analysis board with PGN/FEN import and server-side engine lines (blocked during active games) | `apps/worker/src/coaching`, `training`, `app/(app)/improve*`, `app/(app)/analysis` |
| Openings | ECO recognition by position (handles transpositions), book-move detection, per-family performance | `packages/chess-core/src/openings.ts` |
| Play the bot | Unrated games against Stockfish 19 (lite, single-threaded WebAssembly, ≈1.8 MB, runs in the browser, including iPad Safari, with no server round-trips). Strength via Stockfish's `UCI_Elo` limiter (1400–2600, default 2000), ≈1.5 s per move. Shows its thinking live: up to four candidate moves with evaluations and expected lines, drawn as arrows; after each move a thought card with the ideas behind the move (captures, threats, forks, rescuing attacked pieces, development, castling, centre), the candidates it weighed, whether the Elo limiter made it deviate from its top choice, its expected line, and a verdict on the player's previous move on the same scale as Game Review. Eval bar and plain-English standing from the player's side, hint, take back, resign, flip, choice of colour; game resumes after a reload; unavailable while a live game is in progress | `apps/web/components/bot`, `lib/bot`, `lib/engine`, `app/(app)/play/bot` |
| Infra | Prisma 7 schema + migration, Docker Compose, Dockerfiles (web standalone, realtime, worker+Stockfish), GitHub Actions CI (typecheck, lint, unit, integration, e2e, builds), `.env.example`, deployment and event docs, licence attributions | repo root, `docs/`, `.github/workflows/ci.yml` |

## Verification performed (this machine)

| Suite | Command | Result |
|---|---|---|
| Unit (chess rules, endings, timeouts/material, Glicko-2, openings, PGN, accuracy/classification, board geometry, UCI parsing) | `pnpm test:unit` | 49 passed |
| Integration (two-client multiplayer, premoves, duplicates, draw/resign/rating settlement, rematch, reconnect; matchmaking cancel/replace/range expansion/self-match/one game; bullet timeout; realtime restart recovery; Stockfish pipeline, blunder & mate classification, training positions, safe retry, engine refused for active games) | `pnpm test:integration` | 22 passed |
| End-to-end Playwright (desktop, iPad Pro 11 landscape, iPad Pro 11 portrait): Scenario A on all three, Scenarios B and C on desktop, Scenario D on both iPad projects | `pnpm test:e2e` | 7 passed, 5 skipped (project-scoped) |
| Play the bot: unit tests for UCI parsing, candidate ranking, move ideas, verdicts and thought cards; Scenario E e2e on all three projects (reply < 5 s, thinking panel, thought card, reload resume, take back, resign, playing Black) | `pnpm test:unit`, `pnpm test:e2e` | 28 web unit tests pass; Scenario E 4 passed (2026-11-20, local production build); live engine checked in a browser on the deployed URL (loads in ≈2.8 s once, moves in 1.5 s at depth ≈17) |
| Load (30 simulated players, 40 s, random legal moves, 4-core shared box with dev servers running) | `pnpm test:load` | 30 matched, 2034 moves accepted, ack p50 138 ms / p95 589 ms |
| Typecheck / lint | `pnpm typecheck`, `pnpm lint` | clean |
| Production builds | `NODE_ENV=production pnpm build` | Next standalone + tsup bundles build; `dist` bundles boot and serve health |

Manual browser checks (screenshots during the session): registration, matchmaking, live play in landscape and portrait,
result modal, friends/challenges, review page, coach tab, analysis board with engine lines, practice page, improve dashboard.

## Known bugs and limitations

- The live demo keeps PostgreSQL **inside the container's ephemeral disk**. A supervisor uploads gzip'd `pg_dump` snapshots
  (at most once a minute, only when data changed, plus on graceful shutdown) to the Worker's Durable Object storage and
  restores them on boot. A hard crash can lose up to about a minute of data; the snapshot is capped at 24 MB. Restore across a
  redeploy was verified. This is not a substitute for managed Postgres.
- The demo runs one `standard-1` instance (½ vCPU, 4 GiB). It is kept awake by a Worker cron plus an activity-timer override, so it
  bills continuously. Cold starts after a deploy or crash take roughly 10–60 s (visitors see a self-refreshing "waking up" page).
- Container stdout is not exposed by Cloudflare's tooling, so the supervisor ships its own logs to the Worker
  (`/__tempo/logs`, token protected). Outbound email (SMTP) is not configured on the demo, so password-reset and verification
  emails are only logged, and email verification is not enforced. `ANTHROPIC_API_KEY` is not set either, so the coaching tab
  uses the built-in rule-based explanations rather than Claude-written ones (set it with `wrangler secret put ANTHROPIC_API_KEY`).
- Live data was reset after the 2026-11-18 end-to-end run. Since then the demo holds real accounts, so the reset endpoint
  must not be used for test clean-up any more, and the app has no account deletion.
- Incident 2026-11-20: during the v4 rollout the platform stopped PostgreSQL before the supervisor's final snapshot, and a
  race in the dump pipeline uploaded an empty dump as "latest"; the new container restored it and ran without tables for
  ≈16 minutes. The previous snapshot generation was intact and was restored by v5 with no data loss (nothing had changed
  since it was taken). Fixed in v5: the supervisor waits for pg_dump's own exit status and checks for a complete dump
  before uploading, validates snapshots before restoring (falling back to the previous generation), runs PostgreSQL in
  its own session, and the Worker rejects any upload that is not a complete dump of the app schema.
- Deploying a new image takes the site offline while the platform pulls it: ≈7 minutes when the app layers change,
  ≈2 minutes when only the supervisor changes.
- Realtime is single-instance by design (in-memory game state + presence). Multi-instance needs sticky routing and the
  Redis adapter (`REALTIME_REDIS_ADAPTER=true`); matchmaking already locks through Redis.
- Server restarts refund up to one 5-second checkpoint of thinking time; abort timers restart from the restart moment.
- Chat has no profanity filter; moderation is by report + block + ban.
- No PWA service worker (manifest and Apple meta tags only).
- Load-test latency p95 of ~0.6 s was measured on a shared 4-core machine while the dev servers and e2e runs were also
  running; move persistence happens inside the per-game lock before the acknowledgement, which is the main cost.
- AI coaching (Claude) is untested live: no `ANTHROPIC_API_KEY` was available. The deterministic path is tested; the AI
  path validates every mentioned move against engine data and falls back deterministically on any error.
- Better Auth rate limiting uses in-memory storage (per instance). Use its database/secondary storage for multi-instance web.
- Email delivery is console-logged unless SMTP is configured.
- The repository's original profile `README.md` was replaced by the project README (the branch has not been merged).

## Environment requirements

Node 22, pnpm 10, PostgreSQL 16, Redis 7, Stockfish 16 (`apt install stockfish`, or any UCI engine at `STOCKFISH_PATH`).
Secrets: `BETTER_AUTH_SECRET`, `REALTIME_JWT_SECRET` (shared by web and realtime). Optional: SMTP, `ANTHROPIC_API_KEY`.

## Remaining work / next steps

1. Production deployment: move off the all-in-one demo container to separate web / realtime / worker services with managed Postgres and Redis (Vercel/Railway/Fly/Render with the provided Dockerfiles); set env from `.env.example`; run `pnpm db:deploy`. Add an email provider (SMTP) at the same time.
2. Test on a physical iPad in Safari against the live URL (touch, rotation, viewport behaviour); the automated iPad scenario only emulates it.
3. Optional hardening: Redis-backed presence for horizontal scaling; profanity filtering; service worker; email provider; SSO providers via Better Auth.
4. Optional product work: additional time controls (engine already supports increments), tournaments, puzzle packs, spectator lists.

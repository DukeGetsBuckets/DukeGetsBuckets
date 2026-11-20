# Cloudflare Containers deployment (always-on demo)

Live at **https://tempo-chess.launch2.workers.dev** (Worker `tempo-chess`, account subdomain `launch2`).

Everything runs in **one container** managed by a Durable Object, fronted by a small Worker:

```
browser ──https/wss──► Worker ──► Durable Object (TempoContainer) ──► container :8080 (nginx)
                                        │                                 ├─ /socket.io  → realtime :4000
                                        │                                 └─ everything  → Next.js :3000
                                        │                              also inside: PostgreSQL 16, Redis 7,
                                        └─ stores DB snapshots          analysis worker + Stockfish 16
```

| Piece | Where | Notes |
|---|---|---|
| `worker/src/index.ts` | Worker + Durable Object | Proxies HTTP and WebSockets, wakes the container, stores database snapshots and logs |
| `container/supervisor.mjs` | PID 1 in the image | Boots and supervises every process, restores and uploads snapshots, ships logs |
| `container/Dockerfile`, `nginx.conf.template` | image | Ubuntu 24.04 + Postgres + Redis + Stockfish + nginx + Node 22 |
| `build-image.sh` | host | Builds the three apps, assembles the context, `docker build --network host` |

## Always on

- `onActivityExpired` is overridden, so the container never stops for inactivity.
- A cron trigger (`* * * * *`) calls `/__tempo/keepalive`; if the container is not running it is started again.
- Cold start (after a deploy, crash or platform maintenance) takes about 10 to 60 seconds; visitors see a self-refreshing
  "waking up" page meanwhile.
- The instance is `standard-1` (½ vCPU, 4 GiB). **An always-on container is billed for the time it runs**; check
  Cloudflare billing for the current rates and change `instance_type` in `worker/wrangler.jsonc` if needed.

## Persistence (read this)

The container disk is ephemeral. To make accounts, games and ratings survive restarts:

- every 60 s (only if data changed) and on graceful shutdown the supervisor uploads a gzip'd `pg_dump` to the Worker,
  which keeps the **latest and previous** generation in Durable Object storage;
- on boot the supervisor restores the latest snapshot (falling back to the previous one) before starting the apps;
- if a stored snapshot cannot be restored, the container starts empty and **stops uploading** so the stored copy is never overwritten;
- a snapshot is only uploaded, stored (the Worker checks it too) or restored if it is a *complete* dump of the app
  schema (`CREATE TABLE public."User"` plus pg_dump's completion footer). The platform's stop signal can reach
  PostgreSQL before the supervisor's final snapshot; that dump then fails and nothing is uploaded, so the last
  periodic snapshot (at most a minute old) stands.

Limits: a hard crash can lose up to about a minute of data; snapshots are capped at 24 MB; schema changes need a migration
strategy for restored snapshots (the supervisor applies migrations only to a fresh database). This is a demo-grade
persistence layer. For a production database use a managed Postgres (see `docs/DEPLOYMENT.md`).

## Deploy / redeploy

```bash
# 1. Docker daemon running, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID exported
cd deploy/cloudflare
PUBLIC_URL=https://tempo-chess.<subdomain>.workers.dev ./build-image.sh tempo-chess:vN
cd worker && npm install
npx wrangler containers push tempo-chess:vN        # prints registry.cloudflare.com/<account>/tempo-chess:vN
# put that tag into the "image" field of wrangler.jsonc, then:
npx wrangler deploy
```

First deployment only: create the three secrets (any long random values) before the first request:

```bash
npx wrangler secret bulk secrets.json   # {"BETTER_AUTH_SECRET": "...", "REALTIME_JWT_SECRET": "...", "SNAPSHOT_TOKEN": "..."}
```

Optional secret: `ANTHROPIC_API_KEY` enables AI-written coaching text.

A new image means downtime while the platform pulls it (≈7 minutes when the app layers change). For a supervisor-only
change, rebuild from the existing stage so every other layer is reused: `cp container/supervisor.mjs .stage/ && docker build
--network host -t tempo-chess:vN .stage` (≈2 minutes of downtime).

`PUBLIC_URL` must match the Worker's real URL: it is baked into the build (`NEXT_PUBLIC_*`) and passed to the container
as the allowed origin for authentication and sockets.

## Operations

All endpoints below need the header `x-tempo-snapshot-token: <SNAPSHOT_TOKEN>` unless noted.

| Request | Purpose |
|---|---|
| `GET /__tempo/status` (no token) | Container state and last snapshot time |
| `GET /__tempo/logs` | Recent stdout/stderr of every process, per boot (the platform does not expose container logs to the CLI) |
| `POST /__tempo/restart` | Kills the container (no final snapshot) without touching snapshots; the cron restarts it and it restores the latest valid snapshot |
| `POST /__tempo/reset` | **Erases all data**: kills the container and deletes stored snapshots. Never use it once real people have accounts |
| `GET/POST /__tempo/snapshot` | Used by the container itself |

## Known limitations

- Single instance: all live games, matchmaking and the database live in one container; there is no failover.
- Accounts are rate limited per client IP (`AUTH_SIGNUP_RATE_LIMIT`, default 10 sign-ups per minute).
- Email is not configured: verification and password-reset links are only written to the container log.
- Stockfish runs with one thread at depth 14 on half a vCPU, so a full game review takes longer than on a larger machine.

# Deployment

> **Quick demo on Cloudflare:** a single-container, always-on deployment (everything in one image, snapshot-based
> persistence) is described in [`deploy/cloudflare/README.md`](../deploy/cloudflare/README.md). It is a demo topology.
> The rest of this document describes the production topology.

Tempo is four deployable units plus two managed services:

| Unit | Runtime | Notes |
|---|---|---|
| `apps/web` | Next.js 16 (Node 22) | Vercel, Railway, Fly.io, Render or any Node host. Uses `output: "standalone"` |
| `apps/realtime` | Node 22, long-lived | **Must** run where WebSockets stay open (Railway, Fly.io, Render, a VM). Not serverless |
| `apps/worker` | Node 22 + Stockfish | CPU-bound; one container with 2–4 vCPU. Scale by adding instances |
| PostgreSQL 16 | managed | Neon, Supabase, RDS, Railway… |
| Redis 7 | managed | Upstash (non-eviction), Redis Cloud, Railway… BullMQ needs `maxmemory-policy noeviction` |

## 1. Environment

Copy `.env.example` and set at least:

```
DATABASE_URL, REDIS_URL
BETTER_AUTH_SECRET (openssl rand -base64 32), BETTER_AUTH_URL=https://your-web-domain
REALTIME_JWT_SECRET (openssl rand -base64 32)        # same value on web and realtime
NEXT_PUBLIC_WEB_URL=https://your-web-domain
NEXT_PUBLIC_REALTIME_URL=https://your-realtime-domain
ALLOWED_ORIGINS=https://your-web-domain              # realtime CORS + socket origin allow-list
STOCKFISH_PATH=/usr/games/stockfish                  # worker only
SMTP_* / EMAIL_FROM                                  # optional, for verification & reset emails
ANTHROPIC_API_KEY                                    # optional, AI coaching prose
```

The web app sets `Secure`, `HttpOnly`, `SameSite=Lax` cookies in production; serve it over HTTPS.
The realtime service only needs the socket token, so web and realtime can live on different domains.

## 2. Database

```bash
pnpm db:generate
pnpm db:deploy          # prisma migrate deploy
```

Run migrations from CI or a release step before starting the new web/realtime versions. Enable
daily backups on your Postgres provider. Connection limits: each process opens at most
`DATABASE_POOL_MAX` (default 10) connections; size your pooler accordingly (PgBouncer in
transaction mode works with the pg driver adapter).

## 3. Build

```bash
pnpm install --frozen-lockfile
pnpm build              # next build + tsup bundles for realtime and worker
```

Or build the containers from the repository root:

```bash
docker build -f apps/web/Dockerfile -t tempo-web .
docker build -f apps/realtime/Dockerfile -t tempo-realtime .
docker build -f apps/worker/Dockerfile -t tempo-worker .
```

`docker compose --profile app up` runs the whole stack locally.

## 4. Run

| Unit | Command | Health |
|---|---|---|
| web | `node apps/web/server.js` (standalone) or `pnpm --filter @tempo/web start` | `GET /login` |
| realtime | `node apps/realtime/dist/index.js` | `GET /health` |
| worker | `node apps/worker/dist/index.js` | `GET :4100/` |

Logs are JSON (pino) in production; ship them to your log provider. Every service exits non-zero on
fatal errors so the platform restarts it. Active games are restored from Postgres on realtime start
(clocks resume from the restart moment; downtime is not charged to either player).

### Scaling the realtime tier

A single realtime instance comfortably handles thousands of concurrent games. For more than one
instance, set `REALTIME_REDIS_ADAPTER=true` (Socket.IO Redis adapter) and route each game to one
instance with sticky sessions; matchmaking already coordinates through Redis locks.

## 5. Monitoring checklist

- Realtime `/health` (active games, online users, queue sizes) and worker `/` (engine, queue counts).
- BullMQ failed job count (worker log line `analysis job failed`).
- Postgres connections and slow queries; Redis memory.
- Error reporting: wrap `logger` transports with your provider (Sentry, Datadog…) or forward stdout.

## 6. Platform notes

- **Vercel (web only)**: set all env vars; `NEXT_PUBLIC_REALTIME_URL` must point to the realtime
  host. Serverless functions can enqueue analysis jobs because BullMQ only needs Redis.
- **Railway / Fly.io / Render**: deploy realtime and worker as "always on" services with the
  Dockerfiles above; expose 4000 for realtime; the worker needs no public port.

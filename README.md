# Tempo — real-time multiplayer chess with Stockfish game review

Tempo is an original, open-source chess platform built for fast, fair play on iPad and desktop:
rated bullet / blitz / rapid matchmaking, friend challenges, server-authoritative clocks and moves,
premoves, drawing tools, full game history, and a Stockfish-powered Game Review with coaching and
mistake training.

## Stack

- **Web**: Next.js 16 (App Router), React 19, Tailwind 4, Better Auth, Recharts
- **Realtime**: Node 22, Express 5, Socket.IO 4, Redis (matchmaking, presence, event bus)
- **Worker**: BullMQ + Stockfish 16 over UCI, optional Claude coaching prose
- **Data**: PostgreSQL 16 + Prisma 7
- **Shared**: `packages/chess-core` (rules adjudication, Glicko-2, openings, accuracy model),
  `packages/shared` (zod event contracts), `packages/database`

## Quick start (local)

Requirements: Node 22, pnpm 10, PostgreSQL 16, Redis 7, Stockfish (`apt install stockfish`).

```bash
pnpm install
cp .env.example .env              # fill DATABASE_URL, REDIS_URL, secrets
pnpm db:generate && pnpm db:migrate
pnpm dev                          # web :3000, realtime :4000, worker :4100
```

Or start Postgres and Redis with Docker: `docker compose up -d postgres redis`.

Open http://localhost:3000, create two accounts in two browsers, and click **Play → Blitz 5+0** in both.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | all three services with hot reload |
| `pnpm typecheck` / `pnpm lint` | strict TypeScript + ESLint across the monorepo |
| `pnpm test:unit` | chess rules, Glicko-2, openings, accuracy/classification, board geometry, UCI parsing |
| `pnpm test:integration` | real realtime/worker/DB scenarios (services must be running) |
| `pnpm test:e2e` | Playwright flows incl. iPad viewports (services must be running) |
| `pnpm test:load` | simulated players hammering matchmaking and moves |
| `pnpm build` | production builds (Next standalone, tsup bundles) |
| `pnpm exec tsx tools/analyze-game.mts [gameId]` | run a Stockfish review from the CLI |

## Documentation

- `IMPLEMENTATION_STATUS.md` — what is done, verified, and what remains
- `docs/DEPLOYMENT.md` — production deployment
- `docs/EVENTS.md` — realtime event contract
- `docs/ANALYSIS.md` — how accuracy, classifications and coaching are computed
- `LICENSES.md` — third-party attributions (Stockfish is GPL-3.0 and runs as a separate process)

## Renaming

The product name lives in `packages/shared/src/config.ts` (`APP_NAME`) and `NEXT_PUBLIC_APP_NAME`.

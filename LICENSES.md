# Third-party licences and attributions

Tempo's own code is released under the GNU AGPL-3.0-or-later (see `LICENSE`).

## Chess engine

- **Stockfish** (https://stockfishchess.org) — GPL-3.0. Stockfish runs as a separate process
  (`STOCKFISH_PATH`, default the Debian/Ubuntu `stockfish` package) and communicates with the worker
  over the UCI protocol. It is not linked into Tempo. If you distribute a Stockfish binary with
  your deployment (for example inside the worker container image), you must make the corresponding
  source available under the GPL: https://github.com/official-stockfish/Stockfish.
- **Stockfish.js 19.0.1** (https://github.com/nmrugg/stockfish.js) — GPL-3.0 (engine), by Nathan Rugg et al.
  The "Play the bot" mode runs the unmodified `stockfish-19-lite-single` WebAssembly build in the player's
  browser. It is installed from npm (`stockfish@19.0.1`), copied to `apps/web/public/engine/` at build time
  together with its licence (`COPYING.txt`), and served as separate files; the corresponding source is at
  https://github.com/nmrugg/stockfish.js/tree/v19.0.1 and https://github.com/official-stockfish/Stockfish.

## Chess rules

- **chess.js** — BSD-2-Clause.

## Opening data

- **lichess-org/chess-openings** (ECO dataset, `packages/chess-core/data/*.tsv`) — CC0 1.0.

## Piece sets (`apps/web/public/pieces`)

| Set | Author | Licence |
|---|---|---|
| chessnut | Alexis Luengas | Apache-2.0 |
| fantasy, spatial, celtic | Maurizio Monge | MIT |
| kiwen-suwi | neverRare | CC BY 4.0 |

All piece sets were obtained from the lichess repository (`public/piece/`) which documents the
licence of each set in its `COPYING.md`.

## Sounds

Move, capture, check and notification sounds are synthesised at runtime with the Web Audio API;
no third-party audio files are used.

## Fonts

- **Geist / Geist Mono** (Vercel) — SIL Open Font License 1.1.

## Notable dependencies

Next.js (MIT), React (MIT), Tailwind CSS (MIT), Socket.IO (MIT), Prisma (Apache-2.0),
BullMQ (MIT), ioredis (MIT), Better Auth (MIT), Recharts (MIT), lucide-react (ISC), zod (MIT).

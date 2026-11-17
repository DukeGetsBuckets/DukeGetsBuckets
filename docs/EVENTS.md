# Realtime event contract

All events travel over an authenticated Socket.IO connection to `apps/realtime`. The client
presents a short-lived HS256 JWT minted by the web app (`GET /api/realtime/token`) in the socket
`auth.token` field; the user id and username come from the verified token, never from payloads.

Every client → server event takes a payload (validated with zod, see `packages/shared/src/events.ts`)
and an acknowledgement callback receiving `{ ok: true, ...data }` or
`{ ok: false, error: { code, message } }`. Error codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`INVALID_PAYLOAD`, `NOT_YOUR_TURN`, `GAME_NOT_ACTIVE`, `ILLEGAL_MOVE`, `STALE_SEQUENCE`, `DUPLICATE`,
`ALREADY_QUEUED`, `ALREADY_IN_GAME`, `RATE_LIMITED`, `CONFLICT`, `EXPIRED`, `BLOCKED`, `INTERNAL`.

## Client → server

| Event | Payload | Ack data | Notes |
|---|---|---|---|
| `queue:join` | `{ category, rated }` | `{ status: QueueStatus }` | Replaces an existing entry in another queue; refused while in a game |
| `queue:cancel` | – | – | |
| `game:join` | `{ gameId }` | `{ snapshot: GameSnapshot }` | Joins the game room; used on load and after every reconnect |
| `game:leave` | `{ gameId }` | – | |
| `game:move:submit` | `{ gameId, uci, expectedPly, actionId }` | `{ ply, san, fen, clock, duplicate? }` | Server validates turn, sequence, legality and clock; `actionId` makes retries idempotent |
| `game:premove:set` | `{ gameId, uci \| null }` | – | Stored server-side and executed when the opponent moves, if legal |
| `game:resign` / `game:abort` | `{ gameId }` | – | Abort only before both sides have moved |
| `game:draw:offer` / `game:draw:respond` / `game:draw:claim` | `{ gameId }`, `{ gameId, accept }`, `{ gameId, kind }` | – | Claims: `THREEFOLD_REPETITION`, `FIFTY_MOVE_RULE` |
| `game:claim:victory` | `{ gameId }` | – | After the opponent has been disconnected past the grace period |
| `game:rematch:request` / `game:rematch:respond` | `{ gameId }`, `{ gameId, accept }` | `{ gameId? }` | New game with colours swapped |
| `game:chat:send` | `{ gameId, text }` | – | Players only; blocked pairs cannot chat |
| `game:clock:ping` | `{ gameId }` | `{ clock }` | On-demand clock resync |
| `friend:request` | `{ userId? , username? }` | `{ requestId }` | Crossing requests auto-accept |
| `friend:accept` / `friend:decline` / `friend:cancel` | `{ requestId }` | `{ friend }` / – | Only the addressee can accept/decline |
| `friend:remove` | `{ userId }` | – | |
| `friend:list` | – | `{ friends: FriendSummary[] }` | Includes presence |
| `user:search` | `{ query }` | `{ users }` | Prefix search, 10 results, rate limited |
| `user:block` / `user:unblock` / `user:report` | `{ userId }` / `{ userId, reason, details?, gameId? }` | – | |
| `challenge:create` | `{ recipientId?, category, rated, color }` | `{ challenge, note? }` | Omit recipient for a shareable link |
| `challenge:accept` | `{ challengeId? , token? }` | `{ gameId }` | Private challenges only by the addressee; links need the token |
| `challenge:decline` / `challenge:cancel` | `{ challengeId }` | – | |
| `notification:read` | `{ ids?, all? }` | `{ unread }` | |
| `analysis:subscribe` | `{ gameId }` | – | Receive `analysis:progress` for a game |

## Server → client

| Event | Payload |
|---|---|
| `queue:status` | `QueueStatus` (every second while waiting) |
| `queue:left` | `{ reason: canceled \| matched \| disconnected \| replaced }` |
| `match:found` | `{ gameId, color, opponent, category, source }` |
| `game:snapshot` | `GameSnapshot` |
| `game:move:accepted` | `{ gameId, ply, uci, san, fen, by, clock, fromPremove, finished, check, capture, spentMs }` |
| `game:move:rejected` | `{ gameId, actionId, code, message, ply }` |
| `game:clock:sync` | `{ gameId, clock }` (every 5 s while a clock runs) |
| `game:finished` | `{ gameId, result, reason, status, white: {ratingBefore, ratingAfter, delta}, black: {...}, clock }` |
| `game:draw:offered` / `game:draw:declined` | `{ gameId, by }` |
| `game:premove:cleared` | `{ gameId, reason }` |
| `game:rematch:offered` / `game:rematch:declined` | `{ gameId, by }` |
| `game:chat:message` | `{ gameId, id, userId, username, text, at }` |
| `game:presence` | `{ gameId, userId, connected, claimableAt }` |
| `friend:request:received` / `friend:request:resolved` / `friend:accepted` / `friend:removed` / `friend:presence` | see `packages/shared/src/events.ts` |
| `challenge:received` / `challenge:accepted` / `challenge:declined` / `challenge:canceled` / `challenge:expired` | |
| `notification:new` / `notification:count` | |
| `analysis:progress` | `{ gameId, status, progress }` |
| `server:ping` | ack-only round-trip used for lag compensation |

## Clocks

`ClockState = { whiteMs, blackMs, running, active, serverTime }`. Values are the remaining time at
`serverTime`; clients subtract the elapsed time since receipt for the active side. Each side's first
move is untimed (an abort timer applies instead); clocks start once both sides have moved. Lag
compensation subtracts up to 250 ms of server-measured half round-trip from each move.

import { z } from "zod";
import type {
  Ack,
  ChallengeDTO,
  ClockState,
  FriendSummary,
  GameEndReason,
  GameResult,
  GameSnapshot,
  NotificationDTO,
  PlayerColor,
  PresenceStatus,
  QueueStatus,
} from "./types";

// ───────────── Shared field schemas ─────────────
export const ratingCategorySchema = z.enum(["BULLET", "BLITZ", "RAPID"]);
export const uciSchema = z
  .string()
  .regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, "Invalid UCI move");
export const idSchema = z.string().min(1).max(64);
export const usernameQuerySchema = z.string().trim().min(1).max(32);

// ───────────── Client → Server payloads ─────────────
export const queueJoinSchema = z.object({
  category: ratingCategorySchema,
  rated: z.boolean().default(true),
});
export const queueCancelSchema = z.object({}).default({});

export const gameJoinSchema = z.object({ gameId: idSchema });
export const gameMoveSubmitSchema = z.object({
  gameId: idSchema,
  uci: uciSchema,
  /** The ply count the client believes the game is at (must equal the server's). */
  expectedPly: z.number().int().min(0).max(2000),
  /** Client-generated unique id for idempotent retries. */
  actionId: z.string().min(4).max(64),
});
export const gamePremoveSetSchema = z.object({
  gameId: idSchema,
  /** null clears the premove. */
  uci: uciSchema.nullable(),
});
export const gameIdOnlySchema = z.object({ gameId: idSchema });
export const gameDrawRespondSchema = z.object({ gameId: idSchema, accept: z.boolean() });
export const gameDrawClaimSchema = z.object({
  gameId: idSchema,
  kind: z.enum(["THREEFOLD_REPETITION", "FIFTY_MOVE_RULE"]),
});
export const gameRematchRespondSchema = z.object({ gameId: idSchema, accept: z.boolean() });
export const gameChatSendSchema = z.object({
  gameId: idSchema,
  text: z.string().trim().min(1).max(300),
});

export const friendRequestSchema = z.object({
  /** Target by id or username (one required). */
  userId: idSchema.optional(),
  username: usernameQuerySchema.optional(),
});
export const friendRespondSchema = z.object({ requestId: idSchema });
export const friendRemoveSchema = z.object({ userId: idSchema });
export const userSearchSchema = z.object({ query: usernameQuerySchema });

export const challengeCreateSchema = z.object({
  /** Omit for an open (shareable link) challenge. */
  recipientId: idSchema.optional(),
  category: ratingCategorySchema,
  rated: z.boolean().default(true),
  color: z.enum(["RANDOM", "WHITE", "BLACK"]).default("RANDOM"),
});
export const challengeTargetSchema = z.object({
  challengeId: idSchema.optional(),
  token: z.string().min(16).max(128).optional(),
});
export const notificationReadSchema = z.object({
  ids: z.array(idSchema).max(100).optional(),
  all: z.boolean().optional(),
});
export const blockUserSchema = z.object({ userId: idSchema });
export const reportUserSchema = z.object({
  userId: idSchema,
  gameId: idSchema.optional(),
  reason: z.enum(["CHEATING", "HARASSMENT", "INAPPROPRIATE_NAME", "SPAM", "OTHER"]),
  details: z.string().trim().max(1000).optional(),
});

export type QueueJoinPayload = z.infer<typeof queueJoinSchema>;
export type GameMoveSubmitPayload = z.infer<typeof gameMoveSubmitSchema>;
export type ChallengeCreatePayload = z.infer<typeof challengeCreateSchema>;

// ───────────── Server → Client payloads ─────────────
export interface MoveAcceptedPayload {
  gameId: string;
  ply: number;
  uci: string;
  san: string;
  fen: string;
  by: PlayerColor;
  clock: ClockState;
  /** True when this move was executed from a stored premove. */
  fromPremove: boolean;
  /** Set when the move ended the game. */
  finished: boolean;
  check: boolean;
  capture: boolean;
  spentMs: number;
}

export interface GameFinishedPayload {
  gameId: string;
  /** Null for aborted games. */
  result: GameResult | null;
  reason: GameEndReason;
  status: "FINISHED" | "ABORTED";
  white: { ratingBefore: number | null; ratingAfter: number | null; delta: number | null };
  black: { ratingBefore: number | null; ratingAfter: number | null; delta: number | null };
  clock: ClockState;
}

export interface MatchFoundPayload {
  gameId: string;
  color: PlayerColor;
  opponent: { id: string; username: string; rating: number };
  category: "BULLET" | "BLITZ" | "RAPID";
  source: "MATCHMAKING" | "CHALLENGE" | "REMATCH";
}

export interface ServerToClientEvents {
  "queue:status": (status: QueueStatus) => void;
  "queue:left": (payload: { reason: "canceled" | "matched" | "disconnected" | "replaced" }) => void;
  "match:found": (payload: MatchFoundPayload) => void;

  "game:snapshot": (snapshot: GameSnapshot) => void;
  "game:move:accepted": (payload: MoveAcceptedPayload) => void;
  "game:move:rejected": (payload: { gameId: string; actionId: string; code: string; message: string; ply: number }) => void;
  "game:clock:sync": (payload: { gameId: string; clock: ClockState }) => void;
  "game:finished": (payload: GameFinishedPayload) => void;
  "game:draw:offered": (payload: { gameId: string; by: PlayerColor }) => void;
  "game:draw:declined": (payload: { gameId: string; by: PlayerColor }) => void;
  "game:premove:cleared": (payload: { gameId: string; reason: "illegal" | "finished" | "replaced" }) => void;
  "game:rematch:offered": (payload: { gameId: string; by: PlayerColor }) => void;
  "game:rematch:declined": (payload: { gameId: string; by: PlayerColor }) => void;
  "game:chat:message": (payload: { gameId: string; id: string; userId: string; username: string; text: string; at: string }) => void;
  "game:presence": (payload: { gameId: string; userId: string; connected: boolean; claimableAt: number | null }) => void;

  "friend:request:received": (payload: { requestId: string; from: { id: string; username: string; image: string | null } }) => void;
  "friend:request:resolved": (payload: { requestId: string; status: "ACCEPTED" | "DECLINED" | "CANCELED" }) => void;
  "friend:accepted": (payload: { friend: FriendSummary }) => void;
  "friend:removed": (payload: { userId: string }) => void;
  "friend:presence": (payload: { userId: string; status: PresenceStatus; gameId: string | null }) => void;

  "challenge:received": (payload: ChallengeDTO) => void;
  "challenge:accepted": (payload: { challengeId: string; gameId: string }) => void;
  "challenge:declined": (payload: { challengeId: string }) => void;
  "challenge:canceled": (payload: { challengeId: string }) => void;
  "challenge:expired": (payload: { challengeId: string }) => void;

  "notification:new": (payload: NotificationDTO) => void;
  "notification:count": (payload: { unread: number }) => void;
  "analysis:progress": (payload: { gameId: string; status: string; progress: number }) => void;
  "server:error": (payload: { code: string; message: string }) => void;
  /** Server-initiated round-trip measurement; the client acknowledges immediately. */
  "server:ping": (ack: () => void) => void;
}

export interface ClientToServerEvents {
  "queue:join": (payload: QueueJoinPayload, ack: (r: Ack<{ status: QueueStatus }>) => void) => void;
  "queue:cancel": (payload: Record<string, never> | undefined, ack: (r: Ack) => void) => void;

  "game:join": (payload: { gameId: string }, ack: (r: Ack<{ snapshot: GameSnapshot }>) => void) => void;
  "game:leave": (payload: { gameId: string }, ack?: (r: Ack) => void) => void;
  "game:move:submit": (
    payload: GameMoveSubmitPayload,
    ack: (r: Ack<{ ply: number; san: string; fen: string; clock: ClockState; duplicate?: boolean }>) => void,
  ) => void;
  "game:premove:set": (payload: { gameId: string; uci: string | null }, ack: (r: Ack) => void) => void;
  "game:resign": (payload: { gameId: string }, ack: (r: Ack) => void) => void;
  "game:abort": (payload: { gameId: string }, ack: (r: Ack) => void) => void;
  "game:draw:offer": (payload: { gameId: string }, ack: (r: Ack) => void) => void;
  "game:draw:respond": (payload: { gameId: string; accept: boolean }, ack: (r: Ack) => void) => void;
  "game:draw:claim": (payload: { gameId: string; kind: "THREEFOLD_REPETITION" | "FIFTY_MOVE_RULE" }, ack: (r: Ack) => void) => void;
  "game:claim:victory": (payload: { gameId: string }, ack: (r: Ack) => void) => void;
  "game:rematch:request": (payload: { gameId: string }, ack: (r: Ack) => void) => void;
  "game:rematch:respond": (payload: { gameId: string; accept: boolean }, ack: (r: Ack<{ gameId?: string }>) => void) => void;
  "game:chat:send": (payload: { gameId: string; text: string }, ack: (r: Ack) => void) => void;
  "game:clock:ping": (payload: { gameId: string }, ack: (r: Ack<{ clock: ClockState }>) => void) => void;

  "friend:request": (payload: { userId?: string; username?: string }, ack: (r: Ack<{ requestId: string }>) => void) => void;
  "friend:accept": (payload: { requestId: string }, ack: (r: Ack<{ friend: FriendSummary }>) => void) => void;
  "friend:decline": (payload: { requestId: string }, ack: (r: Ack) => void) => void;
  "friend:cancel": (payload: { requestId: string }, ack: (r: Ack) => void) => void;
  "friend:remove": (payload: { userId: string }, ack: (r: Ack) => void) => void;
  "friend:list": (payload: Record<string, never> | undefined, ack: (r: Ack<{ friends: FriendSummary[] }>) => void) => void;
  "user:search": (
    payload: { query: string },
    ack: (r: Ack<{ users: { id: string; username: string; image: string | null; relation: "none" | "friend" | "outgoing" | "incoming" | "blocked" | "self" }[] }>) => void,
  ) => void;

  "challenge:create": (payload: ChallengeCreatePayload, ack: (r: Ack<{ challenge: ChallengeDTO }>) => void) => void;
  "challenge:accept": (payload: { challengeId?: string; token?: string }, ack: (r: Ack<{ gameId: string }>) => void) => void;
  "challenge:decline": (payload: { challengeId: string }, ack: (r: Ack) => void) => void;
  "challenge:cancel": (payload: { challengeId: string }, ack: (r: Ack) => void) => void;

  "notification:read": (payload: { ids?: string[]; all?: boolean }, ack: (r: Ack<{ unread: number }>) => void) => void;
  "user:block": (payload: { userId: string }, ack: (r: Ack) => void) => void;
  "user:unblock": (payload: { userId: string }, ack: (r: Ack) => void) => void;
  "user:report": (payload: z.infer<typeof reportUserSchema>, ack: (r: Ack) => void) => void;
  "analysis:subscribe": (payload: { gameId: string }, ack?: (r: Ack) => void) => void;
}

/** The acknowledgement payload type for a client → server event. */
export type AckOf<E extends keyof ClientToServerEvents> = NonNullable<Parameters<ClientToServerEvents[E]>[1]> extends (r: infer R) => void ? R : never;

export interface SocketAuthPayload {
  token: string;
}

/** Error codes returned in structured rejections. */
export const ErrorCodes = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  GAME_NOT_ACTIVE: "GAME_NOT_ACTIVE",
  ILLEGAL_MOVE: "ILLEGAL_MOVE",
  STALE_SEQUENCE: "STALE_SEQUENCE",
  DUPLICATE: "DUPLICATE",
  ALREADY_QUEUED: "ALREADY_QUEUED",
  ALREADY_IN_GAME: "ALREADY_IN_GAME",
  RATE_LIMITED: "RATE_LIMITED",
  CONFLICT: "CONFLICT",
  EXPIRED: "EXPIRED",
  BLOCKED: "BLOCKED",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

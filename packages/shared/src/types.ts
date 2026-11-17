import type { RatingCategory } from "./config";

export type PlayerColor = "white" | "black";
export type GameStatus = "ACTIVE" | "FINISHED" | "ABORTED";
export type GameResult = "WHITE_WINS" | "BLACK_WINS" | "DRAW";
export type GameEndReason =
  | "CHECKMATE"
  | "RESIGNATION"
  | "TIMEOUT"
  | "TIMEOUT_VS_INSUFFICIENT_MATERIAL"
  | "STALEMATE"
  | "INSUFFICIENT_MATERIAL"
  | "THREEFOLD_REPETITION"
  | "FIVEFOLD_REPETITION"
  | "FIFTY_MOVE_RULE"
  | "SEVENTY_FIVE_MOVE_RULE"
  | "AGREEMENT"
  | "ABANDONED"
  | "ABORTED";

export interface PlayerInfo {
  id: string;
  username: string;
  image: string | null;
  rating: number;
  provisional: boolean;
  /** Rating change applied by this game (finished rated games only). */
  ratingDelta?: number | null;
  ratingAfter?: number | null;
  online?: boolean;
}

export interface MoveRecord {
  ply: number;
  uci: string;
  san: string;
  fenAfter: string;
  whiteTimeMs: number;
  blackTimeMs: number;
  spentMs: number;
}

export interface ClockState {
  whiteMs: number;
  blackMs: number;
  /** Whether a clock is currently ticking. */
  running: boolean;
  /** Which side's clock is ticking (null when not running). */
  active: PlayerColor | null;
  /** Server epoch ms at which whiteMs/blackMs were computed. */
  serverTime: number;
}

export interface GameSnapshot {
  id: string;
  white: PlayerInfo;
  black: PlayerInfo;
  category: RatingCategory;
  initialTimeMs: number;
  incrementMs: number;
  rated: boolean;
  status: GameStatus;
  result: GameResult | null;
  endReason: GameEndReason | null;
  initialFen: string;
  fen: string;
  /** Number of half-moves applied so far; the authoritative sequence number. */
  ply: number;
  moves: MoveRecord[];
  clock: ClockState;
  drawOfferBy: PlayerColor | null;
  rematch: { offeredBy: PlayerColor | null; gameId: string | null };
  /** The requesting user's color, or null for spectators. */
  yourColor: PlayerColor | null;
  /** Pending server-side premove for the requesting user, if any. */
  yourPremove: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Time (ms) left to make the first move before the game is aborted, when applicable. */
  firstMoveDeadline: number | null;
  opponentConnected?: boolean;
  openingName?: string | null;
  openingEco?: string | null;
}

export interface QueueStatus {
  category: RatingCategory;
  rated: boolean;
  joinedAt: number;
  waitingMs: number;
  /** Current absolute rating window being searched. */
  range: number;
  /** Players waiting in this category (including you). */
  waiting: number;
}

export type PresenceStatus = "online" | "offline" | "playing";

export interface FriendSummary {
  id: string;
  username: string;
  image: string | null;
  status: PresenceStatus;
  gameId?: string | null;
  ratings: Record<RatingCategory, number>;
}

export interface NotificationDTO {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ChallengeDTO {
  id: string;
  token: string;
  sender: { id: string; username: string; image: string | null; rating: number };
  recipient: { id: string; username: string } | null;
  category: RatingCategory;
  initialTimeMs: number;
  incrementMs: number;
  rated: boolean;
  senderColor: "RANDOM" | "WHITE" | "BLACK";
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELED" | "EXPIRED";
  gameId: string | null;
  rematchOfGameId: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export type Ack<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: ErrorPayload };

import { Chess } from "chess.js";
import { START_FEN, fromChessColor } from "@tempo/chess-core";
import type { GameEndReason, GameResult, GameSnapshot, GameStatus, MoveRecord, PlayerColor, RatingCategory } from "@tempo/shared";
import { GAME_RULES } from "@tempo/shared";
import { computeClock, msUntilFlag, type RawClock } from "./clock";

export interface LivePlayer {
  id: string;
  username: string;
  image: string | null;
  rating: number;
  deviation: number;
  provisional: boolean;
  connected: boolean;
  disconnectedAt: number | null;
  /** Server-measured half round-trip in ms, used for modest lag compensation. */
  lagMs: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingDelta: number | null;
}

export interface LiveGameInit {
  id: string;
  white: LivePlayer;
  black: LivePlayer;
  category: RatingCategory;
  initialTimeMs: number;
  incrementMs: number;
  rated: boolean;
  source: "MATCHMAKING" | "CHALLENGE" | "REMATCH";
  rematchOfId: string | null;
  initialFen?: string;
  startedAt: Date;
}

export class LiveGame {
  readonly id: string;
  readonly white: LivePlayer;
  readonly black: LivePlayer;
  readonly category: RatingCategory;
  readonly initialTimeMs: number;
  readonly incrementMs: number;
  readonly rated: boolean;
  readonly source: LiveGameInit["source"];
  readonly rematchOfId: string | null;
  readonly initialFen: string;
  readonly startedAt: Date;
  readonly chess: Chess;
  moves: MoveRecord[] = [];
  status: GameStatus = "ACTIVE";
  result: GameResult | null = null;
  endReason: GameEndReason | null = null;
  endedAt: Date | null = null;
  clock: RawClock;
  /** Epoch ms of the last move (or game start) — drives first-move abort deadlines. */
  lastMoveAt: number;
  drawOfferBy: PlayerColor | null = null;
  drawOfferPly: number | null = null;
  premoves: Record<PlayerColor, string | null> = { white: null, black: null };
  rematch: { offeredBy: PlayerColor | null; gameId: string | null; offeredAt: number | null } = {
    offeredBy: null,
    gameId: null,
    offeredAt: null,
  };
  openingName: string | null = null;
  openingEco: string | null = null;
  timeoutTimer: NodeJS.Timeout | null = null;
  abortTimer: NodeJS.Timeout | null = null;
  /** Idempotency cache: actionId → ply produced (bounded). */
  readonly processedActions = new Map<string, { ply: number; san: string; fen: string }>();
  /** Set when a disconnected player's opponent may claim the win. */
  claimableAt: Record<PlayerColor, number | null> = { white: null, black: null };

  constructor(init: LiveGameInit) {
    this.id = init.id;
    this.white = init.white;
    this.black = init.black;
    this.category = init.category;
    this.initialTimeMs = init.initialTimeMs;
    this.incrementMs = init.incrementMs;
    this.rated = init.rated;
    this.source = init.source;
    this.rematchOfId = init.rematchOfId;
    this.initialFen = init.initialFen ?? START_FEN;
    this.startedAt = init.startedAt;
    this.chess = new Chess(this.initialFen);
    this.clock = { whiteMs: init.initialTimeMs, blackMs: init.initialTimeMs, running: false, lastClockAt: null };
    this.lastMoveAt = init.startedAt.getTime();
  }

  get ply(): number {
    return this.moves.length;
  }

  get sideToMove(): PlayerColor {
    return fromChessColor(this.chess.turn());
  }

  get fen(): string {
    return this.chess.fen();
  }

  colorOf(userId: string): PlayerColor | null {
    if (this.white.id === userId) return "white";
    if (this.black.id === userId) return "black";
    return null;
  }

  player(color: PlayerColor): LivePlayer {
    return color === "white" ? this.white : this.black;
  }

  opponentOf(color: PlayerColor): LivePlayer {
    return color === "white" ? this.black : this.white;
  }

  isActive(): boolean {
    return this.status === "ACTIVE";
  }

  /** Each player's first move is untimed; clocks start once both have moved. */
  clocksShouldRun(): boolean {
    return this.ply >= 2;
  }

  firstMoveDeadline(): number | null {
    if (!this.isActive() || this.clocksShouldRun()) return null;
    return this.lastMoveAt + GAME_RULES.firstMoveAbortMs[this.category];
  }

  clockState(now = Date.now()) {
    return computeClock(this.clock, this.sideToMove, now);
  }

  msUntilFlag(now = Date.now()): number {
    return msUntilFlag(this.clock, this.sideToMove, now);
  }

  remainingFor(color: PlayerColor, now = Date.now()): number {
    const c = this.clockState(now);
    return color === "white" ? c.whiteMs : c.blackMs;
  }

  snapshot(forUserId: string | null, now = Date.now()): GameSnapshot {
    const yourColor = forUserId ? this.colorOf(forUserId) : null;
    const toInfo = (p: LivePlayer) => ({
      id: p.id,
      username: p.username,
      image: p.image,
      rating: Math.round(p.ratingBefore ?? p.rating),
      provisional: p.provisional,
      ratingDelta: p.ratingDelta,
      ratingAfter: p.ratingAfter,
      online: p.connected,
    });
    const opponent = yourColor ? this.opponentOf(yourColor) : null;
    return {
      id: this.id,
      white: toInfo(this.white),
      black: toInfo(this.black),
      category: this.category,
      initialTimeMs: this.initialTimeMs,
      incrementMs: this.incrementMs,
      rated: this.rated,
      status: this.status,
      result: this.result,
      endReason: this.endReason,
      initialFen: this.initialFen,
      fen: this.fen,
      ply: this.ply,
      moves: this.moves,
      clock: this.clockState(now),
      drawOfferBy: this.drawOfferBy,
      rematch: { offeredBy: this.rematch.offeredBy, gameId: this.rematch.gameId },
      yourColor,
      yourPremove: yourColor ? this.premoves[yourColor] : null,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.endedAt ? this.endedAt.toISOString() : null,
      firstMoveDeadline: this.firstMoveDeadline(),
      opponentConnected: opponent ? opponent.connected : undefined,
      openingName: this.openingName,
      openingEco: this.openingEco,
    };
  }

  rememberAction(actionId: string, result: { ply: number; san: string; fen: string }): void {
    this.processedActions.set(actionId, result);
    if (this.processedActions.size > 200) {
      const first = this.processedActions.keys().next().value;
      if (first) this.processedActions.delete(first);
    }
  }

  clearTimers(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.timeoutTimer = null;
    this.abortTimer = null;
  }
}

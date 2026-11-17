import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@tempo/database";
import {
  START_FEN,
  adjudicate,
  applyUci,
  buildPgn,
  hasMatingMaterial,
  identifyOpening,
  isProvisional,
  resultString,
  timeoutOutcome,
  toChessColor,
} from "@tempo/chess-core";
import {
  ErrorCodes,
  GAME_RULES,
  RATING_DEFAULTS,
  TIME_CONTROLS,
  otherColor,
  type GameEndReason,
  type GameResult,
  type GameSnapshot,
  type MoveRecord,
  type PlayerColor,
  type RatingCategory,
} from "@tempo/shared";
import { AppError, fail } from "../errors";
import { logger } from "../logger";
import { KeyedMutex } from "../mutex";
import type { Notifier } from "../notifications";
import { getOrCreateRating, settleRatings } from "../ratings/settle";
import type { Emitter } from "./emitter";
import { LiveGame, type LivePlayer } from "./LiveGame";

export interface CreateGameOptions {
  whiteId: string;
  blackId: string;
  category: RatingCategory;
  rated: boolean;
  source: "MATCHMAKING" | "CHALLENGE" | "REMATCH";
  rematchOfId?: string | null;
  initialTimeMs?: number;
  incrementMs?: number;
}

export interface MoveResult {
  ply: number;
  san: string;
  fen: string;
  clock: ReturnType<LiveGame["clockState"]>;
  duplicate?: boolean;
}

const dbColor = (c: PlayerColor) => (c === "white" ? "WHITE" : "BLACK") as "WHITE" | "BLACK";
const fromDbColor = (c: "WHITE" | "BLACK" | null | undefined): PlayerColor | null => (c === "WHITE" ? "white" : c === "BLACK" ? "black" : null);
const MAX_LAG_COMP_MS = 250;
const KEEP_FINISHED_MS = 10 * 60_000;

export class GameManager {
  private readonly games = new Map<string, LiveGame>();
  private readonly activeByUser = new Map<string, string>();
  private readonly mutex = new KeyedMutex();
  /** Hooks for other subsystems (presence) to react to game lifecycle. */
  onGameStarted: ((game: LiveGame) => void) | null = null;
  onGameEnded: ((game: LiveGame) => void) | null = null;
  /** Injected by Presence so new games know who is currently connected. */
  isUserOnline: (userId: string) => boolean = () => false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly emitter: Emitter,
    private readonly notifier: Notifier,
  ) {}

  // ───────────── Queries ─────────────

  getLive(gameId: string): LiveGame | undefined {
    return this.games.get(gameId);
  }

  activeGameOf(userId: string): string | null {
    return this.activeByUser.get(userId) ?? null;
  }

  activeCount(): number {
    let n = 0;
    for (const g of this.games.values()) if (g.isActive()) n++;
    return n;
  }

  /** Snapshot for live games from memory; finished games are rebuilt from the database. */
  async getSnapshot(gameId: string, forUserId: string | null): Promise<GameSnapshot> {
    const live = this.games.get(gameId);
    if (live) return live.snapshot(forUserId);
    const game = await this.loadGameFromDb(gameId);
    if (!game) fail(ErrorCodes.NOT_FOUND, "Game not found");
    if (game.isActive()) {
      // Should not normally happen (active games live in memory), but recover gracefully.
      this.register(game);
      this.scheduleTimers(game);
    }
    return game.snapshot(forUserId);
  }

  // ───────────── Lifecycle ─────────────

  async loadActiveGames(): Promise<number> {
    const rows = await this.prisma.game.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
    let loaded = 0;
    for (const row of rows) {
      const game = await this.loadGameFromDb(row.id);
      if (!game) continue;
      // Downtime is not charged to either player: restart the active clock from now.
      if (game.clock.running) game.clock.lastClockAt = Date.now();
      game.lastMoveAt = Date.now();
      await this.prisma.game.update({
        where: { id: game.id },
        data: { lastClockAt: game.clock.running ? new Date(game.clock.lastClockAt!) : null },
      });
      this.register(game);
      this.scheduleTimers(game);
      loaded++;
    }
    return loaded;
  }

  private register(game: LiveGame): void {
    this.games.set(game.id, game);
    if (game.isActive()) {
      this.activeByUser.set(game.white.id, game.id);
      this.activeByUser.set(game.black.id, game.id);
    }
  }

  private async buildPlayer(userId: string, category: RatingCategory): Promise<LivePlayer> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, image: true } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, "User not found");
    const rating = await getOrCreateRating(this.prisma, userId, category);
    return {
      id: user.id,
      username: user.username ?? "player",
      image: user.image,
      rating: rating.rating,
      deviation: rating.deviation,
      provisional: isProvisional(rating.deviation, RATING_DEFAULTS.provisionalDeviation),
      connected: false,
      disconnectedAt: null,
      lagMs: 0,
      ratingBefore: rating.rating,
      ratingAfter: null,
      ratingDelta: null,
    };
  }

  async createGame(opts: CreateGameOptions): Promise<LiveGame> {
    if (opts.whiteId === opts.blackId) fail(ErrorCodes.CONFLICT, "A player cannot play against themselves");
    for (const uid of [opts.whiteId, opts.blackId]) {
      if (this.activeByUser.has(uid)) fail(ErrorCodes.ALREADY_IN_GAME, "A player is already in a game");
    }
    const tc = TIME_CONTROLS[opts.category];
    const initialTimeMs = opts.initialTimeMs ?? tc.initialMs;
    const incrementMs = opts.incrementMs ?? tc.incrementMs;
    const [white, black] = await Promise.all([this.buildPlayer(opts.whiteId, opts.category), this.buildPlayer(opts.blackId, opts.category)]);
    white.connected = this.isUserOnline(white.id);
    black.connected = this.isUserOnline(black.id);
    const row = await this.prisma.game.create({
      data: {
        whiteId: opts.whiteId,
        blackId: opts.blackId,
        category: opts.category,
        initialTimeMs,
        incrementMs,
        rated: opts.rated,
        source: opts.source,
        rematchOfId: opts.rematchOfId ?? null,
        whiteTimeMs: initialTimeMs,
        blackTimeMs: initialTimeMs,
        whiteRatingBefore: white.rating,
        blackRatingBefore: black.rating,
      },
    });
    const game = new LiveGame({
      id: row.id,
      white,
      black,
      category: opts.category,
      initialTimeMs,
      incrementMs,
      rated: opts.rated,
      source: opts.source,
      rematchOfId: opts.rematchOfId ?? null,
      startedAt: row.startedAt,
    });
    this.register(game);
    this.scheduleTimers(game);
    this.onGameStarted?.(game);
    logger.info({ gameId: game.id, white: white.username, black: black.username, category: opts.category, rated: opts.rated }, "game created");
    return game;
  }

  private async loadGameFromDb(gameId: string): Promise<LiveGame | null> {
    const row = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        moves: { orderBy: { ply: "asc" } },
        white: { select: { id: true, username: true, image: true } },
        black: { select: { id: true, username: true, image: true } },
      },
    });
    if (!row) return null;
    const ratings = await this.prisma.rating.findMany({ where: { userId: { in: [row.whiteId, row.blackId] }, category: row.category } });
    const toPlayer = (u: { id: string; username: string | null; image: string | null }, before: number | null, after: number | null): LivePlayer => {
      const r = ratings.find((x) => x.userId === u.id);
      return {
        id: u.id,
        username: u.username ?? "player",
        image: u.image,
        rating: before ?? r?.rating ?? RATING_DEFAULTS.startRating,
        deviation: r?.deviation ?? RATING_DEFAULTS.startDeviation,
        provisional: isProvisional(r?.deviation ?? RATING_DEFAULTS.startDeviation, RATING_DEFAULTS.provisionalDeviation),
        connected: false,
        disconnectedAt: null,
        lagMs: 0,
        ratingBefore: before,
        ratingAfter: after,
        ratingDelta: before != null && after != null ? after - before : null,
      };
    };
    const game = new LiveGame({
      id: row.id,
      white: toPlayer(row.white, row.whiteRatingBefore, row.whiteRatingAfter),
      black: toPlayer(row.black, row.blackRatingBefore, row.blackRatingAfter),
      category: row.category,
      initialTimeMs: row.initialTimeMs,
      incrementMs: row.incrementMs,
      rated: row.rated,
      source: row.source,
      rematchOfId: row.rematchOfId,
      initialFen: row.initialFen,
      startedAt: row.startedAt,
    });
    for (const m of row.moves) {
      const applied = applyUci(game.chess, m.uci);
      if (!applied) {
        logger.error({ gameId, ply: m.ply, uci: m.uci }, "stored move is illegal; truncating history");
        break;
      }
      game.moves.push({ ply: m.ply, uci: m.uci, san: m.san, fenAfter: m.fenAfter, whiteTimeMs: m.whiteTimeMs, blackTimeMs: m.blackTimeMs, spentMs: m.spentMs });
    }
    game.status = row.status;
    game.result = row.result;
    game.endReason = row.endReason;
    game.endedAt = row.endedAt;
    game.clock = {
      whiteMs: row.whiteTimeMs,
      blackMs: row.blackTimeMs,
      running: row.clockRunning,
      lastClockAt: row.lastClockAt ? row.lastClockAt.getTime() : null,
    };
    game.lastMoveAt = (row.moves.at(-1)?.createdAt ?? row.startedAt).getTime();
    game.drawOfferBy = fromDbColor(row.drawOfferBy);
    game.drawOfferPly = row.drawOfferPly;
    game.openingEco = row.openingEco;
    game.openingName = row.openingName;
    game.white.connected = this.isUserOnline(game.white.id);
    game.black.connected = this.isUserOnline(game.black.id);
    return game;
  }

  // ───────────── Timers ─────────────

  private scheduleTimers(game: LiveGame): void {
    game.clearTimers();
    if (!game.isActive()) return;
    const now = Date.now();
    if (game.clock.running) {
      const ms = Math.max(0, game.msUntilFlag(now));
      game.timeoutTimer = setTimeout(() => void this.handleTimeout(game.id), ms + 5);
    } else {
      const deadline = game.firstMoveDeadline();
      if (deadline != null) {
        game.abortTimer = setTimeout(() => void this.handleAbortTimer(game.id), Math.max(0, deadline - now) + 5);
      }
    }
  }

  private async handleTimeout(gameId: string): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.games.get(gameId);
      if (!game || !game.isActive() || !game.clock.running) return;
      const now = Date.now();
      if (game.msUntilFlag(now) > 0) {
        this.scheduleTimers(game);
        return;
      }
      await this.flag(game, game.sideToMove);
    });
  }

  private async flag(game: LiveGame, flagged: PlayerColor): Promise<void> {
    // Zero the flagged side's clock in the authoritative state before finishing.
    if (flagged === "white") game.clock.whiteMs = 0;
    else game.clock.blackMs = 0;
    game.clock.running = false;
    game.clock.lastClockAt = null;
    const outcome = timeoutOutcome(game.chess, toChessColor(flagged));
    await this.finish(game, outcome.result, outcome.reason);
  }

  private async handleAbortTimer(gameId: string): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.games.get(gameId);
      if (!game || !game.isActive() || game.clocksShouldRun()) return;
      const deadline = game.firstMoveDeadline();
      if (deadline == null) return;
      if (Date.now() < deadline) {
        this.scheduleTimers(game);
        return;
      }
      await this.finish(game, null, "ABORTED");
    });
  }

  // ───────────── Moves ─────────────

  async submitMove(gameId: string, userId: string, uci: string, expectedPly: number, actionId: string): Promise<MoveResult> {
    return this.mutex.run(gameId, async () => {
      const game = this.games.get(gameId);
      if (!game) fail(ErrorCodes.NOT_FOUND, "Game not found or no longer live");
      const color = game.colorOf(userId);
      if (!color) fail(ErrorCodes.FORBIDDEN, "You are not a player in this game");
      const cached = game.processedActions.get(actionId);
      if (cached) return { ...cached, clock: game.clockState(), duplicate: true };
      if (!game.isActive()) fail(ErrorCodes.GAME_NOT_ACTIVE, "The game is over", { status: game.status });
      const now = Date.now();
      // Authoritative flag check before anything else: a move after the flag never counts.
      if (game.clock.running && game.msUntilFlag(now) <= 0) {
        const flagged = game.sideToMove;
        await this.flag(game, flagged);
        fail(ErrorCodes.GAME_NOT_ACTIVE, flagged === color ? "You ran out of time" : "Your opponent ran out of time");
      }
      if (game.sideToMove !== color) fail(ErrorCodes.NOT_YOUR_TURN, "It is not your turn", { ply: game.ply });
      if (expectedPly !== game.ply) fail(ErrorCodes.STALE_SEQUENCE, "Your board is out of date", { ply: game.ply, fen: game.fen });
      const result = await this.applyMove(game, color, uci, now, { fromPremove: false, actionId });
      if (!result) fail(ErrorCodes.ILLEGAL_MOVE, "Illegal move", { ply: game.ply, fen: game.fen });
      return result;
    });
  }

  /**
   * Apply a validated-turn move for `color`. Returns null when the move is illegal.
   * Must be called with the game mutex held.
   */
  private async applyMove(game: LiveGame, color: PlayerColor, uci: string, now: number, opts: { fromPremove: boolean; actionId?: string }): Promise<MoveResult | null> {
    const applied = applyUci(game.chess, uci);
    if (!applied) return null;

    // Clock bookkeeping
    let spentMs = 0;
    const wasRunning = game.clock.running;
    if (wasRunning && game.clock.lastClockAt != null) {
      const lagComp = opts.fromPremove ? 0 : Math.min(MAX_LAG_COMP_MS, game.player(color).lagMs);
      spentMs = Math.max(0, now - game.clock.lastClockAt - lagComp);
      if (color === "white") game.clock.whiteMs = Math.max(0, game.clock.whiteMs - spentMs) + game.incrementMs;
      else game.clock.blackMs = Math.max(0, game.clock.blackMs - spentMs) + game.incrementMs;
      game.clock.lastClockAt = now;
    }
    const record: MoveRecord = {
      ply: game.ply + 1,
      uci: applied.uci,
      san: applied.san,
      fenAfter: applied.fenAfter,
      whiteTimeMs: game.clock.whiteMs,
      blackTimeMs: game.clock.blackMs,
      spentMs,
    };
    game.moves.push(record);
    game.lastMoveAt = now;
    if (!wasRunning && game.clocksShouldRun()) {
      game.clock.running = true;
      game.clock.lastClockAt = now;
    }
    // A draw offer lapses once the offered-to side moves on.
    if (game.drawOfferBy && game.drawOfferBy !== color) {
      game.drawOfferBy = null;
      game.drawOfferPly = null;
    }
    game.premoves[color] = null;
    const moveResult: MoveResult = { ply: game.ply, san: applied.san, fen: applied.fenAfter, clock: game.clockState(now) };
    if (opts.actionId) game.rememberAction(opts.actionId, { ply: moveResult.ply, san: moveResult.san, fen: moveResult.fen });

    const verdict = adjudicate(game.chess);
    this.emitter.toGame(game.id, "game:move:accepted", {
      gameId: game.id,
      ply: record.ply,
      uci: record.uci,
      san: record.san,
      fen: record.fenAfter,
      by: color,
      clock: moveResult.clock,
      fromPremove: opts.fromPremove,
      finished: verdict.over,
      check: applied.check,
      capture: applied.capture,
      spentMs,
    });

    await this.prisma.$transaction([
      this.prisma.move.create({
        data: {
          gameId: game.id,
          ply: record.ply,
          color: dbColor(color),
          uci: record.uci,
          san: record.san,
          fenBefore: applied.fenBefore,
          fenAfter: record.fenAfter,
          spentMs,
          whiteTimeMs: record.whiteTimeMs,
          blackTimeMs: record.blackTimeMs,
        },
      }),
      this.prisma.game.update({
        where: { id: game.id },
        data: {
          currentFen: record.fenAfter,
          ply: record.ply,
          whiteTimeMs: game.clock.whiteMs,
          blackTimeMs: game.clock.blackMs,
          clockRunning: game.clock.running,
          lastClockAt: game.clock.lastClockAt ? new Date(game.clock.lastClockAt) : null,
          drawOfferBy: game.drawOfferBy ? dbColor(game.drawOfferBy) : null,
          drawOfferPly: game.drawOfferPly,
        },
      }),
    ]);

    if (verdict.over) {
      await this.finish(game, verdict.result!, verdict.reason!);
      return moveResult;
    }
    this.scheduleTimers(game);

    // Execute the opponent's stored premove against the new position, if legal.
    const opponent = otherColor(color);
    const premove = game.premoves[opponent];
    if (premove) {
      game.premoves[opponent] = null;
      const executed = await this.applyMove(game, opponent, premove, Date.now(), { fromPremove: true });
      if (!executed) this.emitter.toUser(game.player(opponent).id, "game:premove:cleared", { gameId: game.id, reason: "illegal" });
    }
    return moveResult;
  }

  async setPremove(gameId: string, userId: string, uci: string | null): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.games.get(gameId);
      if (!game) fail(ErrorCodes.NOT_FOUND, "Game not found");
      const color = game.colorOf(userId);
      if (!color) fail(ErrorCodes.FORBIDDEN, "Not a player");
      if (!game.isActive()) fail(ErrorCodes.GAME_NOT_ACTIVE, "The game is over");
      if (uci && game.sideToMove === color) fail(ErrorCodes.CONFLICT, "It is your turn — make a move instead");
      game.premoves[color] = uci;
    });
  }

  // ───────────── Game-ending actions ─────────────

  async resign(gameId: string, userId: string): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.requirePlayerGame(gameId, userId);
      const color = game.colorOf(userId)!;
      if (!game.isActive()) fail(ErrorCodes.GAME_NOT_ACTIVE, "The game is over");
      if (game.ply < 2) {
        await this.finish(game, null, "ABORTED");
        return;
      }
      this.stopClock(game);
      await this.finish(game, color === "white" ? "BLACK_WINS" : "WHITE_WINS", "RESIGNATION");
    });
  }

  async abort(gameId: string, userId: string): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.requirePlayerGame(gameId, userId);
      if (!game.isActive()) fail(ErrorCodes.GAME_NOT_ACTIVE, "The game is over");
      if (game.ply >= 2) fail(ErrorCodes.CONFLICT, "The game can no longer be aborted; resign instead");
      await this.finish(game, null, "ABORTED");
    });
  }

  async offerDraw(gameId: string, userId: string): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.requirePlayerGame(gameId, userId);
      const color = game.colorOf(userId)!;
      if (!game.isActive()) fail(ErrorCodes.GAME_NOT_ACTIVE, "The game is over");
      if (game.drawOfferBy === color) fail(ErrorCodes.CONFLICT, "Draw already offered");
      if (game.drawOfferBy && game.drawOfferBy !== color) {
        // Both sides offered: that is an agreement.
        this.stopClock(game);
        await this.finish(game, "DRAW", "AGREEMENT");
        return;
      }
      game.drawOfferBy = color;
      game.drawOfferPly = game.ply;
      await this.prisma.game.update({ where: { id: game.id }, data: { drawOfferBy: dbColor(color), drawOfferPly: game.ply } });
      this.emitter.toGame(game.id, "game:draw:offered", { gameId: game.id, by: color });
    });
  }

  async respondDraw(gameId: string, userId: string, accept: boolean): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.requirePlayerGame(gameId, userId);
      const color = game.colorOf(userId)!;
      if (!game.isActive()) fail(ErrorCodes.GAME_NOT_ACTIVE, "The game is over");
      if (!game.drawOfferBy || game.drawOfferBy === color) fail(ErrorCodes.CONFLICT, "No draw offer to respond to");
      game.drawOfferBy = null;
      game.drawOfferPly = null;
      if (accept) {
        this.stopClock(game);
        await this.finish(game, "DRAW", "AGREEMENT");
      } else {
        await this.prisma.game.update({ where: { id: game.id }, data: { drawOfferBy: null, drawOfferPly: null } });
        this.emitter.toGame(game.id, "game:draw:declined", { gameId: game.id, by: color });
      }
    });
  }

  async claimDraw(gameId: string, userId: string, kind: "THREEFOLD_REPETITION" | "FIFTY_MOVE_RULE"): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.requirePlayerGame(gameId, userId);
      if (!game.isActive()) fail(ErrorCodes.GAME_NOT_ACTIVE, "The game is over");
      const verdict = adjudicate(game.chess);
      if (!verdict.claimable.includes(kind)) fail(ErrorCodes.CONFLICT, "That draw cannot be claimed in this position");
      this.stopClock(game);
      await this.finish(game, "DRAW", kind);
    });
  }

  /** Claim the win after the opponent has been disconnected for the configured grace period. */
  async claimVictory(gameId: string, userId: string): Promise<void> {
    await this.mutex.run(gameId, async () => {
      const game = this.requirePlayerGame(gameId, userId);
      const color = game.colorOf(userId)!;
      if (!game.isActive()) fail(ErrorCodes.GAME_NOT_ACTIVE, "The game is over");
      const opponent = otherColor(color);
      const claimable = game.claimableAt[opponent];
      if (game.opponentOf(color).connected || claimable == null || Date.now() < claimable) {
        fail(ErrorCodes.CONFLICT, "Your opponent has not been away long enough");
      }
      this.stopClock(game);
      if (!hasMatingMaterial(game.chess, toChessColor(color))) {
        await this.finish(game, "DRAW", "ABANDONED");
      } else {
        await this.finish(game, color === "white" ? "WHITE_WINS" : "BLACK_WINS", "ABANDONED");
      }
    });
  }

  private stopClock(game: LiveGame): void {
    if (game.clock.running && game.clock.lastClockAt != null) {
      const c = game.clockState();
      game.clock.whiteMs = c.whiteMs;
      game.clock.blackMs = c.blackMs;
    }
    game.clock.running = false;
    game.clock.lastClockAt = null;
  }

  private requirePlayerGame(gameId: string, userId: string): LiveGame {
    const game = this.games.get(gameId);
    if (!game) fail(ErrorCodes.NOT_FOUND, "Game not found or no longer live");
    if (!game.colorOf(userId)) fail(ErrorCodes.FORBIDDEN, "You are not a player in this game");
    return game;
  }

  /** Finalize a game exactly once: persist, settle ratings, broadcast. Mutex must be held. */
  private async finish(game: LiveGame, result: GameResult | null, reason: GameEndReason): Promise<void> {
    if (!game.isActive()) return;
    game.clearTimers();
    game.status = reason === "ABORTED" ? "ABORTED" : "FINISHED";
    game.result = result;
    game.endReason = reason;
    game.endedAt = new Date();
    game.premoves = { white: null, black: null };
    game.drawOfferBy = null;
    game.drawOfferPly = null;
    if (game.clock.running) this.stopClock(game);
    this.activeByUser.delete(game.white.id);
    this.activeByUser.delete(game.black.id);

    const ucis = game.moves.map((m) => m.uci);
    const opening = identifyOpening(ucis, game.initialFen);
    game.openingEco = opening?.opening.eco ?? null;
    game.openingName = opening?.opening.name ?? null;
    const pgn = buildPgn({
      event: `${game.rated ? "Rated" : "Casual"} ${TIME_CONTROLS[game.category].name} game`,
      white: game.white.username,
      black: game.black.username,
      result: resultString(result),
      whiteElo: game.white.ratingBefore,
      blackElo: game.black.ratingBefore,
      timeControl: `${Math.round(game.initialTimeMs / 1000)}+${Math.round(game.incrementMs / 1000)}`,
      termination: reason,
      eco: game.openingEco,
      opening: game.openingName,
      initialFen: game.initialFen,
      sans: game.moves.map((m) => m.san),
      clocksMs: game.moves.map((m) => (m.ply % 2 === 1 ? m.whiteTimeMs : m.blackTimeMs)),
      date: game.startedAt,
    });

    await this.prisma.game.update({
      where: { id: game.id },
      data: {
        status: game.status,
        result,
        endReason: reason,
        endedAt: game.endedAt,
        pgn,
        openingEco: game.openingEco,
        openingName: game.openingName,
        currentFen: game.fen,
        ply: game.ply,
        whiteTimeMs: game.clock.whiteMs,
        blackTimeMs: game.clock.blackMs,
        clockRunning: false,
        lastClockAt: null,
        drawOfferBy: null,
        drawOfferPly: null,
      },
    });

    if (game.rated && game.status === "FINISHED" && result) {
      try {
        const settlement = await settleRatings(this.prisma, game.id);
        if (settlement) {
          game.white.ratingBefore = settlement.white.ratingBefore;
          game.white.ratingAfter = settlement.white.ratingAfter;
          game.white.ratingDelta = settlement.white.delta;
          game.black.ratingBefore = settlement.black.ratingBefore;
          game.black.ratingAfter = settlement.black.ratingAfter;
          game.black.ratingDelta = settlement.black.delta;
        }
      } catch (err) {
        logger.error({ err, gameId: game.id }, "rating settlement failed");
      }
    }

    const side = (p: LivePlayer) => ({ ratingBefore: p.ratingBefore, ratingAfter: p.ratingAfter, delta: p.ratingDelta });
    this.emitter.toGame(game.id, "game:finished", {
      gameId: game.id,
      result,
      reason,
      status: game.status,
      white: side(game.white),
      black: side(game.black),
      clock: game.clockState(),
    });
    logger.info({ gameId: game.id, result, reason, plies: game.ply }, "game finished");
    this.onGameEnded?.(game);
    setTimeout(() => {
      const current = this.games.get(game.id);
      if (current && !current.isActive()) this.games.delete(game.id);
    }, KEEP_FINISHED_MS).unref();
  }

  // ───────────── Rematch ─────────────

  async requestRematch(gameId: string, userId: string): Promise<{ gameId?: string }> {
    return this.mutex.run(gameId, async () => {
      const game = this.games.get(gameId) ?? (await this.loadGameFromDb(gameId));
      if (!game) fail(ErrorCodes.NOT_FOUND, "Game not found");
      if (!this.games.has(gameId)) this.games.set(gameId, game);
      const color = game.colorOf(userId);
      if (!color) fail(ErrorCodes.FORBIDDEN, "Not a player");
      if (game.isActive()) fail(ErrorCodes.CONFLICT, "The game is still in progress");
      if (game.rematch.gameId) return { gameId: game.rematch.gameId };
      const expired = game.rematch.offeredAt != null && Date.now() - game.rematch.offeredAt > GAME_RULES.rematchExpiryMs;
      if (game.rematch.offeredBy && game.rematch.offeredBy !== color && !expired) {
        return this.startRematch(game);
      }
      game.rematch = { offeredBy: color, gameId: null, offeredAt: Date.now() };
      this.emitter.toGame(game.id, "game:rematch:offered", { gameId: game.id, by: color });
      await this.notifier.send(game.opponentOf(color).id, "REMATCH", { gameId: game.id, from: game.player(color).username }, game.id);
      return {};
    });
  }

  async respondRematch(gameId: string, userId: string, accept: boolean): Promise<{ gameId?: string }> {
    return this.mutex.run(gameId, async () => {
      const game = this.games.get(gameId);
      if (!game) fail(ErrorCodes.NOT_FOUND, "Game not found or offer expired");
      const color = game.colorOf(userId);
      if (!color) fail(ErrorCodes.FORBIDDEN, "Not a player");
      if (!game.rematch.offeredBy || game.rematch.offeredBy === color) fail(ErrorCodes.CONFLICT, "No rematch offer to respond to");
      if (game.rematch.gameId) return { gameId: game.rematch.gameId };
      if (!accept) {
        game.rematch = { offeredBy: null, gameId: null, offeredAt: null };
        this.emitter.toGame(game.id, "game:rematch:declined", { gameId: game.id, by: color });
        return {};
      }
      if (game.rematch.offeredAt && Date.now() - game.rematch.offeredAt > GAME_RULES.rematchExpiryMs) {
        game.rematch = { offeredBy: null, gameId: null, offeredAt: null };
        fail(ErrorCodes.EXPIRED, "The rematch offer expired");
      }
      return this.startRematch(game);
    });
  }

  private async startRematch(previous: LiveGame): Promise<{ gameId: string }> {
    // Colors alternate.
    const next = await this.createGame({
      whiteId: previous.black.id,
      blackId: previous.white.id,
      category: previous.category,
      rated: previous.rated,
      source: "REMATCH",
      rematchOfId: previous.id,
      initialTimeMs: previous.initialTimeMs,
      incrementMs: previous.incrementMs,
    });
    previous.rematch = { offeredBy: previous.rematch.offeredBy, gameId: next.id, offeredAt: previous.rematch.offeredAt };
    for (const color of ["white", "black"] as PlayerColor[]) {
      const me = next.player(color);
      const opp = next.opponentOf(color);
      this.emitter.toUser(me.id, "match:found", {
        gameId: next.id,
        color,
        opponent: { id: opp.id, username: opp.username, rating: Math.round(opp.rating) },
        category: next.category,
        source: "REMATCH",
      });
    }
    return { gameId: next.id };
  }

  // ───────────── Chat ─────────────

  async chat(gameId: string, userId: string, text: string): Promise<void> {
    const game = this.games.get(gameId);
    if (!game) fail(ErrorCodes.NOT_FOUND, "Game not found");
    const color = game.colorOf(userId);
    if (!color) fail(ErrorCodes.FORBIDDEN, "Only players can chat");
    const opponent = game.opponentOf(color);
    const blocked = await this.prisma.block.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: opponent.id }, { blockerId: opponent.id, blockedId: userId }] },
    });
    if (blocked) fail(ErrorCodes.BLOCKED, "Chat is unavailable with this player");
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, GAME_RULES.maxChatLength);
    if (!clean) fail(ErrorCodes.INVALID_PAYLOAD, "Empty message");
    const msg = await this.prisma.chatMessage.create({ data: { gameId, userId, text: clean } });
    this.emitter.toGame(gameId, "game:chat:message", {
      gameId,
      id: msg.id,
      userId,
      username: game.player(color).username,
      text: clean,
      at: msg.createdAt.toISOString(),
    });
  }

  // ───────────── Presence integration ─────────────

  setLag(userId: string, lagMs: number): void {
    const gameId = this.activeByUser.get(userId);
    if (!gameId) return;
    const game = this.games.get(gameId);
    const color = game?.colorOf(userId);
    if (game && color) game.player(color).lagMs = Math.max(0, Math.min(2000, lagMs));
  }

  userConnected(userId: string): void {
    for (const game of this.games.values()) {
      const color = game.colorOf(userId);
      if (!color) continue;
      const p = game.player(color);
      const wasConnected = p.connected;
      p.connected = true;
      p.disconnectedAt = null;
      game.claimableAt[color] = null;
      if (!wasConnected && game.isActive()) {
        this.emitter.toGame(game.id, "game:presence", { gameId: game.id, userId, connected: true, claimableAt: null });
      }
    }
  }

  userDisconnected(userId: string): void {
    for (const game of this.games.values()) {
      const color = game.colorOf(userId);
      if (!color) continue;
      const p = game.player(color);
      p.connected = false;
      p.disconnectedAt = Date.now();
      if (game.isActive()) {
        const claimableAt = Date.now() + GAME_RULES.disconnectClaimMs[game.category];
        game.claimableAt[color] = claimableAt;
        this.emitter.toGame(game.id, "game:presence", { gameId: game.id, userId, connected: false, claimableAt });
      }
    }
  }

  /** Periodic clock broadcast for all running games. */
  broadcastClocks(): void {
    const now = Date.now();
    for (const game of this.games.values()) {
      if (game.isActive() && game.clock.running) {
        this.emitter.toGame(game.id, "game:clock:sync", { gameId: game.id, clock: game.clockState(now) });
      }
    }
  }

  static newActionId(): string {
    return randomUUID();
  }
}

export { START_FEN };

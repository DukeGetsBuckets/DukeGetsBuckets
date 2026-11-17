import type { Redis } from "ioredis";
import { Chess } from "chess.js";
import type { Prisma, PrismaClient } from "@tempo/database";
import {
  adjudicate,
  averageCentipawnLoss,
  classifyMove,
  gameAccuracy,
  identifyOpening,
  isBookPosition,
  positionKey,
  uciToSan,
  winChance,
  type EngineScore,
} from "@tempo/chess-core";
import type { AnalysisSummary, ClassificationCounts, EngineScoreDTO, MoveAnalysisDTO, PlayerColor } from "@tempo/shared";
import { buildCoaching } from "../coaching/deterministic";
import { enhanceCoachingWithAI } from "../coaching/ai";
import type { EnginePool } from "../engine/pool";
import { logger } from "../logger";
import { createTrainingPositions } from "../training/positions";
import { recordFairPlaySignals } from "./fairplay";
import { explainMove, materialOutcome, pvToSan } from "./explain";

export interface AnalysisConfig {
  depth: number;
  multipv: number;
  movetimeMs: number;
}

export interface AnalysisContext {
  prisma: PrismaClient;
  pool: EnginePool;
  redis: Redis;
  config: AnalysisConfig;
  publish: (event: { type: string; gameId?: string; userId?: string; payload?: Record<string, unknown> }) => void;
}

export interface PositionEval {
  /** White-POV lines, best first. */
  lines: { uci: string; score: EngineScoreDTO; pv: string[] }[];
  depth: number;
  terminal: boolean;
}

const CACHE_TTL = 7 * 24 * 3600;

function toWhitePov(score: { cp: number | null; mate: number | null }, sideToMove: "w" | "b"): EngineScoreDTO {
  if (sideToMove === "w") return { cp: score.cp, mate: score.mate };
  return { cp: score.cp == null ? null : -score.cp, mate: score.mate == null ? null : -score.mate };
}

/** Evaluate a position with caching; terminal positions are scored without the engine. */
export async function evaluatePosition(ctx: AnalysisContext, fen: string, opts?: Partial<AnalysisConfig>): Promise<PositionEval> {
  const config = { ...ctx.config, ...opts };
  const chess = new Chess(fen);
  const verdict = adjudicate(chess);
  if (verdict.over || chess.isGameOver()) {
    if (chess.isCheckmate()) {
      // Side to move is mated: mate 0 from its POV → white POV sign by who delivered it.
      const whiteMated = chess.turn() === "w";
      return { lines: [{ uci: "", score: { cp: null, mate: whiteMated ? -0.5 : 0.5 }, pv: [] }], depth: 0, terminal: true };
    }
    return { lines: [{ uci: "", score: { cp: 0, mate: null }, pv: [] }], depth: 0, terminal: true };
  }
  const key = `eval:v1:${config.depth}:${config.multipv}:${config.movetimeMs}:${positionKey(fen)}`;
  const cached = await ctx.redis.get(key).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as PositionEval;
    } catch {
      /* fallthrough */
    }
  }
  const result = await ctx.pool.analyze(fen, { depth: config.depth, multipv: config.multipv, movetimeMs: config.movetimeMs || undefined });
  const stm = chess.turn();
  const lines = result.lines
    .filter((l) => l.pv.length > 0)
    .map((l) => ({ uci: l.pv[0]!, score: toWhitePov({ cp: l.cp, mate: l.mate }, stm), pv: l.pv }));
  if (!lines.length && result.bestMove) lines.push({ uci: result.bestMove, score: { cp: 0, mate: null }, pv: [result.bestMove] });
  const evaluation: PositionEval = { lines, depth: result.depth, terminal: false };
  await ctx.redis.set(key, JSON.stringify(evaluation), "EX", CACHE_TTL).catch(() => undefined);
  return evaluation;
}

/** Mate "0.5" sentinel (terminal mate) → integer mate distance for storage. */
function normalizeScore(s: EngineScoreDTO): EngineScoreDTO {
  if (s.mate != null && Math.abs(s.mate) === 0.5) return { cp: null, mate: s.mate > 0 ? 1 : -1 };
  return s;
}

function toEngineScore(s: EngineScoreDTO): EngineScore {
  const n = normalizeScore(s);
  return { cp: n.cp, mate: n.mate };
}

function emptyCounts(): ClassificationCounts {
  return { BRILLIANT: 0, GREAT: 0, BEST: 0, EXCELLENT: 0, GOOD: 0, BOOK: 0, INACCURACY: 0, MISTAKE: 0, BLUNDER: 0, FORCED: 0 };
}

export async function analyzeGame(ctx: AnalysisContext, gameId: string, requestedById: string | null, onProgress?: (p: number) => Promise<void>): Promise<void> {
  const started = Date.now();
  const { prisma } = ctx;
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { moves: { orderBy: { ply: "asc" } }, white: { select: { id: true, username: true } }, black: { select: { id: true, username: true } } },
  });
  if (!game) throw new Error(`Game ${gameId} not found`);
  if (game.status === "ACTIVE") throw new Error("Cannot analyze an active game");
  const engineInfo = ctx.pool.info;
  const analysis = await prisma.gameAnalysis.upsert({
    where: { gameId },
    create: { gameId, status: "PROCESSING", startedAt: new Date(), attempts: 1, config: ctx.config as unknown as Prisma.InputJsonObject, engine: engineInfo.name, engineVersion: engineInfo.version, requestedById },
    update: { status: "PROCESSING", startedAt: new Date(), error: null, progress: 0, attempts: { increment: 1 }, config: ctx.config as unknown as Prisma.InputJsonObject, engine: engineInfo.name, engineVersion: engineInfo.version },
  });
  const report = async (progress: number, status = "PROCESSING") => {
    await prisma.gameAnalysis.update({ where: { id: analysis.id }, data: { progress } }).catch(() => undefined);
    ctx.publish({ type: "analysis:progress", gameId, payload: { status, progress } });
    await onProgress?.(progress);
  };

  try {
    // 1) Positions
    const chess = new Chess(game.initialFen);
    const fens: string[] = [chess.fen()];
    const legalCounts: number[] = [chess.moves().length];
    for (const m of game.moves) {
      const applied = chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] as "q" | "r" | "b" | "n" | undefined });
      if (!applied) throw new Error(`Illegal stored move ${m.uci} at ply ${m.ply}`);
      fens.push(chess.fen());
      legalCounts.push(chess.moves().length);
    }
    const n = game.moves.length;
    if (n === 0) throw new Error("No moves to analyze");

    // 2) Engine evaluation of every position
    const evals: PositionEval[] = [];
    for (let i = 0; i < fens.length; i++) {
      evals.push(await evaluatePosition(ctx, fens[i]!));
      if (i % 3 === 0 || i === fens.length - 1) await report(Math.round(((i + 1) / fens.length) * 85));
    }

    // 3) Per-move classification
    const opening = identifyOpening(game.moves.map((m) => m.uci), game.initialFen);
    const moves: MoveAnalysisDTO[] = [];
    const cpLosses: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      const move = game.moves[i]!;
      const before = evals[i]!;
      const after = evals[i + 1]!;
      const mover: "w" | "b" = i % 2 === 0 ? "w" : "b";
      const fenBefore = fens[i]!;
      const fenAfter = fens[i + 1]!;
      const bestLine = before.lines[0] ?? null;
      const bestUci = bestLine?.uci ?? null;
      const bestSan = bestUci ? uciToSan(fenBefore, bestUci) : null;
      const bestAfter = bestLine?.score ?? { cp: 0, mate: null };
      const secondLine = before.lines[1] ?? null;
      const afterScore = after.lines[0]?.score ?? { cp: 0, mate: null };
      const playedIsBest = bestUci === move.uci;
      const isBook = i < 30 && isBookPosition(fenAfter) && (opening ? i + 1 <= opening.ply : false);
      const replyPvUci = after.lines[0]?.pv ?? [];
      const { sacrificed } = materialOutcome(fenBefore, move.uci, replyPvUci);
      const classified = classifyMove({
        before: toEngineScore(i === 0 ? bestAfter : (evals[i]!.lines[0]?.score ?? bestAfter)),
        after: toEngineScore(afterScore),
        bestAfter: toEngineScore(bestAfter),
        secondBestAfter: secondLine ? toEngineScore(secondLine.score) : null,
        mover,
        playedIsBest,
        legalMoveCount: legalCounts[i]!,
        isBook,
        sacrificedMaterial: sacrificed,
      });
      const bestPvSan = bestLine ? pvToSan(fenBefore, bestLine.pv) : [];
      const replyPvSan = pvToSan(fenAfter, replyPvUci);
      const explanation = explainMove({
        ply: i + 1,
        mover,
        fenBefore,
        fenAfter,
        playedUci: move.uci,
        playedSan: move.san,
        bestUci,
        bestSan,
        before: normalizeScore(before.lines[0]?.score ?? bestAfter),
        after: normalizeScore(afterScore),
        bestAfter: normalizeScore(bestAfter),
        secondBestAfter: secondLine ? normalizeScore(secondLine.score) : null,
        bestPvSan,
        bestPvSanToUci: bestLine?.pv ?? [],
        replyPvSan,
        replyPvUci,
        classification: classified.classification,
        winBefore: classified.winBefore,
        winAfter: classified.winAfter,
        winDrop: classified.winDrop,
        cpLoss: classified.cpLoss,
        openingName: opening?.opening.name ?? null,
        spentMs: move.spentMs,
        initialTimeMs: game.initialTimeMs,
        remainingMsAfter: mover === "w" ? move.whiteTimeMs : move.blackTimeMs,
        sacrificedMaterial: sacrificed,
      });
      const cpLoss = playedIsBest ? 0 : classified.cpLoss;
      cpLosses.push(classified.classification === "BOOK" ? 0 : cpLoss);
      moves.push({
        ply: i + 1,
        color: mover === "w" ? "white" : "black",
        fenBefore,
        playedUci: move.uci,
        playedSan: move.san,
        bestUci,
        bestSan,
        evalBefore: normalizeScore(before.lines[0]?.score ?? bestAfter),
        evalAfter: normalizeScore(afterScore),
        pv: bestLine?.pv.slice(0, 10) ?? [],
        pvSan: bestPvSan,
        altLines: before.lines.slice(0, 3).map((l) => ({ uci: l.uci, san: uciToSan(fenBefore, l.uci) ?? l.uci, score: normalizeScore(l.score), pv: l.pv.slice(0, 6) })),
        cpLoss,
        winChanceBefore: classified.winBefore,
        winChanceAfter: classified.winAfter,
        classification: classified.classification,
        explanation: explanation.text,
        isBook,
        depth: before.depth,
        spentMs: move.spentMs,
      });
      (moves[moves.length - 1] as MoveAnalysisDTO & { theme?: string | null }).theme = explanation.theme;
    }

    // 4) Aggregates
    const winChances = evals.map((e) => winChance(toEngineScore(e.lines[0]?.score ?? { cp: 0, mate: null })));
    const acc = gameAccuracy({ winChances });
    const side = (color: PlayerColor) => {
      const own = moves.filter((m) => m.color === color);
      const counts = emptyCounts();
      for (const m of own) counts[m.classification]++;
      const judged = own.filter((m) => m.classification !== "BOOK" && m.classification !== "FORCED");
      const bestLike = judged.filter((m) => ["BEST", "BRILLIANT", "GREAT"].includes(m.classification)).length;
      return {
        accuracy: color === "white" ? acc.white : acc.black,
        acpl: averageCentipawnLoss(cpLosses, color === "white" ? "w" : "b"),
        counts,
        bestMovePct: judged.length ? Math.round((bestLike / judged.length) * 1000) / 10 : null,
        moves: own.length,
      };
    };
    let turningPoint: AnalysisSummary["turningPoint"] = null;
    for (const m of moves) {
      const swing = Math.abs(winChances[m.ply]! - winChances[m.ply - 1]!);
      if (!turningPoint || swing > turningPoint.swing) turningPoint = { ply: m.ply, san: m.playedSan, color: m.color, swing: Math.round(swing * 10) / 10 };
    }
    if (turningPoint && turningPoint.swing < 8) turningPoint = null;
    const summary: AnalysisSummary = {
      white: side("white"),
      black: side("black"),
      turningPoint,
      opening: opening ? { eco: opening.opening.eco, name: opening.opening.name, lastBookPly: opening.ply } : null,
      winChances: winChances.map((w) => Math.round(w * 10) / 10),
      evals: evals.map((e) => normalizeScore(e.lines[0]?.score ?? { cp: 0, mate: null })),
      engine: { name: engineInfo.name, version: engineInfo.version, depth: ctx.config.depth, multipv: ctx.config.multipv },
      durationMs: Date.now() - started,
    };

    // 5) Coaching
    const gameFacts = {
      whiteName: game.white.username ?? "White",
      blackName: game.black.username ?? "Black",
      result: game.result,
      endReason: game.endReason,
      category: game.category,
      initialTimeMs: game.initialTimeMs,
    };
    let coaching = { white: buildCoaching("white", moves, summary, gameFacts), black: buildCoaching("black", moves, summary, gameFacts) };
    let coachingSource = "deterministic";
    await report(90);
    try {
      const enhanced = await enhanceCoachingWithAI(coaching, moves, summary, gameFacts);
      if (enhanced) {
        coaching = enhanced;
        coachingSource = "ai";
      }
    } catch (err) {
      logger.warn({ err, gameId }, "AI coaching unavailable; using deterministic coaching");
    }

    // 6) Persist
    await prisma.$transaction([
      prisma.moveAnalysis.deleteMany({ where: { analysisId: analysis.id } }),
      prisma.moveAnalysis.createMany({
        data: moves.map((m) => ({
          analysisId: analysis.id,
          ply: m.ply,
          color: m.color === "white" ? "WHITE" : "BLACK",
          fenBefore: m.fenBefore,
          playedUci: m.playedUci,
          playedSan: m.playedSan,
          bestUci: m.bestUci,
          bestSan: m.bestSan,
          evalBefore: m.evalBefore.cp,
          mateBefore: m.evalBefore.mate,
          evalAfter: m.evalAfter.cp,
          mateAfter: m.evalAfter.mate,
          pv: m.pv,
          altLines: m.altLines as unknown as Prisma.InputJsonArray,
          cpLoss: m.cpLoss,
          winChanceBefore: m.winChanceBefore,
          winChanceAfter: m.winChanceAfter,
          classification: m.classification,
          explanation: m.explanation,
          isBook: m.isBook,
          depth: m.depth,
        })),
      }),
      prisma.gameAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "COMPLETED",
          progress: 100,
          whiteAccuracy: summary.white.accuracy,
          blackAccuracy: summary.black.accuracy,
          whiteAcpl: summary.white.acpl,
          blackAcpl: summary.black.acpl,
          summary: summary as unknown as Prisma.InputJsonObject,
          coaching: coaching as unknown as Prisma.InputJsonObject,
          coachingSource,
          completedAt: new Date(),
          error: null,
        },
      }),
    ]);

    // 7) Training positions for both players
    await createTrainingPositions(prisma, { gameId, whiteId: game.whiteId, blackId: game.blackId, moves });
    if (game.rated) await recordFairPlaySignals(prisma, { gameId, whiteId: game.whiteId, blackId: game.blackId, moves, summary, category: game.category }).catch((err) => logger.warn({ err }, "fair-play signal failed"));

    ctx.publish({ type: "analysis:progress", gameId, payload: { status: "COMPLETED", progress: 100 } });
    for (const userId of new Set([requestedById, game.whiteId, game.blackId].filter(Boolean) as string[])) {
      ctx.publish({ type: "notification", userId, payload: { type: "ANALYSIS_READY", data: { gameId }, resourceId: gameId } });
    }
    logger.info({ gameId, plies: n, ms: Date.now() - started, white: summary.white.accuracy, black: summary.black.accuracy }, "analysis completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.gameAnalysis.update({ where: { id: analysis.id }, data: { status: "FAILED", error: message.slice(0, 500) } }).catch(() => undefined);
    ctx.publish({ type: "analysis:progress", gameId, payload: { status: "FAILED", progress: 0 } });
    throw err;
  }
}

import type { AnalysisSummary, CoachingReport, EngineScoreDTO, GameAnalysisDTO, MoveAnalysisDTO, TrainingPositionDTO } from "@tempo/shared";
import { Chess } from "chess.js";
import { uciToSan } from "@tempo/chess-core";
import { prisma } from "@/lib/db";

export async function getAnalysisDTO(gameId: string): Promise<GameAnalysisDTO | null> {
  const a = await prisma.gameAnalysis.findUnique({ where: { gameId }, include: { moves: { orderBy: { ply: "asc" } } } });
  if (!a) return null;
  const config = (a.config ?? {}) as { depth?: number; multipv?: number; movetimeMs?: number };
  return {
    gameId,
    status: a.status,
    progress: a.progress,
    error: a.error,
    engine: a.engine,
    engineVersion: a.engineVersion,
    config: { depth: config.depth ?? 0, multipv: config.multipv ?? 1, movetimeMs: config.movetimeMs ?? 0 },
    whiteAccuracy: a.whiteAccuracy,
    blackAccuracy: a.blackAccuracy,
    whiteAcpl: a.whiteAcpl,
    blackAcpl: a.blackAcpl,
    summary: (a.summary as unknown as AnalysisSummary | null) ?? null,
    coaching: (a.coaching as unknown as { white: CoachingReport; black: CoachingReport } | null) ?? null,
    moves: a.status === "COMPLETED" ? a.moves.map(toMoveDTO) : [],
    createdAt: a.createdAt.toISOString(),
    completedAt: a.completedAt?.toISOString() ?? null,
  };
}

function toMoveDTO(m: {
  ply: number;
  color: "WHITE" | "BLACK";
  fenBefore: string;
  playedUci: string;
  playedSan: string;
  bestUci: string | null;
  bestSan: string | null;
  evalBefore: number | null;
  mateBefore: number | null;
  evalAfter: number | null;
  mateAfter: number | null;
  pv: unknown;
  altLines: unknown;
  cpLoss: number | null;
  winChanceBefore: number;
  winChanceAfter: number;
  classification: MoveAnalysisDTO["classification"];
  explanation: string | null;
  isBook: boolean;
  depth: number | null;
}): MoveAnalysisDTO {
  const pv = Array.isArray(m.pv) ? (m.pv as string[]) : [];
  const alt = Array.isArray(m.altLines) ? (m.altLines as MoveAnalysisDTO["altLines"]) : [];
  return {
    ply: m.ply,
    color: m.color === "WHITE" ? "white" : "black",
    fenBefore: m.fenBefore,
    playedUci: m.playedUci,
    playedSan: m.playedSan,
    bestUci: m.bestUci,
    bestSan: m.bestSan,
    evalBefore: { cp: m.evalBefore, mate: m.mateBefore },
    evalAfter: { cp: m.evalAfter, mate: m.mateAfter },
    pv,
    pvSan: pvToSan(m.fenBefore, pv),
    altLines: alt,
    cpLoss: m.cpLoss,
    winChanceBefore: m.winChanceBefore,
    winChanceAfter: m.winChanceAfter,
    classification: m.classification,
    explanation: m.explanation,
    isBook: m.isBook,
    depth: m.depth,
  };
}

function pvToSan(fen: string, pv: string[]): string[] {
  const out: string[] = [];
  const c = new Chess(fen);
  for (const uci of pv.slice(0, 8)) {
    const san = uciToSan(c.fen(), uci);
    if (!san) break;
    out.push(san);
    c.move(san);
  }
  return out;
}

export async function listTrainingPositions(userId: string, opts: { status?: "NEW" | "SOLVED" | "FAILED" | "REVIEW" | "SKIPPED"; take?: number } = {}): Promise<TrainingPositionDTO[]> {
  const rows = await prisma.trainingPosition.findMany({
    where: { userId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ status: "asc" }, { cpLoss: "desc" }, { createdAt: "desc" }],
    take: opts.take ?? 100,
    include: { game: { select: { whiteId: true, white: { select: { username: true } }, black: { select: { username: true } }, analysis: { select: { moves: { where: {}, select: { ply: true, evalBefore: true, mateBefore: true } } } } } } },
  });
  return rows.map((r) => {
    const evalRow = r.game.analysis?.moves.find((m) => m.ply === r.ply);
    const evalBefore: EngineScoreDTO = { cp: evalRow?.evalBefore ?? null, mate: evalRow?.mateBefore ?? null };
    return {
      id: r.id,
      gameId: r.gameId,
      ply: r.ply,
      fen: r.fen,
      sideToMove: r.sideToMove === "WHITE" ? "white" : "black",
      playedUci: r.playedUci,
      playedSan: uciToSan(r.fen, r.playedUci) ?? r.playedUci,
      bestUci: r.bestUci,
      bestSan: uciToSan(r.fen, r.bestUci) ?? r.bestUci,
      acceptableMoves: (r.acceptableMoves as unknown as TrainingPositionDTO["acceptableMoves"]) ?? [],
      cpLoss: r.cpLoss,
      classification: r.classification,
      theme: r.theme,
      explanation: r.explanation,
      status: r.status,
      attempts: r.attempts,
      hintsUsed: r.hintsUsed,
      solvedAt: r.solvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      opponent: (r.game.whiteId === userId ? r.game.black.username : r.game.white.username) ?? "opponent",
      evalBefore,
    };
  });
}

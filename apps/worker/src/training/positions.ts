import type { Prisma, PrismaClient } from "@tempo/database";
import { scoreToCp } from "@tempo/chess-core";
import type { MoveAnalysisDTO } from "@tempo/shared";

type MoveWithTheme = MoveAnalysisDTO & { theme?: string | null };

/** Max trainable positions saved per player per game. */
const MAX_PER_PLAYER = 5;
/** The played move must lose at least this many centipawns versus the best move to be worth training. */
const MIN_GAP_CP = 100;
/** Alternatives within this margin of the best move are also accepted as solutions. */
const ACCEPT_MARGIN_CP = 25;

export async function createTrainingPositions(prisma: PrismaClient, input: { gameId: string; whiteId: string; blackId: string; moves: MoveWithTheme[] }): Promise<number> {
  let created = 0;
  for (const color of ["white", "black"] as const) {
    const userId = color === "white" ? input.whiteId : input.blackId;
    const sign = color === "white" ? 1 : -1;
    const candidates = input.moves
      .filter((m) => m.color === color && (m.classification === "MISTAKE" || m.classification === "BLUNDER") && m.bestUci && m.altLines.length)
      // The played move must be clearly worse than the best move; several good alternatives are fine
      // because the attempt API accepts any move the engine rates within a small margin of the best.
      .filter((m) => (m.cpLoss ?? 0) >= MIN_GAP_CP || m.altLines[0]!.score.mate != null)
      .sort((a, b) => b.winChanceBefore - b.winChanceAfter - (a.winChanceBefore - a.winChanceAfter))
      .slice(0, MAX_PER_PLAYER);
    for (const m of candidates) {
      const best = m.altLines[0]!;
      const bestCp = scoreToCp({ cp: best.score.cp, mate: best.score.mate }) * sign;
      const acceptable = m.altLines
        .filter((a) => bestCp - scoreToCp({ cp: a.score.cp, mate: a.score.mate }) * sign <= ACCEPT_MARGIN_CP)
        .map((a) => ({ uci: a.uci, san: a.san, score: a.score }));
      await prisma.trainingPosition.upsert({
        where: { userId_gameId_ply: { userId, gameId: input.gameId, ply: m.ply } },
        create: {
          userId,
          gameId: input.gameId,
          ply: m.ply,
          fen: m.fenBefore,
          sideToMove: color === "white" ? "WHITE" : "BLACK",
          playedUci: m.playedUci,
          bestUci: m.bestUci!,
          acceptableMoves: acceptable as unknown as Prisma.InputJsonArray,
          cpLoss: m.cpLoss ?? 0,
          classification: m.classification,
          theme: m.theme ?? null,
          explanation: m.explanation,
        },
        update: {
          fen: m.fenBefore,
          bestUci: m.bestUci!,
          acceptableMoves: acceptable as unknown as Prisma.InputJsonArray,
          cpLoss: m.cpLoss ?? 0,
          classification: m.classification,
          theme: m.theme ?? null,
          explanation: m.explanation,
        },
      });
      created++;
    }
  }
  return created;
}

import type { Prisma, PrismaClient } from "@tempo/database";
import type { AnalysisSummary, MoveAnalysisDTO } from "@tempo/shared";

/**
 * Records statistical fair-play signals for later human review. Nothing here punishes anyone:
 * strong play is not evidence of cheating by itself, so signals only become visible in the
 * moderation queue, alongside move timing information.
 */
export async function recordFairPlaySignals(prisma: PrismaClient, input: { gameId: string; whiteId: string; blackId: string; moves: MoveAnalysisDTO[]; summary: AnalysisSummary; category: string }): Promise<void> {
  for (const color of ["white", "black"] as const) {
    const side = input.summary[color];
    const userId = color === "white" ? input.whiteId : input.blackId;
    const own = input.moves.filter((m) => m.color === color);
    const judged = own.filter((m) => m.classification !== "BOOK" && m.classification !== "FORCED");
    if (judged.length < 20 || side.accuracy == null || side.acpl == null) continue;
    const engineAgreement = (side.bestMovePct ?? 0) / 100;
    const times = own.map((m) => m.spentMs ?? 0).filter((t) => t > 0);
    const mean = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const variance = times.length ? times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length : 0;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0; // coefficient of variation of move times
    // Score combines accuracy, ACPL and engine agreement; low timing variability adds a little weight.
    const score = Math.max(0, (side.accuracy - 85) / 15) * 0.5 + Math.max(0, (15 - side.acpl) / 15) * 0.3 + engineAgreement * 0.2 + (cv > 0 && cv < 0.35 ? 0.1 : 0);
    if (score >= 0.85) {
      await prisma.fairPlayFlag.create({
        data: {
          gameId: input.gameId,
          userId,
          kind: "HIGH_ENGINE_AGREEMENT",
          score,
          details: { accuracy: side.accuracy, acpl: side.acpl, bestMovePct: side.bestMovePct, judgedMoves: judged.length, moveTimeCv: Math.round(cv * 100) / 100, category: input.category } as Prisma.InputJsonObject,
        },
      });
    }
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { Chess } from "chess.js";
import { applyUci, scoreToCp, uciToSan } from "@tempo/chess-core";
import type { EngineScoreDTO } from "@tempo/shared";
import { prisma } from "@/lib/db";
import { positionEvents, positionQueue } from "@/lib/queue";
import { getSession } from "@/lib/session";

const schema = z.object({ uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/).optional(), action: z.enum(["attempt", "hint", "reveal", "skip", "reset"]).default("attempt") });

/** Validate a training attempt against the stored engine-backed solutions. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID" }, { status: 400 });
  const position = await prisma.trainingPosition.findUnique({ where: { id } });
  if (!position || position.userId !== session.id) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const acceptable = (position.acceptableMoves as { uci: string; san: string }[]) ?? [];
  const solutions = [position.bestUci, ...acceptable.map((a) => a.uci)];

  if (parsed.data.action === "hint") {
    await prisma.trainingPosition.update({ where: { id }, data: { hintsUsed: { increment: 1 } } });
    const piece = position.bestUci.slice(0, 2);
    return NextResponse.json({ hint: `Look at the piece on ${piece}.`, square: piece });
  }
  if (parsed.data.action === "reveal") {
    await prisma.trainingPosition.update({ where: { id }, data: { status: position.status === "SOLVED" ? "SOLVED" : "FAILED", lastAttemptAt: new Date(), attempts: { increment: 1 } } });
    return NextResponse.json({ solution: { uci: position.bestUci, san: uciToSan(position.fen, position.bestUci) }, acceptable, explanation: position.explanation });
  }
  if (parsed.data.action === "skip") {
    await prisma.trainingPosition.update({ where: { id }, data: { status: "SKIPPED" } });
    return NextResponse.json({ ok: true });
  }
  if (parsed.data.action === "reset") {
    await prisma.trainingPosition.update({ where: { id }, data: { status: "REVIEW" } });
    return NextResponse.json({ ok: true });
  }
  if (!parsed.data.uci) return NextResponse.json({ error: "INVALID" }, { status: 400 });
  const uci = parsed.data.uci;
  const chess = new Chess(position.fen);
  if (!applyUci(chess, uci)) return NextResponse.json({ error: "ILLEGAL_MOVE" }, { status: 400 });
  let correct = solutions.includes(uci) || solutions.includes(uci.slice(0, 4)) || (uci.length === 4 && solutions.some((s) => s.startsWith(uci)));
  const isBest = uci === position.bestUci;
  // An unknown move may still be fine: ask the engine and accept it when it is within a small margin of the best move.
  if (!correct && uci !== position.playedUci) {
    try {
      const best = (acceptable[0] as { score?: EngineScoreDTO } | undefined)?.score;
      const job = await positionQueue().add("position", { type: "position", fen: chess.fen(), depth: 14, multipv: 1 }, { removeOnComplete: true, removeOnFail: true });
      const result = (await job.waitUntilFinished(positionEvents(), 25_000)) as { lines: { score: EngineScoreDTO }[] };
      const after = result.lines[0]?.score;
      if (best && after) {
        const sign = position.sideToMove === "WHITE" ? 1 : -1;
        const bestCp = scoreToCp({ cp: best.cp, mate: best.mate }) * sign;
        const afterCp = scoreToCp({ cp: after.cp, mate: after.mate }) * sign;
        const allowsMate = after.mate != null && after.mate * sign < 0;
        correct = !allowsMate && bestCp - afterCp <= 30;
      }
    } catch {
      /* engine unavailable: fall back to the stored solution set */
    }
  }
  await prisma.$transaction([
    prisma.trainingAttempt.create({ data: { positionId: id, uci, correct } }),
    prisma.trainingPosition.update({
      where: { id },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        ...(correct ? { status: "SOLVED", solvedAt: new Date() } : position.attempts + 1 >= 3 ? { status: "FAILED" } : {}),
      },
    }),
  ]);
  return NextResponse.json({
    correct,
    isBest,
    playedSan: uciToSan(position.fen, uci),
    bestSan: uciToSan(position.fen, position.bestUci),
    attemptsLeft: correct ? 0 : Math.max(0, 3 - (position.attempts + 1)),
    explanation: correct ? (isBest ? position.explanation : `${uciToSan(position.fen, uci)} is also strong here — the engine rates it within a quarter pawn of ${uciToSan(position.fen, position.bestUci)}.`) : null,
  });
}

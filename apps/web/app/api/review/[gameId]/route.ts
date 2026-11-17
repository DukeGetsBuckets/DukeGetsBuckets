import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { analysisQueue } from "@/lib/queue";
import { getAnalysisDTO } from "@/lib/queries/analysis";

export const dynamic = "force-dynamic";

/** Current analysis state (and full data when completed). */
export async function GET(_req: Request, { params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const dto = await getAnalysisDTO(gameId);
  if (!dto) return NextResponse.json({ gameId, status: "NONE" });
  return NextResponse.json(dto, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Request (or retry) a Stockfish review. Only finished games can be analysed — engine output is
 * never produced for a game that is still in progress.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ gameId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { gameId } = await params;
  const game = await prisma.game.findUnique({ where: { id: gameId }, select: { id: true, status: true, ply: true, analysis: { select: { status: true, updatedAt: true } } } });
  if (!game) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (game.status === "ACTIVE") return NextResponse.json({ error: "GAME_ACTIVE", message: "Engine analysis is only available after the game ends." }, { status: 409 });
  if (game.ply === 0) return NextResponse.json({ error: "NO_MOVES", message: "This game has no moves to analyse." }, { status: 400 });
  const existing = game.analysis;
  if (existing?.status === "COMPLETED") return NextResponse.json({ status: "COMPLETED" });
  const stale = existing?.status === "PROCESSING" && Date.now() - existing.updatedAt.getTime() > 10 * 60_000;
  if ((existing?.status === "QUEUED" || existing?.status === "PROCESSING") && !stale) return NextResponse.json({ status: existing.status });

  await prisma.gameAnalysis.upsert({
    where: { gameId },
    create: { gameId, status: "QUEUED", config: {}, requestedById: session.id },
    update: { status: "QUEUED", progress: 0, error: null, requestedById: session.id },
  });
  const queue = analysisQueue();
  const job = await queue.getJob(gameId);
  if (job) {
    const state = await job.getState();
    if (state === "completed" || state === "failed") await job.remove();
    else return NextResponse.json({ status: "QUEUED" });
  }
  await queue.add("game", { type: "game", gameId, requestedById: session.id }, { jobId: gameId, attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 } });
  return NextResponse.json({ status: "QUEUED" });
}

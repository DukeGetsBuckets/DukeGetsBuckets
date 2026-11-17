import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getAnalysisDTO } from "@/lib/queries/analysis";
import { ReviewScreen } from "@/components/review/ReviewScreen";

export const metadata: Metadata = { title: "Game Review" };

export default async function ReviewPage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const [session, game] = await Promise.all([
    getSession(),
    prisma.game.findUnique({
      where: { id: gameId },
      include: { moves: { orderBy: { ply: "asc" }, select: { ply: true, uci: true, san: true, fenAfter: true } }, white: { select: { id: true, username: true } }, black: { select: { id: true, username: true } } },
    }),
  ]);
  if (!game) notFound();
  // Engine review is never available for a game in progress.
  if (game.status === "ACTIVE") redirect(`/game/${gameId}`);
  const analysis = await getAnalysisDTO(gameId);
  return (
    <ReviewScreen
      game={{
        id: game.id,
        white: { id: game.white.id, username: game.white.username ?? "white" },
        black: { id: game.black.id, username: game.black.username ?? "black" },
        category: game.category,
        rated: game.rated,
        status: game.status,
        result: game.result,
        endReason: game.endReason,
        initialFen: game.initialFen,
        moves: game.moves,
        openingName: game.openingName,
        openingEco: game.openingEco,
        startedAt: game.startedAt.toISOString(),
      }}
      initialAnalysis={analysis}
      viewerId={session?.id ?? null}
      canRequest={Boolean(session)}
    />
  );
}

import { NextResponse } from "next/server";
import { buildPgn, resultString } from "@tempo/chess-core";
import { prisma } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const game = await prisma.game.findUnique({
    where: { id },
    include: { moves: { orderBy: { ply: "asc" }, select: { san: true, ply: true, whiteTimeMs: true, blackTimeMs: true } }, white: { select: { username: true } }, black: { select: { username: true } } },
  });
  if (!game) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const pgn =
    game.pgn ??
    buildPgn({
      white: game.white.username ?? "white",
      black: game.black.username ?? "black",
      result: resultString(game.result),
      whiteElo: game.whiteRatingBefore,
      blackElo: game.blackRatingBefore,
      timeControl: `${Math.round(game.initialTimeMs / 1000)}+${Math.round(game.incrementMs / 1000)}`,
      sans: game.moves.map((m) => m.san),
      clocksMs: game.moves.map((m) => (m.ply % 2 === 1 ? m.whiteTimeMs : m.blackTimeMs)),
      date: game.startedAt,
      initialFen: game.initialFen,
      eco: game.openingEco,
      opening: game.openingName,
    });
  return new NextResponse(pgn, {
    headers: { "content-type": "application/x-chess-pgn; charset=utf-8", "content-disposition": `attachment; filename="tempo-${game.white.username}-vs-${game.black.username}-${id.slice(-6)}.pgn"` },
  });
}

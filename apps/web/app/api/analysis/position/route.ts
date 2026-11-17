import { NextResponse } from "next/server";
import { Chess } from "chess.js";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { positionEvents, positionQueue } from "@/lib/queue";

const schema = z.object({ fen: z.string().min(10).max(100), depth: z.number().int().min(6).max(20).default(14), multipv: z.number().int().min(1).max(3).default(2) });
const recent = new Map<string, number[]>();

/**
 * Engine evaluation for the standalone analysis board. Refused while the requester has a game in
 * progress so the engine can never assist a live game.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID" }, { status: 400 });
  try {
    new Chess(parsed.data.fen);
  } catch {
    return NextResponse.json({ error: "INVALID_FEN" }, { status: 400 });
  }
  const active = await prisma.game.findFirst({ where: { status: "ACTIVE", OR: [{ whiteId: session.id }, { blackId: session.id }] }, select: { id: true } });
  if (active) return NextResponse.json({ error: "GAME_ACTIVE", message: "Engine analysis is disabled while you have a game in progress." }, { status: 409 });
  const now = Date.now();
  const hits = (recent.get(session.id) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= 30) return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  hits.push(now);
  recent.set(session.id, hits);
  try {
    const job = await positionQueue().add("position", { type: "position", fen: parsed.data.fen, depth: parsed.data.depth, multipv: parsed.data.multipv }, { removeOnComplete: true, removeOnFail: true });
    const result = await job.waitUntilFinished(positionEvents(), 30_000);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: "ENGINE_UNAVAILABLE", message: err instanceof Error ? err.message : "Engine unavailable" }, { status: 503 });
  }
}

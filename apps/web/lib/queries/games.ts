import type { Prisma } from "@tempo/database";
import { prisma } from "@/lib/db";

export const gameListSelect = {
  id: true,
  whiteId: true,
  blackId: true,
  category: true,
  rated: true,
  status: true,
  result: true,
  endReason: true,
  ply: true,
  startedAt: true,
  endedAt: true,
  whiteRatingBefore: true,
  whiteRatingAfter: true,
  blackRatingBefore: true,
  blackRatingAfter: true,
  openingName: true,
  openingEco: true,
  white: { select: { id: true, username: true, image: true } },
  black: { select: { id: true, username: true, image: true } },
  analysis: { select: { status: true, whiteAccuracy: true, blackAccuracy: true } },
} satisfies Prisma.GameSelect;

export type GameListItem = Prisma.GameGetPayload<{ select: typeof gameListSelect }>;

export interface GameFilters {
  category?: "BULLET" | "BLITZ" | "RAPID";
  outcome?: "win" | "loss" | "draw";
  rated?: boolean;
}

export async function listGamesForUser(userId: string, filters: GameFilters = {}, cursor?: string, take = 20): Promise<{ items: GameListItem[]; nextCursor: string | null }> {
  const where: Prisma.GameWhereInput = {
    status: { in: ["FINISHED", "ABORTED"] },
    OR: [{ whiteId: userId }, { blackId: userId }],
  };
  if (filters.category) where.category = filters.category;
  if (filters.rated != null) where.rated = filters.rated;
  if (filters.outcome === "draw") where.result = "DRAW";
  if (filters.outcome === "win") where.OR = [{ whiteId: userId, result: "WHITE_WINS" }, { blackId: userId, result: "BLACK_WINS" }];
  if (filters.outcome === "loss") where.OR = [{ whiteId: userId, result: "BLACK_WINS" }, { blackId: userId, result: "WHITE_WINS" }];
  const rows = await prisma.game.findMany({
    where,
    select: gameListSelect,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items.at(-1)!.id : null };
}

export async function getActiveGameForUser(userId: string): Promise<{ id: string } | null> {
  return prisma.game.findFirst({ where: { status: "ACTIVE", OR: [{ whiteId: userId }, { blackId: userId }] }, select: { id: true } });
}

import { isProvisional } from "@tempo/chess-core";
import { RATING_DEFAULTS, type RatingCategory } from "@tempo/shared";
import { prisma } from "@/lib/db";
import { orderedPair } from "@tempo/shared";

export async function getProfileByUsername(username: string) {
  return prisma.user.findFirst({
    where: { username: { equals: username.toLowerCase(), mode: "insensitive" } },
    select: { id: true, username: true, image: true, bio: true, country: true, createdAt: true, lastSeenAt: true, profileVisibility: true, banned: true, ratings: true },
  });
}

export async function getRelation(viewerId: string | null, targetId: string): Promise<"self" | "friend" | "outgoing" | "incoming" | "blocked" | "blockedBy" | "none"> {
  if (!viewerId) return "none";
  if (viewerId === targetId) return "self";
  const [a, b] = orderedPair(viewerId, targetId);
  const [friendship, request, block] = await Promise.all([
    prisma.friendship.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } }),
    prisma.friendRequest.findFirst({ where: { status: "PENDING", OR: [{ senderId: viewerId, receiverId: targetId }, { senderId: targetId, receiverId: viewerId }] } }),
    prisma.block.findFirst({ where: { OR: [{ blockerId: viewerId, blockedId: targetId }, { blockerId: targetId, blockedId: viewerId }] } }),
  ]);
  if (block) return block.blockerId === viewerId ? "blocked" : "blockedBy";
  if (friendship) return "friend";
  if (request) return request.senderId === viewerId ? "outgoing" : "incoming";
  return "none";
}

export interface ProfileStats {
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  averageDurationSec: number | null;
  averageAccuracy: number | null;
  analyzedGames: number;
  mostPlayed: RatingCategory | null;
}

export async function getProfileStats(userId: string): Promise<ProfileStats> {
  const games = await prisma.game.findMany({
    where: { status: "FINISHED", OR: [{ whiteId: userId }, { blackId: userId }] },
    select: { whiteId: true, result: true, category: true, startedAt: true, endedAt: true, analysis: { select: { status: true, whiteAccuracy: true, blackAccuracy: true } } },
  });
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let durationTotal = 0;
  let durationCount = 0;
  let accTotal = 0;
  let accCount = 0;
  const byCategory: Record<string, number> = {};
  for (const g of games) {
    const isWhite = g.whiteId === userId;
    if (g.result === "DRAW") draws++;
    else if ((g.result === "WHITE_WINS") === isWhite) wins++;
    else losses++;
    if (g.endedAt) {
      durationTotal += (g.endedAt.getTime() - g.startedAt.getTime()) / 1000;
      durationCount++;
    }
    byCategory[g.category] = (byCategory[g.category] ?? 0) + 1;
    if (g.analysis?.status === "COMPLETED") {
      const acc = isWhite ? g.analysis.whiteAccuracy : g.analysis.blackAccuracy;
      if (acc != null) {
        accTotal += acc;
        accCount++;
      }
    }
  }
  const totalGames = games.length;
  const mostPlayed = (Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0]?.[0] as RatingCategory | undefined) ?? null;
  return {
    totalGames,
    wins,
    losses,
    draws,
    winRate: totalGames ? Math.round((wins / totalGames) * 1000) / 10 : null,
    averageDurationSec: durationCount ? Math.round(durationTotal / durationCount) : null,
    averageAccuracy: accCount ? Math.round((accTotal / accCount) * 10) / 10 : null,
    analyzedGames: accCount,
    mostPlayed,
  };
}

export interface RatingPoint {
  t: number;
  rating: number;
  category: RatingCategory;
}

export async function getRatingHistory(userId: string, limitPerCategory = 200): Promise<RatingPoint[]> {
  const rows = await prisma.ratingHistory.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { category: true, ratingAfter: true, createdAt: true }, take: limitPerCategory * 3 });
  return rows.map((r) => ({ t: r.createdAt.getTime(), rating: Math.round(r.ratingAfter), category: r.category }));
}

export function ratingSummaryFromRows(rows: { category: RatingCategory; rating: number; deviation: number; gamesPlayed: number; wins: number; losses: number; draws: number; peakRating: number }[]) {
  return (["BULLET", "BLITZ", "RAPID"] as RatingCategory[]).map((category) => {
    const r = rows.find((x) => x.category === category);
    return {
      category,
      rating: Math.round(r?.rating ?? RATING_DEFAULTS.startRating),
      provisional: isProvisional(r?.deviation ?? RATING_DEFAULTS.startDeviation, RATING_DEFAULTS.provisionalDeviation),
      gamesPlayed: r?.gamesPlayed ?? 0,
      wins: r?.wins ?? 0,
      losses: r?.losses ?? 0,
      draws: r?.draws ?? 0,
      peakRating: Math.round(r?.peakRating ?? RATING_DEFAULTS.startRating),
    };
  });
}

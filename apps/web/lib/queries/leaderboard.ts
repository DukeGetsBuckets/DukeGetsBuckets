import { isProvisional } from "@tempo/chess-core";
import { LEADERBOARD_RULES, RATING_DEFAULTS, type RatingCategory } from "@tempo/shared";
import { prisma } from "@/lib/db";

export interface LeaderboardRow {
  rank: number;
  userId: string;
  username: string;
  image: string | null;
  rating: number;
  gamesPlayed: number;
  provisional: boolean;
}

export async function getLeaderboard(category: RatingCategory, opts: { friendsOf?: string; search?: string; limit?: number } = {}): Promise<LeaderboardRow[]> {
  const limit = opts.limit ?? LEADERBOARD_RULES.pageSize;
  let userIds: string[] | undefined;
  if (opts.friendsOf) {
    const rows = await prisma.friendship.findMany({ where: { OR: [{ userAId: opts.friendsOf }, { userBId: opts.friendsOf }] } });
    userIds = [opts.friendsOf, ...rows.map((r) => (r.userAId === opts.friendsOf ? r.userBId : r.userAId))];
  }
  const ratings = await prisma.rating.findMany({
    where: {
      category,
      gamesPlayed: { gte: LEADERBOARD_RULES.minGames },
      user: { banned: false, ...(opts.search ? { username: { startsWith: opts.search.toLowerCase() } } : {}) },
      ...(userIds ? { userId: { in: userIds } } : {}),
    },
    orderBy: [{ rating: "desc" }, { gamesPlayed: "desc" }],
    take: limit,
    include: { user: { select: { username: true, image: true } } },
  });
  return ratings.map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    username: r.user.username ?? "player",
    image: r.user.image,
    rating: Math.round(r.rating),
    gamesPlayed: r.gamesPlayed,
    provisional: isProvisional(r.deviation, RATING_DEFAULTS.provisionalDeviation),
  }));
}

/** Rank of a user within a category (null when not qualified). */
export async function getRank(userId: string, category: RatingCategory): Promise<number | null> {
  const me = await prisma.rating.findUnique({ where: { userId_category: { userId, category } } });
  if (!me || me.gamesPlayed < LEADERBOARD_RULES.minGames) return null;
  const above = await prisma.rating.count({ where: { category, gamesPlayed: { gte: LEADERBOARD_RULES.minGames }, rating: { gt: me.rating }, user: { banned: false } } });
  return above + 1;
}

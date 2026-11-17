import { isProvisional } from "@tempo/chess-core";
import { RATING_DEFAULTS, type RatingCategory } from "@tempo/shared";
import { prisma } from "@/lib/db";

export interface RatingSummary {
  category: RatingCategory;
  rating: number;
  deviation: number;
  provisional: boolean;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  peakRating: number;
}

export async function getRatings(userId: string): Promise<RatingSummary[]> {
  const rows = await prisma.rating.findMany({ where: { userId } });
  return (["BULLET", "BLITZ", "RAPID"] as RatingCategory[]).map((category) => {
    const r = rows.find((x) => x.category === category);
    return {
      category,
      rating: Math.round(r?.rating ?? RATING_DEFAULTS.startRating),
      deviation: r?.deviation ?? RATING_DEFAULTS.startDeviation,
      provisional: isProvisional(r?.deviation ?? RATING_DEFAULTS.startDeviation, RATING_DEFAULTS.provisionalDeviation),
      gamesPlayed: r?.gamesPlayed ?? 0,
      wins: r?.wins ?? 0,
      losses: r?.losses ?? 0,
      draws: r?.draws ?? 0,
      peakRating: Math.round(r?.peakRating ?? RATING_DEFAULTS.startRating),
    };
  });
}

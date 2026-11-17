import { openingFamily } from "@tempo/chess-core";
import { THEME_LABELS, type AnalysisSummary, type CoachingReport, type RatingCategory } from "@tempo/shared";
import { prisma } from "@/lib/db";

export interface ImproveData {
  totalGames: number;
  analyzedGames: number;
  accuracyTrend: { gameId: string; date: string; accuracy: number; result: "win" | "loss" | "draw" }[];
  recentAverageAccuracy: number | null;
  mistakeThemes: { theme: string; label: string; count: number }[];
  strongestArea: string | null;
  weakestArea: string | null;
  classificationTotals: Record<string, number>;
  openings: { family: string; eco: string | null; games: number; wins: number; losses: number; draws: number; asWhite: number; asBlack: number; avgAccuracy: number | null }[];
  training: { total: number; solved: number; failed: number; pending: number; solvedLast7Days: number };
  ratings: { category: RatingCategory; rating: number; delta30d: number | null }[];
}

export async function getImproveData(userId: string): Promise<ImproveData> {
  const games = await prisma.game.findMany({
    where: { status: "FINISHED", OR: [{ whiteId: userId }, { blackId: userId }] },
    orderBy: { startedAt: "desc" },
    take: 200,
    select: { id: true, whiteId: true, result: true, startedAt: true, openingName: true, openingEco: true, analysis: { select: { status: true, whiteAccuracy: true, blackAccuracy: true, summary: true, coaching: true } } },
  });
  const accuracyTrend: ImproveData["accuracyTrend"] = [];
  const themeCounts = new Map<string, number>();
  const classTotals: Record<string, number> = {};
  const openings = new Map<string, ImproveData["openings"][number] & { accSum: number; accN: number }>();
  for (const g of games) {
    const isWhite = g.whiteId === userId;
    const color = isWhite ? "white" : "black";
    const result: "win" | "loss" | "draw" = g.result === "DRAW" ? "draw" : (g.result === "WHITE_WINS") === isWhite ? "win" : "loss";
    const acc = g.analysis?.status === "COMPLETED" ? (isWhite ? g.analysis.whiteAccuracy : g.analysis.blackAccuracy) : null;
    if (acc != null) accuracyTrend.push({ gameId: g.id, date: g.startedAt.toISOString(), accuracy: acc, result });
    if (g.analysis?.status === "COMPLETED") {
      const summary = g.analysis.summary as unknown as AnalysisSummary | null;
      const counts = summary?.[color]?.counts;
      if (counts) for (const [k, v] of Object.entries(counts)) classTotals[k] = (classTotals[k] ?? 0) + v;
      const coaching = g.analysis.coaching as unknown as { white: CoachingReport; black: CoachingReport } | null;
      for (const t of coaching?.[color]?.themes ?? []) themeCounts.set(t.theme, (themeCounts.get(t.theme) ?? 0) + t.count);
    }
    if (g.openingName) {
      const family = openingFamily(g.openingName);
      const row = openings.get(family) ?? { family, eco: g.openingEco?.slice(0, 1) ?? null, games: 0, wins: 0, losses: 0, draws: 0, asWhite: 0, asBlack: 0, avgAccuracy: null, accSum: 0, accN: 0 };
      row.games++;
      if (result === "win") row.wins++;
      else if (result === "loss") row.losses++;
      else row.draws++;
      if (isWhite) row.asWhite++;
      else row.asBlack++;
      if (acc != null) {
        row.accSum += acc;
        row.accN++;
      }
      openings.set(family, row);
    }
  }
  accuracyTrend.reverse();
  const recent = accuracyTrend.slice(-10);
  const recentAverageAccuracy = recent.length ? Math.round((recent.reduce((a, b) => a + b.accuracy, 0) / recent.length) * 10) / 10 : null;
  const mistakeThemes = [...themeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([theme, count]) => ({ theme, label: THEME_LABELS[theme] ?? theme, count }));

  // Strongest area: a phase/skill where the player performs well, derived from classification totals.
  let strongestArea: string | null = null;
  const judged = Object.entries(classTotals).filter(([k]) => k !== "BOOK" && k !== "FORCED").reduce((a, [, v]) => a + v, 0);
  if (judged >= 20) {
    const bookShare = (classTotals.BOOK ?? 0) / Math.max(1, judged + (classTotals.BOOK ?? 0));
    const bestShare = ((classTotals.BEST ?? 0) + (classTotals.GREAT ?? 0) + (classTotals.BRILLIANT ?? 0)) / judged;
    const blunderShare = (classTotals.BLUNDER ?? 0) / judged;
    if (bookShare >= 0.2) strongestArea = "Opening development";
    else if (bestShare >= 0.4) strongestArea = "Finding best moves";
    else if (blunderShare <= 0.03) strongestArea = "Avoiding blunders";
    else strongestArea = "Consistency";
  }
  const weakestArea = mistakeThemes[0]?.label ?? null;

  const [training, solvedRecently, ratings, history] = await Promise.all([
    prisma.trainingPosition.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    prisma.trainingPosition.count({ where: { userId, status: "SOLVED", solvedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
    prisma.rating.findMany({ where: { userId } }),
    prisma.ratingHistory.findMany({ where: { userId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, orderBy: { createdAt: "asc" }, select: { category: true, ratingBefore: true } }),
  ]);
  const count = (s: string) => training.find((t) => t.status === s)?._count._all ?? 0;
  return {
    totalGames: games.length,
    analyzedGames: accuracyTrend.length,
    accuracyTrend,
    recentAverageAccuracy,
    mistakeThemes,
    strongestArea,
    weakestArea,
    classificationTotals: classTotals,
    openings: [...openings.values()].sort((a, b) => b.games - a.games).slice(0, 12).map(({ accSum, accN, ...o }) => ({ ...o, avgAccuracy: accN ? Math.round((accSum / accN) * 10) / 10 : null })),
    training: { total: count("NEW") + count("SOLVED") + count("FAILED") + count("REVIEW") + count("SKIPPED"), solved: count("SOLVED"), failed: count("FAILED"), pending: count("NEW") + count("FAILED") + count("REVIEW"), solvedLast7Days: solvedRecently },
    ratings: (["BULLET", "BLITZ", "RAPID"] as RatingCategory[]).map((category) => {
      const r = ratings.find((x) => x.category === category);
      const first = history.find((h) => h.category === category);
      return { category, rating: Math.round(r?.rating ?? 1500), delta30d: first && r ? Math.round(r.rating - first.ratingBefore) : null };
    }),
  };
}

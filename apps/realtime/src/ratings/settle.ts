import { Prisma, type PrismaClient } from "@tempo/database";
import { inflateForInactivity, isProvisional, rateGame, type GlickoRating } from "@tempo/chess-core";
import { RATING_DEFAULTS, type RatingCategory } from "@tempo/shared";
import { logger } from "../logger";

export interface SettlementSide {
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
  deviationAfter: number;
  provisional: boolean;
}
export interface Settlement {
  white: SettlementSide;
  black: SettlementSide;
}

function defaultRating(): GlickoRating {
  return { rating: RATING_DEFAULTS.startRating, deviation: RATING_DEFAULTS.startDeviation, volatility: RATING_DEFAULTS.startVolatility };
}

/**
 * Settle ratings for a finished rated game exactly once.
 * The game row is locked FOR UPDATE inside a serializable-enough transaction; the `ratingSettled`
 * flag plus the unique (userId, gameId) constraint on RatingHistory make this idempotent even
 * under concurrent calls or process restarts.
 */
export async function settleRatings(prisma: PrismaClient, gameId: string): Promise<Settlement | null> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<
          { id: string; whiteId: string; blackId: string; category: RatingCategory; rated: boolean; status: string; result: string | null; ratingSettled: boolean; endedAt: Date | null }[]
        >`SELECT "id", "whiteId", "blackId", "category", "rated", "status", "result", "ratingSettled", "endedAt" FROM "Game" WHERE "id" = ${gameId} FOR UPDATE`;
        const game = locked[0];
        if (!game || game.status !== "FINISHED" || !game.rated || game.ratingSettled || !game.result) return null;
        const result = game.result as "WHITE_WINS" | "BLACK_WINS" | "DRAW";
        const now = game.endedAt ?? new Date();

        const load = async (userId: string) => {
          const row = await tx.rating.upsert({
            where: { userId_category: { userId, category: game.category } },
            create: { userId, category: game.category, ...defaultRating(), peakRating: RATING_DEFAULTS.startRating },
            update: {},
          });
          const daysInactive = row.gamesPlayed > 0 ? (now.getTime() - row.updatedAt.getTime()) / 86_400_000 : 0;
          const current = inflateForInactivity(
            { rating: row.rating, deviation: row.deviation, volatility: row.volatility },
            daysInactive,
            { tau: RATING_DEFAULTS.tau, minDeviation: RATING_DEFAULTS.minDeviation, maxDeviation: RATING_DEFAULTS.maxDeviation },
          );
          return { row, current };
        };
        const w = await load(game.whiteId);
        const b = await load(game.blackId);
        const updated = rateGame(w.current, b.current, result, {
          tau: RATING_DEFAULTS.tau,
          minDeviation: RATING_DEFAULTS.minDeviation,
          maxDeviation: RATING_DEFAULTS.maxDeviation,
        });

        const apply = async (side: "white" | "black", before: GlickoRating, after: GlickoRating, rowId: string, userId: string) => {
          const won = result === (side === "white" ? "WHITE_WINS" : "BLACK_WINS");
          const drew = result === "DRAW";
          const existing = await tx.rating.findUniqueOrThrow({ where: { id: rowId } });
          await tx.rating.update({
            where: { id: rowId },
            data: {
              rating: after.rating,
              deviation: after.deviation,
              volatility: after.volatility,
              gamesPlayed: { increment: 1 },
              wins: { increment: won ? 1 : 0 },
              losses: { increment: !won && !drew ? 1 : 0 },
              draws: { increment: drew ? 1 : 0 },
              peakRating: Math.max(existing.peakRating, after.rating),
            },
          });
          await tx.ratingHistory.create({
            data: {
              userId,
              gameId,
              category: game.category,
              ratingBefore: before.rating,
              ratingAfter: after.rating,
              delta: after.rating - before.rating,
              deviationAfter: after.deviation,
            },
          });
          return {
            ratingBefore: before.rating,
            ratingAfter: after.rating,
            delta: after.rating - before.rating,
            deviationAfter: after.deviation,
            provisional: isProvisional(after.deviation, RATING_DEFAULTS.provisionalDeviation),
          } satisfies SettlementSide;
        };

        const white = await apply("white", w.current, updated.white, w.row.id, game.whiteId);
        const black = await apply("black", b.current, updated.black, b.row.id, game.blackId);
        await tx.game.update({
          where: { id: gameId },
          data: {
            ratingSettled: true,
            whiteRatingBefore: white.ratingBefore,
            whiteRatingAfter: white.ratingAfter,
            blackRatingBefore: black.ratingBefore,
            blackRatingAfter: black.ratingAfter,
          },
        });
        return { white, black };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
    );
  } catch (err) {
    // A concurrent settlement may have won the race; the unique constraint guarantees no double award.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn({ gameId }, "rating settlement raced; already settled");
      return null;
    }
    throw err;
  }
}

/** Fetch (or initialise) a user's rating row for a category. */
export async function getOrCreateRating(prisma: PrismaClient, userId: string, category: RatingCategory) {
  return prisma.rating.upsert({
    where: { userId_category: { userId, category } },
    create: { userId, category, ...defaultRating(), peakRating: RATING_DEFAULTS.startRating },
    update: {},
  });
}

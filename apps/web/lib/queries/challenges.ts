import type { ChallengeDTO } from "@tempo/shared";
import { RATING_DEFAULTS } from "@tempo/shared";
import { prisma } from "@/lib/db";

export async function listChallenges(userId: string): Promise<{ incoming: ChallengeDTO[]; outgoing: ChallengeDTO[] }> {
  const rows = await prisma.challenge.findMany({
    where: { status: "PENDING", expiresAt: { gt: new Date() }, OR: [{ senderId: userId }, { recipientId: userId }] },
    include: { sender: { select: { id: true, username: true, image: true, ratings: { select: { category: true, rating: true } } } }, recipient: { select: { id: true, username: true } } },
    orderBy: { createdAt: "desc" },
  });
  const toDTO = (c: (typeof rows)[number]): ChallengeDTO => ({
    id: c.id,
    token: c.token,
    sender: { id: c.sender.id, username: c.sender.username ?? "player", image: c.sender.image, rating: Math.round(c.sender.ratings.find((r) => r.category === c.category)?.rating ?? RATING_DEFAULTS.startRating) },
    recipient: c.recipient ? { id: c.recipient.id, username: c.recipient.username ?? "player" } : null,
    category: c.category,
    initialTimeMs: c.initialTimeMs,
    incrementMs: c.incrementMs,
    rated: c.rated,
    senderColor: c.senderColor,
    status: c.status,
    gameId: c.gameId,
    rematchOfGameId: c.rematchOfGameId,
    expiresAt: c.expiresAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
  });
  return { incoming: rows.filter((c) => c.recipientId === userId).map(toDTO), outgoing: rows.filter((c) => c.senderId === userId).map(toDTO) };
}

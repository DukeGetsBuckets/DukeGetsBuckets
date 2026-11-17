import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@tempo/database";
import { ErrorCodes, SOCIAL_RULES, TIME_CONTROLS, type ChallengeDTO, type PlayerColor, type RatingCategory } from "@tempo/shared";
import { fail } from "../errors";
import type { Emitter } from "../games/emitter";
import type { GameManager } from "../games/GameManager";
import { logger } from "../logger";
import type { Notifier } from "../notifications";
import { getOrCreateRating } from "../ratings/settle";
import type { FriendService } from "../friends/service";

/** Rated games between the same two accounts per rolling 24h before further games are forced unrated. */
export const RATED_PAIR_DAILY_LIMIT = 10;

export class ChallengeService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly emitter: Emitter,
    private readonly notifier: Notifier,
    private readonly games: GameManager,
    private readonly friends: FriendService,
  ) {}

  private async toDTO(id: string): Promise<ChallengeDTO> {
    const c = await this.prisma.challenge.findUniqueOrThrow({
      where: { id },
      include: { sender: { select: { id: true, username: true, image: true } }, recipient: { select: { id: true, username: true } } },
    });
    const rating = await getOrCreateRating(this.prisma, c.senderId, c.category);
    return {
      id: c.id,
      token: c.token,
      sender: { id: c.sender.id, username: c.sender.username ?? "player", image: c.sender.image, rating: Math.round(rating.rating) },
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
    };
  }

  async ratedGamesBetweenToday(a: string, b: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 3600_000);
    return this.prisma.game.count({
      where: {
        rated: true,
        status: "FINISHED",
        createdAt: { gte: since },
        OR: [{ whiteId: a, blackId: b }, { whiteId: b, blackId: a }],
      },
    });
  }

  async create(senderId: string, payload: { recipientId?: string; category: RatingCategory; rated: boolean; color: "RANDOM" | "WHITE" | "BLACK" }): Promise<{ challenge: ChallengeDTO; note?: string }> {
    if (this.games.activeGameOf(senderId)) fail(ErrorCodes.ALREADY_IN_GAME, "Finish your current game first");
    const pending = await this.prisma.challenge.count({ where: { senderId, status: "PENDING", expiresAt: { gt: new Date() } } });
    if (pending >= SOCIAL_RULES.maxPendingChallengesPerUser) fail(ErrorCodes.RATE_LIMITED, "Too many pending challenges");
    let rated = payload.rated;
    let note: string | undefined;
    if (payload.recipientId) {
      if (payload.recipientId === senderId) fail(ErrorCodes.CONFLICT, "You cannot challenge yourself");
      const recipient = await this.prisma.user.findUnique({ where: { id: payload.recipientId }, select: { id: true, settings: true, banned: true } });
      if (!recipient || recipient.banned) fail(ErrorCodes.NOT_FOUND, "Player not found");
      const block = await this.prisma.block.findFirst({ where: { OR: [{ blockerId: senderId, blockedId: recipient.id }, { blockerId: recipient.id, blockedId: senderId }] } });
      if (block) fail(ErrorCodes.BLOCKED, "You cannot challenge this player");
      const allow = recipient.settings?.allowChallenges ?? "everyone";
      if (allow === "nobody") fail(ErrorCodes.FORBIDDEN, "This player is not accepting challenges");
      if (allow === "friends" && !(await this.friends.areFriends(senderId, recipient.id))) fail(ErrorCodes.FORBIDDEN, "This player only accepts challenges from friends");
      if (rated && (await this.ratedGamesBetweenToday(senderId, recipient.id)) >= RATED_PAIR_DAILY_LIMIT) {
        rated = false;
        note = `You have reached the daily limit of ${RATED_PAIR_DAILY_LIMIT} rated games against this opponent; this game will be unrated.`;
      }
    }
    const tc = TIME_CONTROLS[payload.category];
    const challenge = await this.prisma.challenge.create({
      data: {
        senderId,
        recipientId: payload.recipientId ?? null,
        category: payload.category,
        initialTimeMs: tc.initialMs,
        incrementMs: tc.incrementMs,
        rated,
        senderColor: payload.color,
        token: randomBytes(24).toString("base64url"),
        expiresAt: new Date(Date.now() + SOCIAL_RULES.challengeExpiryMs),
      },
    });
    const dto = await this.toDTO(challenge.id);
    if (payload.recipientId) {
      this.emitter.toUser(payload.recipientId, "challenge:received", dto);
      await this.notifier.send(payload.recipientId, "CHALLENGE", { challengeId: dto.id, from: dto.sender.username, category: dto.category, rated: dto.rated }, dto.id);
    }
    return { challenge: dto, note };
  }

  async accept(userId: string, target: { challengeId?: string; token?: string }): Promise<{ gameId: string }> {
    const challenge = target.challengeId
      ? await this.prisma.challenge.findUnique({ where: { id: target.challengeId } })
      : target.token
        ? await this.prisma.challenge.findUnique({ where: { token: target.token } })
        : null;
    if (!challenge) fail(ErrorCodes.NOT_FOUND, "Challenge not found");
    if (challenge.senderId === userId) fail(ErrorCodes.CONFLICT, "You cannot accept your own challenge");
    // Private challenges may only be accepted by the addressee; link challenges by anyone with the token.
    if (challenge.recipientId && challenge.recipientId !== userId) fail(ErrorCodes.FORBIDDEN, "This challenge is addressed to someone else");
    if (!challenge.recipientId && !target.token) fail(ErrorCodes.FORBIDDEN, "Open challenges must be accepted via their link");
    if (challenge.status !== "PENDING") fail(ErrorCodes.CONFLICT, `This challenge was already ${challenge.status.toLowerCase()}`);
    if (challenge.expiresAt.getTime() < Date.now()) {
      await this.prisma.challenge.update({ where: { id: challenge.id }, data: { status: "EXPIRED" } });
      fail(ErrorCodes.EXPIRED, "This challenge has expired");
    }
    const block = await this.prisma.block.findFirst({ where: { OR: [{ blockerId: userId, blockedId: challenge.senderId }, { blockerId: challenge.senderId, blockedId: userId }] } });
    if (block) fail(ErrorCodes.BLOCKED, "You cannot play this player");
    if (this.games.activeGameOf(userId)) fail(ErrorCodes.ALREADY_IN_GAME, "Finish your current game first");
    if (this.games.activeGameOf(challenge.senderId)) fail(ErrorCodes.CONFLICT, "The challenger is already in a game");

    // Claim atomically so two accepts (e.g. a shared link) cannot both start games.
    const claimed = await this.prisma.challenge.updateMany({
      where: { id: challenge.id, status: "PENDING" },
      data: { status: "ACCEPTED", respondedAt: new Date(), recipientId: challenge.recipientId ?? userId },
    });
    if (claimed.count !== 1) fail(ErrorCodes.CONFLICT, "This challenge was just accepted by someone else");

    let senderIsWhite: boolean;
    if (challenge.senderColor === "WHITE") senderIsWhite = true;
    else if (challenge.senderColor === "BLACK") senderIsWhite = false;
    else senderIsWhite = Math.random() < 0.5;
    const whiteId = senderIsWhite ? challenge.senderId : userId;
    const blackId = senderIsWhite ? userId : challenge.senderId;
    let rated = challenge.rated;
    if (rated && (await this.ratedGamesBetweenToday(whiteId, blackId)) >= RATED_PAIR_DAILY_LIMIT) rated = false;

    try {
      const game = await this.games.createGame({
        whiteId,
        blackId,
        category: challenge.category,
        rated,
        source: "CHALLENGE",
        initialTimeMs: challenge.initialTimeMs,
        incrementMs: challenge.incrementMs,
      });
      await this.prisma.challenge.update({ where: { id: challenge.id }, data: { gameId: game.id } });
      for (const color of ["white", "black"] as PlayerColor[]) {
        const me = game.player(color);
        const opp = game.opponentOf(color);
        this.emitter.toUser(me.id, "match:found", {
          gameId: game.id,
          color,
          opponent: { id: opp.id, username: opp.username, rating: Math.round(opp.rating) },
          category: game.category,
          source: "CHALLENGE",
        });
      }
      this.emitter.toUser(challenge.senderId, "challenge:accepted", { challengeId: challenge.id, gameId: game.id });
      this.emitter.toUser(userId, "challenge:accepted", { challengeId: challenge.id, gameId: game.id });
      await this.notifier.send(challenge.senderId, "CHALLENGE_ACCEPTED", { challengeId: challenge.id, gameId: game.id }, game.id);
      return { gameId: game.id };
    } catch (err) {
      await this.prisma.challenge.update({ where: { id: challenge.id }, data: { status: "PENDING", respondedAt: null } }).catch(() => undefined);
      throw err;
    }
  }

  async decline(userId: string, challengeId: string): Promise<void> {
    const challenge = await this.prisma.challenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.recipientId !== userId) fail(ErrorCodes.NOT_FOUND, "Challenge not found");
    if (challenge.status !== "PENDING") return;
    await this.prisma.challenge.update({ where: { id: challengeId }, data: { status: "DECLINED", respondedAt: new Date() } });
    this.emitter.toUser(challenge.senderId, "challenge:declined", { challengeId });
    this.emitter.toUser(userId, "challenge:declined", { challengeId });
    await this.notifier.send(challenge.senderId, "CHALLENGE_DECLINED", { challengeId }, challengeId);
  }

  async cancel(userId: string, challengeId: string): Promise<void> {
    const challenge = await this.prisma.challenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.senderId !== userId) fail(ErrorCodes.NOT_FOUND, "Challenge not found");
    if (challenge.status !== "PENDING") return;
    await this.prisma.challenge.update({ where: { id: challengeId }, data: { status: "CANCELED", respondedAt: new Date() } });
    if (challenge.recipientId) this.emitter.toUser(challenge.recipientId, "challenge:canceled", { challengeId });
    this.emitter.toUser(userId, "challenge:canceled", { challengeId });
  }

  /** Mark expired challenges and notify both parties. */
  async expireStale(): Promise<number> {
    const stale = await this.prisma.challenge.findMany({ where: { status: "PENDING", expiresAt: { lt: new Date() } }, select: { id: true, senderId: true, recipientId: true } });
    if (!stale.length) return 0;
    await this.prisma.challenge.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { status: "EXPIRED" } });
    for (const c of stale) {
      this.emitter.toUser(c.senderId, "challenge:expired", { challengeId: c.id });
      if (c.recipientId) this.emitter.toUser(c.recipientId, "challenge:expired", { challengeId: c.id });
    }
    return stale.length;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.expireStale().catch((err) => logger.error({ err }, "challenge expiry failed")), 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

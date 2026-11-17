import type { PrismaClient } from "@tempo/database";
import { ErrorCodes, RATING_DEFAULTS, SOCIAL_RULES, orderedPair, type FriendSummary, type RatingCategory } from "@tempo/shared";
import { fail } from "../errors";
import type { Emitter } from "../games/emitter";
import type { Notifier } from "../notifications";
import type { Presence } from "../presence";

export class FriendService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly emitter: Emitter,
    private readonly notifier: Notifier,
    private readonly presence: Presence,
  ) {}

  private async ensureNotBlocked(a: string, b: string): Promise<void> {
    const block = await this.prisma.block.findFirst({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] } });
    if (block) fail(ErrorCodes.BLOCKED, "This action is not available for this user");
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    const [x, y] = orderedPair(a, b);
    return Boolean(await this.prisma.friendship.findUnique({ where: { userAId_userBId: { userAId: x, userBId: y } } }));
  }

  async resolveUser(target: { userId?: string; username?: string }) {
    if (target.userId) {
      return this.prisma.user.findUnique({ where: { id: target.userId }, select: { id: true, username: true, image: true, settings: true } });
    }
    if (target.username) {
      return this.prisma.user.findFirst({
        where: { username: { equals: target.username.trim().toLowerCase(), mode: "insensitive" } },
        select: { id: true, username: true, image: true, settings: true },
      });
    }
    return null;
  }

  async sendRequest(fromId: string, fromUsername: string, target: { userId?: string; username?: string }): Promise<{ requestId: string }> {
    const user = await this.resolveUser(target);
    if (!user) fail(ErrorCodes.NOT_FOUND, "No player with that username");
    if (user.id === fromId) fail(ErrorCodes.CONFLICT, "You cannot add yourself");
    await this.ensureNotBlocked(fromId, user.id);
    if (user.settings && !user.settings.allowFriendRequests) fail(ErrorCodes.FORBIDDEN, "This player is not accepting friend requests");
    if (await this.areFriends(fromId, user.id)) fail(ErrorCodes.CONFLICT, "You are already friends");

    // If they already asked us, accept instead of creating a crossing request.
    const incoming = await this.prisma.friendRequest.findUnique({ where: { senderId_receiverId: { senderId: user.id, receiverId: fromId } } });
    if (incoming && incoming.status === "PENDING") {
      await this.accept(fromId, incoming.id);
      return { requestId: incoming.id };
    }
    const request = await this.prisma.friendRequest.upsert({
      where: { senderId_receiverId: { senderId: fromId, receiverId: user.id } },
      create: { senderId: fromId, receiverId: user.id },
      update: { status: "PENDING", createdAt: new Date(), respondedAt: null },
    });
    const sender = await this.prisma.user.findUnique({ where: { id: fromId }, select: { image: true } });
    this.emitter.toUser(user.id, "friend:request:received", { requestId: request.id, from: { id: fromId, username: fromUsername, image: sender?.image ?? null } });
    await this.notifier.send(user.id, "FRIEND_REQUEST", { requestId: request.id, fromId, fromUsername }, request.id);
    return { requestId: request.id };
  }

  async accept(userId: string, requestId: string): Promise<FriendSummary> {
    const request = await this.prisma.friendRequest.findUnique({ where: { id: requestId } });
    if (!request || request.receiverId !== userId) fail(ErrorCodes.NOT_FOUND, "Friend request not found");
    if (request.status !== "PENDING") fail(ErrorCodes.CONFLICT, "This request was already handled");
    const [a, b] = orderedPair(request.senderId, request.receiverId);
    await this.prisma.$transaction([
      this.prisma.friendRequest.update({ where: { id: requestId }, data: { status: "ACCEPTED", respondedAt: new Date() } }),
      this.prisma.friendship.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, create: { userAId: a, userBId: b }, update: {} }),
    ]);
    this.presence.invalidateFriends(request.senderId);
    this.presence.invalidateFriends(request.receiverId);
    const [forSender, forReceiver] = await Promise.all([this.summary(request.receiverId), this.summary(request.senderId)]);
    this.emitter.toUser(request.senderId, "friend:accepted", { friend: forSender });
    this.emitter.toUser(request.receiverId, "friend:request:resolved", { requestId, status: "ACCEPTED" });
    await this.notifier.send(request.senderId, "FRIEND_ACCEPTED", { userId: request.receiverId, username: forSender.username }, request.receiverId);
    return forReceiver;
  }

  async decline(userId: string, requestId: string): Promise<void> {
    const request = await this.prisma.friendRequest.findUnique({ where: { id: requestId } });
    if (!request || request.receiverId !== userId) fail(ErrorCodes.NOT_FOUND, "Friend request not found");
    if (request.status !== "PENDING") return;
    await this.prisma.friendRequest.update({ where: { id: requestId }, data: { status: "DECLINED", respondedAt: new Date() } });
    this.emitter.toUser(request.senderId, "friend:request:resolved", { requestId, status: "DECLINED" });
    this.emitter.toUser(userId, "friend:request:resolved", { requestId, status: "DECLINED" });
  }

  async cancel(userId: string, requestId: string): Promise<void> {
    const request = await this.prisma.friendRequest.findUnique({ where: { id: requestId } });
    if (!request || request.senderId !== userId) fail(ErrorCodes.NOT_FOUND, "Friend request not found");
    if (request.status !== "PENDING") return;
    await this.prisma.friendRequest.update({ where: { id: requestId }, data: { status: "CANCELED", respondedAt: new Date() } });
    this.emitter.toUser(request.receiverId, "friend:request:resolved", { requestId, status: "CANCELED" });
    this.emitter.toUser(userId, "friend:request:resolved", { requestId, status: "CANCELED" });
  }

  async remove(userId: string, otherId: string): Promise<void> {
    const [a, b] = orderedPair(userId, otherId);
    await this.prisma.friendship.deleteMany({ where: { userAId: a, userBId: b } });
    await this.prisma.friendRequest.deleteMany({
      where: { OR: [{ senderId: userId, receiverId: otherId }, { senderId: otherId, receiverId: userId }] },
    });
    this.presence.invalidateFriends(userId);
    this.presence.invalidateFriends(otherId);
    this.emitter.toUser(otherId, "friend:removed", { userId });
    this.emitter.toUser(userId, "friend:removed", { userId: otherId });
  }

  async summary(userId: string): Promise<FriendSummary> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, username: true, image: true, ratings: { select: { category: true, rating: true } } },
    });
    const ratings = { BULLET: RATING_DEFAULTS.startRating, BLITZ: RATING_DEFAULTS.startRating, RAPID: RATING_DEFAULTS.startRating } as Record<RatingCategory, number>;
    for (const r of user.ratings) ratings[r.category] = Math.round(r.rating);
    const { status, gameId } = this.presence.statusOf(userId);
    return { id: user.id, username: user.username ?? "player", image: user.image, status, gameId, ratings };
  }

  async list(userId: string): Promise<FriendSummary[]> {
    const ids = await this.presence.friendIds(userId);
    const out = await Promise.all(ids.map((id) => this.summary(id)));
    const order = { playing: 0, online: 1, offline: 2 };
    return out.sort((a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username));
  }

  async search(viewerId: string, query: string) {
    const q = query.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (q.length < 1) return [];
    const users = await this.prisma.user.findMany({
      where: { username: { startsWith: q }, banned: false },
      select: { id: true, username: true, image: true, profileVisibility: true },
      orderBy: { username: "asc" },
      take: 10,
    });
    const ids = users.map((u) => u.id);
    const [friendships, requests, blocks] = await Promise.all([
      this.prisma.friendship.findMany({ where: { OR: [{ userAId: viewerId, userBId: { in: ids } }, { userBId: viewerId, userAId: { in: ids } }] } }),
      this.prisma.friendRequest.findMany({ where: { status: "PENDING", OR: [{ senderId: viewerId, receiverId: { in: ids } }, { receiverId: viewerId, senderId: { in: ids } }] } }),
      this.prisma.block.findMany({ where: { OR: [{ blockerId: viewerId, blockedId: { in: ids } }, { blockedId: viewerId, blockerId: { in: ids } }] } }),
    ]);
    return users
      .filter((u) => !blocks.some((b) => b.blockerId === u.id)) // users who blocked the viewer are hidden
      .map((u) => {
        let relation: "none" | "friend" | "outgoing" | "incoming" | "blocked" | "self" = "none";
        if (u.id === viewerId) relation = "self";
        else if (blocks.some((b) => b.blockerId === viewerId && b.blockedId === u.id)) relation = "blocked";
        else if (friendships.some((f) => f.userAId === u.id || f.userBId === u.id)) relation = "friend";
        else if (requests.some((r) => r.senderId === viewerId && r.receiverId === u.id)) relation = "outgoing";
        else if (requests.some((r) => r.receiverId === viewerId && r.senderId === u.id)) relation = "incoming";
        return { id: u.id, username: u.username ?? "player", image: u.image, relation };
      });
  }

  async block(userId: string, otherId: string): Promise<void> {
    if (userId === otherId) fail(ErrorCodes.CONFLICT, "You cannot block yourself");
    await this.prisma.block.upsert({ where: { blockerId_blockedId: { blockerId: userId, blockedId: otherId } }, create: { blockerId: userId, blockedId: otherId }, update: {} });
    await this.remove(userId, otherId);
    await this.prisma.challenge.updateMany({
      where: { status: "PENDING", OR: [{ senderId: userId, recipientId: otherId }, { senderId: otherId, recipientId: userId }] },
      data: { status: "CANCELED", respondedAt: new Date() },
    });
  }

  async unblock(userId: string, otherId: string): Promise<void> {
    await this.prisma.block.deleteMany({ where: { blockerId: userId, blockedId: otherId } });
  }

  async report(reporterId: string, payload: { userId: string; gameId?: string; reason: "CHEATING" | "HARASSMENT" | "INAPPROPRIATE_NAME" | "SPAM" | "OTHER"; details?: string }): Promise<void> {
    if (payload.userId === reporterId) fail(ErrorCodes.CONFLICT, "You cannot report yourself");
    const exists = await this.prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true } });
    if (!exists) fail(ErrorCodes.NOT_FOUND, "User not found");
    await this.prisma.report.create({
      data: { reporterId, reportedId: payload.userId, gameId: payload.gameId ?? null, reason: payload.reason, details: payload.details?.slice(0, 1000) ?? null },
    });
  }
}

export const socialRules = SOCIAL_RULES;

import type { Prisma, PrismaClient } from "@tempo/database";
import type { NotificationDTO } from "@tempo/shared";
import type { Emitter } from "./games/emitter";

export type NotificationKind =
  | "FRIEND_REQUEST"
  | "FRIEND_ACCEPTED"
  | "CHALLENGE"
  | "CHALLENGE_ACCEPTED"
  | "CHALLENGE_DECLINED"
  | "REMATCH"
  | "GAME_FINISHED"
  | "ANALYSIS_READY"
  | "SYSTEM";

export class Notifier {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly emitter: Emitter,
  ) {}

  async send(userId: string, type: NotificationKind, payload: Record<string, unknown>, resourceId?: string): Promise<NotificationDTO> {
    const n = await this.prisma.notification.create({
      data: { userId, type, payload: payload as Prisma.InputJsonObject, resourceId: resourceId ?? null },
    });
    const dto: NotificationDTO = {
      id: n.id,
      type: n.type,
      payload: n.payload as Record<string, unknown>,
      resourceId: n.resourceId,
      readAt: null,
      createdAt: n.createdAt.toISOString(),
    };
    this.emitter.toUser(userId, "notification:new", dto);
    const unread = await this.unreadCount(userId);
    this.emitter.toUser(userId, "notification:count", { unread });
    return dto;
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, ids?: string[], all?: boolean): Promise<number> {
    if (all) {
      await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    } else if (ids?.length) {
      await this.prisma.notification.updateMany({ where: { userId, id: { in: ids }, readAt: null }, data: { readAt: new Date() } });
    }
    return this.unreadCount(userId);
  }
}

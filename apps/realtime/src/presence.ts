import type { PrismaClient } from "@tempo/database";
import type { PresenceStatus } from "@tempo/shared";
import type { Emitter } from "./games/emitter";
import type { GameManager } from "./games/GameManager";

/**
 * Tracks which users have live sockets. Single-process authoritative map; when scaling the realtime
 * tier horizontally, back this with Redis (the Socket.IO adapter already fans out user rooms).
 */
export class Presence {
  private readonly sockets = new Map<string, Set<string>>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly friendCache = new Map<string, { ids: string[]; at: number }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly emitter: Emitter,
    private readonly games: GameManager,
  ) {
    games.isUserOnline = (userId) => this.isOnline(userId);
    games.onGameStarted = (game) => {
      void this.broadcast(game.white.id);
      void this.broadcast(game.black.id);
    };
    games.onGameEnded = (game) => {
      void this.broadcast(game.white.id);
      void this.broadcast(game.black.id);
    };
  }

  isOnline(userId: string): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  statusOf(userId: string): { status: PresenceStatus; gameId: string | null } {
    const gameId = this.games.activeGameOf(userId);
    if (gameId) return { status: "playing", gameId };
    return { status: this.isOnline(userId) ? "online" : "offline", gameId: null };
  }

  socketCount(userId: string): number {
    return this.sockets.get(userId)?.size ?? 0;
  }

  async connect(userId: string, socketId: string): Promise<void> {
    const pending = this.offlineTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      this.offlineTimers.delete(userId);
    }
    const set = this.sockets.get(userId) ?? new Set<string>();
    const first = set.size === 0;
    set.add(socketId);
    this.sockets.set(userId, set);
    this.games.userConnected(userId);
    if (first) {
      await this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
      await this.broadcast(userId);
    }
  }

  async disconnect(userId: string, socketId: string): Promise<boolean> {
    const set = this.sockets.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size > 0) return false;
    this.sockets.delete(userId);
    // Grace period avoids flapping during page refreshes.
    const timer = setTimeout(() => {
      this.offlineTimers.delete(userId);
      if (!this.isOnline(userId)) {
        this.games.userDisconnected(userId);
        void this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
        void this.broadcast(userId);
      }
    }, 4000);
    this.offlineTimers.set(userId, timer);
    return true;
  }

  async friendIds(userId: string): Promise<string[]> {
    const cached = this.friendCache.get(userId);
    if (cached && Date.now() - cached.at < 30_000) return cached.ids;
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      select: { userAId: true, userBId: true },
    });
    const ids = rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId));
    this.friendCache.set(userId, { ids, at: Date.now() });
    return ids;
  }

  invalidateFriends(userId: string): void {
    this.friendCache.delete(userId);
  }

  /** Push this user's presence to all their friends. */
  async broadcast(userId: string): Promise<void> {
    const ids = await this.friendIds(userId);
    const { status, gameId } = this.statusOf(userId);
    for (const friendId of ids) {
      this.emitter.toUser(friendId, "friend:presence", { userId, status, gameId });
    }
  }

  onlineCount(): number {
    return this.sockets.size;
  }
}

import type { Redis } from "ioredis";
import type { PrismaClient } from "@tempo/database";
import { isProvisional } from "@tempo/chess-core";
import { ErrorCodes, MATCHMAKING_DEFAULTS, RATING_DEFAULTS, type QueueStatus, type RatingCategory } from "@tempo/shared";
import { fail } from "../errors";
import type { Emitter } from "../games/emitter";
import type { GameManager } from "../games/GameManager";
import { logger } from "../logger";
import type { Presence } from "../presence";
import { getOrCreateRating } from "../ratings/settle";

interface QueueEntry {
  userId: string;
  username: string;
  rating: number;
  deviation: number;
  joinedAt: number;
  /** Users this player must not be paired with (blocks in either direction). */
  blocked: string[];
  lastOpponent: string | null;
}

const PAIR_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 and redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then
  redis.call('HDEL', KEYS[1], ARGV[1], ARGV[2])
  redis.call('DEL', KEYS[2], KEYS[3])
  return 1
end
return 0`;

export class Matchmaker {
  private timer: NodeJS.Timeout | null = null;
  private readonly instanceId = `${process.pid}-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient,
    private readonly games: GameManager,
    private readonly emitter: Emitter,
    private readonly presence: Presence,
    private readonly rangeMode: "min" | "avg" | "max" = "avg",
  ) {}

  private queueKey(category: RatingCategory, rated: boolean): string {
    return `mm:queue:${category}:${rated ? "rated" : "casual"}`;
  }
  private userKey(userId: string): string {
    return `mm:user:${userId}`;
  }

  static rangeFor(waitingMs: number, deviation: number): number {
    const seconds = waitingMs / 1000;
    let range = MATCHMAKING_DEFAULTS.rangeSteps[0]!.range;
    for (const step of MATCHMAKING_DEFAULTS.rangeSteps) {
      if (seconds >= step.afterSeconds) range = step.range;
    }
    if (isProvisional(deviation, RATING_DEFAULTS.provisionalDeviation)) range += MATCHMAKING_DEFAULTS.provisionalBonusRange;
    return range;
  }

  private combinedRange(a: number, b: number): number {
    if (this.rangeMode === "min") return Math.min(a, b);
    if (this.rangeMode === "max") return Math.max(a, b);
    return (a + b) / 2;
  }

  async join(userId: string, username: string, category: RatingCategory, rated: boolean): Promise<QueueStatus> {
    if (this.games.activeGameOf(userId)) fail(ErrorCodes.ALREADY_IN_GAME, "Finish your current game first");
    const existing = await this.redis.get(this.userKey(userId));
    const target = `${category}:${rated}`;
    if (existing && existing !== target) {
      await this.leave(userId, "replaced");
    }
    if (existing === target) {
      const status = await this.statusFor(userId);
      if (status) return status;
    }
    const rating = await getOrCreateRating(this.prisma, userId, category);
    const blocks = await this.prisma.block.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    const blocked = blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId));
    const lastGame = await this.prisma.game.findFirst({
      where: { OR: [{ whiteId: userId }, { blackId: userId }], category, status: { in: ["FINISHED", "ABORTED"] } },
      orderBy: { createdAt: "desc" },
      select: { whiteId: true, blackId: true, endedAt: true },
    });
    const recent = lastGame && lastGame.endedAt && Date.now() - lastGame.endedAt.getTime() < MATCHMAKING_DEFAULTS.rematchCooldownSeconds * 1000;
    const entry: QueueEntry = {
      userId,
      username,
      rating: rating.rating,
      deviation: rating.deviation,
      joinedAt: Date.now(),
      blocked,
      lastOpponent: recent ? (lastGame.whiteId === userId ? lastGame.blackId : lastGame.whiteId) : null,
    };
    await this.redis
      .multi()
      .hset(this.queueKey(category, rated), userId, JSON.stringify(entry))
      .set(this.userKey(userId), target, "EX", 3600)
      .exec();
    logger.info({ userId, category, rated, rating: Math.round(rating.rating) }, "queue join");
    return (await this.statusFor(userId))!;
  }

  async leave(userId: string, reason: "canceled" | "matched" | "disconnected" | "replaced"): Promise<boolean> {
    const target = await this.redis.get(this.userKey(userId));
    if (!target) return false;
    const [category, rated] = target.split(":") as [RatingCategory, string];
    await this.redis
      .multi()
      .hdel(this.queueKey(category, rated === "true"), userId)
      .del(this.userKey(userId))
      .exec();
    this.emitter.toUser(userId, "queue:left", { reason });
    return true;
  }

  async statusFor(userId: string): Promise<QueueStatus | null> {
    const target = await this.redis.get(this.userKey(userId));
    if (!target) return null;
    const [category, ratedStr] = target.split(":") as [RatingCategory, string];
    const rated = ratedStr === "true";
    const key = this.queueKey(category, rated);
    const raw = await this.redis.hget(key, userId);
    if (!raw) return null;
    const entry = JSON.parse(raw) as QueueEntry;
    const waitingMs = Date.now() - entry.joinedAt;
    return {
      category,
      rated,
      joinedAt: entry.joinedAt,
      waitingMs,
      range: Matchmaker.rangeFor(waitingMs, entry.deviation),
      waiting: await this.redis.hlen(key),
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => logger.error({ err }, "matchmaking tick failed")), MATCHMAKING_DEFAULTS.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One matching pass over all queues. Guarded by a Redis lock so only one instance pairs at a time. */
  async tick(): Promise<number> {
    const lock = await this.redis.set("mm:lock", this.instanceId, "PX", 1500, "NX");
    if (!lock) return 0;
    let matched = 0;
    try {
      for (const category of ["BULLET", "BLITZ", "RAPID"] as RatingCategory[]) {
        for (const rated of [true, false]) {
          matched += await this.pairQueue(category, rated);
        }
      }
    } finally {
      const current = await this.redis.get("mm:lock");
      if (current === this.instanceId) await this.redis.del("mm:lock");
    }
    return matched;
  }

  private async pairQueue(category: RatingCategory, rated: boolean): Promise<number> {
    const key = this.queueKey(category, rated);
    const raw = await this.redis.hgetall(key);
    const entries = Object.values(raw)
      .map((v) => JSON.parse(v) as QueueEntry)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    if (!entries.length) return 0;
    const now = Date.now();

    // Drop entries whose owner has no live socket or who started a game elsewhere.
    const alive: QueueEntry[] = [];
    for (const e of entries) {
      if (!this.presence.isOnline(e.userId) || this.games.activeGameOf(e.userId)) {
        await this.redis.multi().hdel(key, e.userId).del(this.userKey(e.userId)).exec();
        continue;
      }
      alive.push(e);
    }

    const taken = new Set<string>();
    let matched = 0;
    for (const a of alive) {
      if (taken.has(a.userId)) continue;
      const rangeA = Matchmaker.rangeFor(now - a.joinedAt, a.deviation);
      let best: { entry: QueueEntry; diff: number } | null = null;
      let fallback: { entry: QueueEntry; diff: number } | null = null;
      for (const b of alive) {
        if (b.userId === a.userId || taken.has(b.userId)) continue;
        if (a.blocked.includes(b.userId) || b.blocked.includes(a.userId)) continue;
        const rangeB = Matchmaker.rangeFor(now - b.joinedAt, b.deviation);
        const diff = Math.abs(a.rating - b.rating);
        if (diff > this.combinedRange(rangeA, rangeB)) continue;
        const isRecentOpponent = a.lastOpponent === b.userId || b.lastOpponent === a.userId;
        const candidate = { entry: b, diff };
        if (isRecentOpponent) {
          if (!fallback || diff < fallback.diff) fallback = candidate;
          continue;
        }
        if (!best || diff < best.diff) best = candidate;
      }
      // Re-pair recent opponents only when nobody else is available and the player has waited a while.
      const chosen = best ?? (fallback && now - a.joinedAt > MATCHMAKING_DEFAULTS.rematchCooldownSeconds * 1000 ? fallback : null);
      if (!chosen) continue;
      const removed = await this.redis.eval(PAIR_SCRIPT, 3, key, this.userKey(a.userId), this.userKey(chosen.entry.userId), a.userId, chosen.entry.userId);
      if (removed !== 1) continue; // someone else removed one of them concurrently
      taken.add(a.userId);
      taken.add(chosen.entry.userId);
      await this.createMatch(a, chosen.entry, category, rated);
      matched++;
    }

    // Status updates for everyone still waiting.
    for (const e of alive) {
      if (taken.has(e.userId)) continue;
      const waitingMs = now - e.joinedAt;
      this.emitter.toUser(e.userId, "queue:status", {
        category,
        rated,
        joinedAt: e.joinedAt,
        waitingMs,
        range: Matchmaker.rangeFor(waitingMs, e.deviation),
        waiting: alive.length - taken.size,
      });
    }
    return matched;
  }

  private async createMatch(a: QueueEntry, b: QueueEntry, category: RatingCategory, rated: boolean): Promise<void> {
    const whiteFirst = Math.random() < 0.5;
    const white = whiteFirst ? a : b;
    const black = whiteFirst ? b : a;
    try {
      const game = await this.games.createGame({ whiteId: white.userId, blackId: black.userId, category, rated, source: "MATCHMAKING" });
      this.emitter.toUser(white.userId, "queue:left", { reason: "matched" });
      this.emitter.toUser(black.userId, "queue:left", { reason: "matched" });
      this.emitter.toUser(white.userId, "match:found", {
        gameId: game.id,
        color: "white",
        opponent: { id: black.userId, username: black.username, rating: Math.round(black.rating) },
        category,
        source: "MATCHMAKING",
      });
      this.emitter.toUser(black.userId, "match:found", {
        gameId: game.id,
        color: "black",
        opponent: { id: white.userId, username: white.username, rating: Math.round(white.rating) },
        category,
        source: "MATCHMAKING",
      });
      logger.info({ gameId: game.id, a: a.username, b: b.username, diff: Math.abs(a.rating - b.rating), category }, "matched");
    } catch (err) {
      logger.error({ err, a: a.userId, b: b.userId }, "failed to create match; players must re-queue");
      this.emitter.toUser(a.userId, "queue:left", { reason: "canceled" });
      this.emitter.toUser(b.userId, "queue:left", { reason: "canceled" });
    }
  }

  async waitingCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const category of ["BULLET", "BLITZ", "RAPID"] as RatingCategory[]) {
      for (const rated of [true, false]) {
        out[`${category}:${rated ? "rated" : "casual"}`] = await this.redis.hlen(this.queueKey(category, rated));
      }
    }
    return out;
  }
}

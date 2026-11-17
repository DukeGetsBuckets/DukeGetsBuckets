import http from "node:http";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createPrismaClient } from "@tempo/database";
import { APP_NAME, GAME_RULES } from "@tempo/shared";
import { verifySocketToken } from "./auth";
import { allowedOrigins, env } from "./env";
import type { Emitter } from "./games/emitter";
import { logger } from "./logger";
import { EVENTS_CHANNEL, createRedis, redis, type BusEvent } from "./redis";
import { createServices } from "./services";
import { registerSocketHandlers, type TypedServer } from "./sockets/register";

async function main(): Promise<void> {
  const prisma = createPrismaClient({ maxConnections: Number(process.env.DATABASE_POOL_MAX ?? 10) });
  await prisma.$queryRaw`SELECT 1`;
  await redis.ping();

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: "64kb" }));

  const server = http.createServer(app);
  const io: TypedServer = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true },
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64 * 1024,
    connectionStateRecovery: { maxDisconnectionDuration: 60_000 },
  });

  if (env.REALTIME_REDIS_ADAPTER) {
    const pub = createRedis("adapter-pub");
    const sub = createRedis("adapter-sub");
    io.adapter(createAdapter(pub, sub));
    logger.info("socket.io redis adapter enabled");
  }

  const emitter: Emitter = {
    toGame: (gameId, event, ...args) => {
      (io.to(`game:${gameId}`).emit as (...a: unknown[]) => void)(event, ...args);
    },
    toUser: (userId, event, ...args) => {
      (io.to(`user:${userId}`).emit as (...a: unknown[]) => void)(event, ...args);
    },
  };

  const services = createServices(prisma, redis, emitter, env.MATCHMAKING_RANGE_MODE);
  const loaded = await services.games.loadActiveGames();
  logger.info({ loaded }, "active games restored from database");

  // Authentication: every socket must present a valid short-lived token.
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
      if (!token) return next(new Error("UNAUTHORIZED"));
      const user = await verifySocketToken(token);
      const banned = await prisma.user.findUnique({ where: { id: user.id }, select: { banned: true, banExpiresAt: true, username: true } });
      if (!banned) return next(new Error("UNAUTHORIZED"));
      if (banned.banned && (!banned.banExpiresAt || banned.banExpiresAt > new Date())) return next(new Error("BANNED"));
      socket.data.user = { id: user.id, username: banned.username ?? user.username };
      next();
    } catch (err) {
      logger.debug({ err }, "socket auth failed");
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user;
    // Register handlers synchronously so no event emitted right after "connect" is lost.
    registerSocketHandlers(io, socket, services);
    void socket.join(`user:${user.id}`);
    await services.presence.connect(user.id, socket.id);
    const unread = await services.notifier.unreadCount(user.id).catch(() => 0);
    socket.emit("notification:count", { unread });
    const queued = await services.matchmaker.statusFor(user.id).catch(() => null);
    if (queued) socket.emit("queue:status", queued);
    logger.debug({ userId: user.id, socketId: socket.id }, "socket connected");
  });

  // Cross-service bus: worker/web publish events the realtime tier relays to users.
  const bus = createRedis("bus");
  await bus.subscribe(EVENTS_CHANNEL);
  bus.on("message", (_channel, message) => {
    try {
      const event = JSON.parse(message) as BusEvent;
      if (event.type === "analysis:progress" && event.gameId) {
        const payload = { gameId: event.gameId, status: String(event.payload?.status ?? ""), progress: Number(event.payload?.progress ?? 0) };
        io.to(`analysis:${event.gameId}`).emit("analysis:progress", payload);
        io.to(`game:${event.gameId}`).emit("analysis:progress", payload);
      } else if (event.type === "notification" && event.userId && event.payload) {
        void services.notifier.send(event.userId, (event.payload.type as "ANALYSIS_READY") ?? "SYSTEM", (event.payload.data as Record<string, unknown>) ?? {}, event.payload.resourceId as string | undefined);
      }
    } catch (err) {
      logger.warn({ err }, "bad bus message");
    }
  });

  services.matchmaker.start();
  services.challenges.start();
  const clockTimer = setInterval(() => services.games.broadcastClocks(), GAME_RULES.clockSyncIntervalMs);

  app.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      service: `${APP_NAME} realtime`,
      uptime: process.uptime(),
      activeGames: services.games.activeCount(),
      online: services.presence.onlineCount(),
      queues: await services.matchmaker.waitingCounts(),
    });
  });

  server.listen(env.REALTIME_PORT, () => logger.info({ port: env.REALTIME_PORT, origins: allowedOrigins }, "realtime service listening"));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    clearInterval(clockTimer);
    services.matchmaker.stop();
    services.challenges.stop();
    io.close();
    server.close();
    await prisma.$disconnect().catch(() => undefined);
    redis.disconnect();
    bus.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "realtime failed to start");
  process.exit(1);
});

import type { Server, Socket } from "socket.io";
import type { z } from "zod";
import {
  ErrorCodes,
  blockUserSchema,
  challengeCreateSchema,
  challengeTargetSchema,
  friendRemoveSchema,
  friendRequestSchema,
  friendRespondSchema,
  gameChatSendSchema,
  gameDrawClaimSchema,
  gameDrawRespondSchema,
  gameIdOnlySchema,
  gameJoinSchema,
  gameMoveSubmitSchema,
  gamePremoveSetSchema,
  gameRematchRespondSchema,
  idSchema,
  notificationReadSchema,
  queueJoinSchema,
  reportUserSchema,
  userSearchSchema,
  type Ack,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@tempo/shared";
import type { SocketUser } from "../auth";
import { AppError, toAck } from "../errors";
import { logger } from "../logger";
import { rateLimiter } from "../ratelimit";
import type { Services } from "../services";

export type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: SocketUser }>;
export type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: SocketUser }>;

type AckFn = (r: Ack<never> | Ack<Record<string, unknown>>) => void;

function guard<S extends z.ZodTypeAny>(
  socket: TypedSocket,
  event: string,
  schema: S,
  handler: (data: z.infer<S>, user: SocketUser) => Promise<Record<string, unknown> | void>,
) {
  return async (payload: unknown, ack?: unknown) => {
    const reply: AckFn = typeof ack === "function" ? (ack as AckFn) : () => undefined;
    const user = socket.data.user;
    try {
      if (!rateLimiter.allow(user.id, event)) throw new AppError(ErrorCodes.RATE_LIMITED, "Slow down a little");
      const parsed = schema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw new AppError(ErrorCodes.INVALID_PAYLOAD, parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; "));
      }
      const result = await handler(parsed.data, user);
      reply({ ok: true, ...(result ?? {}) } as Ack<Record<string, unknown>>);
    } catch (err) {
      if (!(err instanceof AppError)) logger.error({ err, event, userId: user.id }, "socket handler error");
      reply(toAck(err));
    }
  };
}

export function registerSocketHandlers(io: TypedServer, socket: TypedSocket, services: Services): void {
  const { games, matchmaker, friends, challenges, notifier, presence } = services;
  const user = socket.data.user;

  // ───── Matchmaking ─────
  socket.on(
    "queue:join",
    guard(socket, "queue:join", queueJoinSchema, async (data) => {
      const status = await matchmaker.join(user.id, user.username, data.category, data.rated);
      return { status };
    }),
  );
  socket.on(
    "queue:cancel",
    guard(socket, "queue:cancel", gameIdOnlySchema.partial(), async () => {
      await matchmaker.leave(user.id, "canceled");
    }),
  );

  // ───── Games ─────
  socket.on(
    "game:join",
    guard(socket, "game:join", gameJoinSchema, async (data) => {
      const snapshot = await games.getSnapshot(data.gameId, user.id);
      await socket.join(`game:${data.gameId}`);
      return { snapshot };
    }),
  );
  socket.on(
    "game:leave",
    guard(socket, "game:leave", gameJoinSchema, async (data) => {
      await socket.leave(`game:${data.gameId}`);
    }),
  );
  socket.on(
    "game:move:submit",
    guard(socket, "game:move:submit", gameMoveSubmitSchema, async (data) => {
      try {
        const result = await games.submitMove(data.gameId, user.id, data.uci, data.expectedPly, data.actionId);
        return { ...result };
      } catch (err) {
        if (err instanceof AppError) {
          socket.emit("game:move:rejected", {
            gameId: data.gameId,
            actionId: data.actionId,
            code: err.code,
            message: err.message,
            ply: typeof err.meta?.ply === "number" ? err.meta.ply : -1,
          });
        }
        throw err;
      }
    }),
  );
  socket.on(
    "game:premove:set",
    guard(socket, "game:premove:set", gamePremoveSetSchema, async (data) => {
      await games.setPremove(data.gameId, user.id, data.uci);
    }),
  );
  socket.on("game:resign", guard(socket, "game:resign", gameIdOnlySchema, async (data) => games.resign(data.gameId, user.id)));
  socket.on("game:abort", guard(socket, "game:abort", gameIdOnlySchema, async (data) => games.abort(data.gameId, user.id)));
  socket.on("game:draw:offer", guard(socket, "game:draw:offer", gameIdOnlySchema, async (data) => games.offerDraw(data.gameId, user.id)));
  socket.on("game:draw:respond", guard(socket, "game:draw:respond", gameDrawRespondSchema, async (data) => games.respondDraw(data.gameId, user.id, data.accept)));
  socket.on("game:draw:claim", guard(socket, "game:draw:claim", gameDrawClaimSchema, async (data) => games.claimDraw(data.gameId, user.id, data.kind)));
  socket.on("game:claim:victory", guard(socket, "game:claim:victory", gameIdOnlySchema, async (data) => games.claimVictory(data.gameId, user.id)));
  socket.on(
    "game:rematch:request",
    guard(socket, "game:rematch:request", gameIdOnlySchema, async (data) => {
      const r = await games.requestRematch(data.gameId, user.id);
      return { ...r };
    }),
  );
  socket.on(
    "game:rematch:respond",
    guard(socket, "game:rematch:respond", gameRematchRespondSchema, async (data) => {
      const r = await games.respondRematch(data.gameId, user.id, data.accept);
      return { ...r };
    }),
  );
  socket.on("game:chat:send", guard(socket, "game:chat:send", gameChatSendSchema, async (data) => games.chat(data.gameId, user.id, data.text)));
  socket.on(
    "game:clock:ping",
    guard(socket, "game:clock:ping", gameIdOnlySchema, async (data) => {
      const live = games.getLive(data.gameId);
      if (!live) throw new AppError(ErrorCodes.NOT_FOUND, "Game not live");
      return { clock: live.clockState() };
    }),
  );

  // ───── Friends ─────
  socket.on("friend:request", guard(socket, "friend:request", friendRequestSchema, async (data) => friends.sendRequest(user.id, user.username, data)));
  socket.on(
    "friend:accept",
    guard(socket, "friend:accept", friendRespondSchema, async (data) => {
      const friend = await friends.accept(user.id, data.requestId);
      return { friend };
    }),
  );
  socket.on("friend:decline", guard(socket, "friend:decline", friendRespondSchema, async (data) => friends.decline(user.id, data.requestId)));
  socket.on("friend:cancel", guard(socket, "friend:cancel", friendRespondSchema, async (data) => friends.cancel(user.id, data.requestId)));
  socket.on("friend:remove", guard(socket, "friend:remove", friendRemoveSchema, async (data) => friends.remove(user.id, data.userId)));
  socket.on(
    "friend:list",
    guard(socket, "friend:list", gameIdOnlySchema.partial(), async () => {
      const list = await friends.list(user.id);
      return { friends: list };
    }),
  );
  socket.on(
    "user:search",
    guard(socket, "user:search", userSearchSchema, async (data) => {
      const users = await friends.search(user.id, data.query);
      return { users };
    }),
  );
  socket.on("user:block", guard(socket, "user:block", blockUserSchema, async (data) => friends.block(user.id, data.userId)));
  socket.on("user:unblock", guard(socket, "user:unblock", blockUserSchema, async (data) => friends.unblock(user.id, data.userId)));
  socket.on("user:report", guard(socket, "user:report", reportUserSchema, async (data) => friends.report(user.id, data)));

  // ───── Challenges ─────
  socket.on(
    "challenge:create",
    guard(socket, "challenge:create", challengeCreateSchema, async (data) => {
      const r = await challenges.create(user.id, data);
      return { challenge: r.challenge, note: r.note };
    }),
  );
  socket.on(
    "challenge:accept",
    guard(socket, "challenge:accept", challengeTargetSchema, async (data) => {
      const r = await challenges.accept(user.id, data);
      return { ...r };
    }),
  );
  socket.on("challenge:decline", guard(socket, "challenge:decline", idSchema.transform((v) => ({ challengeId: v })).or(gameIdOnlySchema.extend({ challengeId: idSchema }).pick({ challengeId: true })), async (data) => challenges.decline(user.id, data.challengeId)));
  socket.on("challenge:cancel", guard(socket, "challenge:cancel", gameIdOnlySchema.extend({ challengeId: idSchema }).pick({ challengeId: true }), async (data) => challenges.cancel(user.id, data.challengeId)));

  // ───── Notifications / misc ─────
  socket.on(
    "notification:read",
    guard(socket, "notification:read", notificationReadSchema, async (data) => {
      const unread = await notifier.markRead(user.id, data.ids, data.all);
      return { unread };
    }),
  );
  socket.on(
    "analysis:subscribe",
    guard(socket, "analysis:subscribe", gameJoinSchema, async (data) => {
      await socket.join(`analysis:${data.gameId}`);
    }),
  );

  // ───── Lifecycle ─────
  socket.on("disconnect", async (reason) => {
    const last = await presence.disconnect(user.id, socket.id);
    if (last && presence.socketCount(user.id) === 0) {
      // Queue entries must not outlive the player's connection.
      setTimeout(() => {
        if (!presence.isOnline(user.id)) void matchmaker.leave(user.id, "disconnected");
      }, 5000).unref();
    }
    logger.debug({ userId: user.id, socketId: socket.id, reason }, "socket disconnected");
  });

  // Server-side RTT measurement for lag compensation.
  const pingTimer = setInterval(() => {
    const started = Date.now();
    socket.timeout(5000).emit("server:ping", (err: Error | null) => {
      if (err) return;
      const rtt = Date.now() - started;
      games.setLag(user.id, rtt / 2);
    });
  }, 10_000);
  socket.once("disconnect", () => clearInterval(pingTimer));
  void io;
}

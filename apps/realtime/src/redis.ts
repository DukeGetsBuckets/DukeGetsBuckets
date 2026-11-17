import { Redis } from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

export function createRedis(name: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on("error", (err) => logger.error({ err, name }, "redis error"));
  client.on("reconnecting", () => logger.warn({ name }, "redis reconnecting"));
  return client;
}

export const redis = createRedis("main");

/** Channel used for cross-service events (worker/web → realtime). */
export const EVENTS_CHANNEL = "tempo:events";

export interface BusEvent {
  type: "notification" | "analysis:progress" | "presence:refresh";
  userId?: string;
  gameId?: string;
  payload?: Record<string, unknown>;
}

import type { PrismaClient } from "@tempo/database";
import type { Redis } from "ioredis";
import { ChallengeService } from "./challenges/service";
import { FriendService } from "./friends/service";
import type { Emitter } from "./games/emitter";
import { GameManager } from "./games/GameManager";
import { Matchmaker } from "./matchmaking/Matchmaker";
import { Notifier } from "./notifications";
import { Presence } from "./presence";

export interface Services {
  games: GameManager;
  matchmaker: Matchmaker;
  friends: FriendService;
  challenges: ChallengeService;
  notifier: Notifier;
  presence: Presence;
}

export function createServices(prisma: PrismaClient, redis: Redis, emitter: Emitter, rangeMode: "min" | "avg" | "max" = "avg"): Services {
  const notifier = new Notifier(prisma, emitter);
  const games = new GameManager(prisma, emitter, notifier);
  const presence = new Presence(prisma, emitter, games);
  const matchmaker = new Matchmaker(redis, prisma, games, emitter, presence, rangeMode);
  const friends = new FriendService(prisma, emitter, notifier, presence);
  const challenges = new ChallengeService(prisma, emitter, notifier, games, friends);
  return { games, matchmaker, friends, challenges, notifier, presence };
}

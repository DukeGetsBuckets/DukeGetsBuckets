import "dotenv/config";
// Usage: pnpm exec tsx tools/analyze-game.mts [gameId]  — enqueues a Stockfish review and prints the stored result.
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { createPrismaClient } from "@tempo/database";

const prisma = createPrismaClient({ maxConnections: 2 });
const wanted = process.argv[2];
const game = wanted
  ? await prisma.game.findUnique({ where: { id: wanted }, select: { id: true, ply: true, result: true, endReason: true } })
  : await prisma.game.findFirst({ where: { status: "FINISHED", ply: { gte: 4 } }, orderBy: { ply: "desc" }, select: { id: true, ply: true, result: true, endReason: true } });
if (!game) throw new Error("no finished game");
console.log("analyzing", game);
const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const queue = new Queue("analysis", { connection });
const events = new QueueEvents("analysis", { connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }) });
await prisma.gameAnalysis.upsert({ where: { gameId: game.id }, create: { gameId: game.id, status: "QUEUED", config: {} }, update: { status: "QUEUED", progress: 0, error: null } });
const old = await queue.getJob(game.id);
if (old) await old.remove().catch(() => undefined);
const job = await queue.add("game", { type: "game", gameId: game.id, requestedById: null }, { jobId: game.id, attempts: 1 });
const t0 = Date.now();
await job.waitUntilFinished(events, 300_000);
console.log("done in", Date.now() - t0, "ms");
const a = await prisma.gameAnalysis.findUniqueOrThrow({ where: { gameId: game.id }, include: { moves: { orderBy: { ply: "asc" } } } });
console.log("status", a.status, "acc", a.whiteAccuracy, a.blackAccuracy, "acpl", a.whiteAcpl, a.blackAcpl, "engine", a.engine, a.engineVersion);
for (const m of a.moves) console.log(`${m.ply}. ${m.playedSan.padEnd(6)} ${m.classification.padEnd(10)} eval ${m.mateBefore != null ? "M" + m.mateBefore : m.evalBefore}→${m.mateAfter != null ? "M" + m.mateAfter : m.evalAfter} best=${m.bestSan} loss=${m.cpLoss} | ${m.explanation}`);
const s = a.summary as any;
console.log("summary.turningPoint", s.turningPoint, "opening", s.opening, "winChances", s.winChances);
const c = a.coaching as any;
console.log("coaching(white):", JSON.stringify(c.white, null, 1).slice(0, 1200));
const tp = await prisma.trainingPosition.findMany({ where: { gameId: game.id } });
console.log("training positions:", tp.map((t) => ({ ply: t.ply, best: t.bestUci, played: t.playedUci, cls: t.classification, theme: t.theme })));
await queue.close(); await events.close(); await prisma.$disconnect(); connection.disconnect(); process.exit(0);

import http from "node:http";
import { Queue, QueueEvents, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createPrismaClient } from "@tempo/database";
import { ANALYSIS_QUEUE, POSITION_QUEUE, type AnalysisJobData } from "@tempo/shared";
import { analyzeGame, evaluatePosition, type AnalysisContext } from "./analysis/analyzeGame";
import { EnginePool } from "./engine/pool";
import { env } from "./env";
import { logger } from "./logger";

const EVENTS_CHANNEL = "tempo:events";

async function main(): Promise<void> {
  const prisma = createPrismaClient({ maxConnections: 4 });
  await prisma.$queryRaw`SELECT 1`;
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const publisher = new Redis(env.REDIS_URL);
  const cache = new Redis(env.REDIS_URL);

  const pool = new EnginePool(env.WORKER_CONCURRENCY + 1, { path: env.STOCKFISH_PATH, threads: env.STOCKFISH_THREADS, hashMb: env.STOCKFISH_HASH_MB });
  await pool.start();

  const ctx: AnalysisContext = {
    prisma,
    pool,
    redis: cache,
    config: { depth: env.ANALYSIS_DEPTH, multipv: env.ANALYSIS_MULTIPV, movetimeMs: env.ANALYSIS_MOVETIME_MS },
    publish: (event) => void publisher.publish(EVENTS_CHANNEL, JSON.stringify(event)).catch((err) => logger.warn({ err }, "publish failed")),
  };

  const gameWorker = new Worker<AnalysisJobData>(
    ANALYSIS_QUEUE,
    async (job: Job<AnalysisJobData>) => {
      if (job.data.type !== "game") throw new Error("Unexpected job type");
      logger.info({ gameId: job.data.gameId, attempt: job.attemptsMade + 1 }, "analysis job started");
      await analyzeGame(ctx, job.data.gameId, job.data.requestedById, (p) => job.updateProgress(p));
      return { ok: true };
    },
    { connection, concurrency: env.WORKER_CONCURRENCY, lockDuration: 120_000, stalledInterval: 60_000 },
  );
  gameWorker.on("failed", (job, err) => logger.error({ jobId: job?.id, err: err.message, attempts: job?.attemptsMade }, "analysis job failed"));
  gameWorker.on("error", (err) => logger.error({ err }, "worker error"));

  // Short, bounded position evaluations for the standalone analysis board (never for live games).
  const positionWorker = new Worker<AnalysisJobData>(
    POSITION_QUEUE,
    async (job) => {
      if (job.data.type !== "position") throw new Error("Unexpected job type");
      const depth = Math.min(job.data.depth, 20);
      const result = await evaluatePosition(ctx, job.data.fen, { depth, multipv: Math.min(job.data.multipv, 3), movetimeMs: 0 });
      return result;
    },
    { connection, concurrency: 1 },
  );
  positionWorker.on("error", (err) => logger.error({ err }, "position worker error"));

  // Observability
  const analysisQueue = new Queue(ANALYSIS_QUEUE, { connection });
  const server = http.createServer(async (_req, res) => {
    const counts = await analysisQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed").catch(() => ({}));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "worker", engine: pool.info, config: ctx.config, concurrency: env.WORKER_CONCURRENCY, queue: counts, uptime: process.uptime() }));
  });
  server.listen(env.WORKER_HEALTH_PORT, () => logger.info({ port: env.WORKER_HEALTH_PORT, engine: pool.info, config: ctx.config }, "worker listening"));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    server.close();
    await Promise.allSettled([gameWorker.close(), positionWorker.close(), analysisQueue.close()]);
    await pool.quit();
    await prisma.$disconnect();
    connection.disconnect();
    publisher.disconnect();
    cache.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  void QueueEvents;
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});

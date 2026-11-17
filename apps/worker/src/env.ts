import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  STOCKFISH_PATH: z.string().default("/usr/games/stockfish"),
  STOCKFISH_THREADS: z.coerce.number().int().min(1).max(64).default(2),
  STOCKFISH_HASH_MB: z.coerce.number().int().min(16).max(4096).default(128),
  ANALYSIS_DEPTH: z.coerce.number().int().min(6).max(40).default(16),
  ANALYSIS_MOVETIME_MS: z.coerce.number().int().min(0).default(0),
  ANALYSIS_MULTIPV: z.coerce.number().int().min(1).max(5).default(2),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  WORKER_HEALTH_PORT: z.coerce.number().int().default(4100),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid worker environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
}
export const env = parsed.data;

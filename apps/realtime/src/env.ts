import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  REALTIME_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  REALTIME_JWT_SECRET: z.string().min(16, "REALTIME_JWT_SECRET must be at least 16 characters"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  REALTIME_REDIS_ADAPTER: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  LOG_LEVEL: z.string().default("info"),
  INTERNAL_API_SECRET: z.string().optional(),
  /** min | avg | max — how the two players' rating windows combine when pairing. */
  MATCHMAKING_RANGE_MODE: z.enum(["min", "avg", "max"]).default("avg"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid realtime environment: ${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();
export const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

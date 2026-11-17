import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

export * from "../generated/prisma/client.ts";
export { Prisma } from "../generated/prisma/client.ts";

declare global {
  var __tempoPrisma: PrismaClient | undefined;
}

export interface CreatePrismaOptions {
  connectionString?: string;
  /** Max pooled connections for this process (default 10). */
  maxConnections?: number;
  log?: ("query" | "info" | "warn" | "error")[];
}

export function createPrismaClient(opts: CreatePrismaOptions = {}): PrismaClient {
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const adapter = new PrismaPg({
    connectionString,
    max: opts.maxConnections ?? Number(process.env.DATABASE_POOL_MAX ?? 10),
  });
  return new PrismaClient({
    adapter,
    log: opts.log ?? (process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]),
  });
}

/**
 * Process-wide singleton. In development (Next.js hot reload) the instance is cached on globalThis
 * to avoid exhausting the connection pool.
 */
export function getPrisma(): PrismaClient {
  if (!globalThis.__tempoPrisma) {
    globalThis.__tempoPrisma = createPrismaClient();
  }
  return globalThis.__tempoPrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrisma();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { io as ioClient, type Socket } from "socket.io-client";
import type { AckOf, ClientToServerEvents, ServerToClientEvents } from "@tempo/shared";
import { createPrismaClient, type PrismaClient } from "@tempo/database";

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const REALTIME_URL = process.env.REALTIME_URL ?? "http://localhost:4000";

let prismaSingleton: PrismaClient | null = null;
export function testPrisma(): PrismaClient {
  if (!prismaSingleton) prismaSingleton = createPrismaClient({ maxConnections: 4 });
  return prismaSingleton;
}

export async function mintToken(userId: string, username: string): Promise<string> {
  const secret = new TextEncoder().encode(process.env.REALTIME_JWT_SECRET!);
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setAudience("tempo-realtime")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

/** Creates a real user row (as Better Auth would) for integration tests. */
export async function createTestUser(prefix = "it"): Promise<{ id: string; username: string; token: string }> {
  const prisma = testPrisma();
  const suffix = randomUUID().slice(0, 8);
  const username = `${prefix}_${suffix}`.toLowerCase();
  const user = await prisma.user.create({
    data: { id: randomUUID(), name: username, email: `${username}@test.local`, emailVerified: true, username, displayUsername: username },
  });
  return { id: user.id, username, token: await mintToken(user.id, username) };
}

export function connect(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket: ClientSocket = ioClient(REALTIME_URL, { auth: { token }, transports: ["websocket"], reconnection: true, forceNew: true });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
    socket.on("server:ping", (ack) => ack());
  });
}

export function emitAck<E extends keyof ClientToServerEvents>(
  socket: ClientSocket,
  event: E,
  payload: Parameters<ClientToServerEvents[E]>[0],
): Promise<AckOf<E>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${String(event)}`)), 10_000);
    (socket.emit as (...a: unknown[]) => void)(event, payload, (r: unknown) => {
      clearTimeout(timer);
      resolve(r as AckOf<E>);
    });
  });
}

export function waitFor<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  predicate?: (payload: Parameters<ServerToClientEvents[E]>[0]) => boolean,
  timeoutMs = 15_000,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      (socket.off as (...a: unknown[]) => void)(event, handler);
      reject(new Error(`timeout waiting for ${String(event)}`));
    }, timeoutMs);
    const handler = (payload: Parameters<ServerToClientEvents[E]>[0]) => {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      (socket.off as (...a: unknown[]) => void)(event, handler);
      resolve(payload);
    };
    (socket.on as (...a: unknown[]) => void)(event, handler);
  });
}

export function actionId(): string {
  return randomUUID();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

"use client";

import { io, type Socket } from "socket.io-client";
import type { AckOf, ClientToServerEvents, ServerToClientEvents } from "@tempo/shared";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let cached: { socket: AppSocket; url: string } | null = null;

async function fetchToken(): Promise<{ token: string; realtimeUrl: string }> {
  const res = await fetch("/api/realtime/token", { cache: "no-store" });
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}

/** One shared authenticated socket per tab. The token is refreshed on every (re)connect attempt. */
export async function getSocket(): Promise<AppSocket> {
  if (cached) return cached.socket;
  const { realtimeUrl } = await fetchToken();
  const socket: AppSocket = io(realtimeUrl, {
    autoConnect: false,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    withCredentials: true,
    auth: (cb) => {
      fetchToken()
        .then(({ token }) => cb({ token }))
        .catch(() => cb({ token: "" }));
    },
  });
  socket.on("server:ping", (ack) => ack());
  socket.connect();
  cached = { socket, url: realtimeUrl };
  return socket;
}

export function disposeSocket(): void {
  cached?.socket.disconnect();
  cached = null;
}

/** Promise wrapper around an acknowledged emit, with timeout. */
export function emitWithAck<E extends keyof ClientToServerEvents>(
  socket: AppSocket,
  event: E,
  payload: Parameters<ClientToServerEvents[E]>[0],
  timeoutMs = 8000,
): Promise<AckOf<E>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { code: "TIMEOUT", message: "The server did not respond in time" } } as AckOf<E>), timeoutMs);
    (socket.emit as (...a: unknown[]) => void)(event, payload, (r: unknown) => {
      clearTimeout(timer);
      resolve(r as AckOf<E>);
    });
  });
}

// Load test: N simulated players queue for blitz and play random legal moves against each other.
// Usage: PLAYERS=40 DURATION_S=60 node tests/load/socket-load.mjs   (realtime + db must be running)
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { io } from "socket.io-client";
import { Chess } from "chess.js";
import { createPrismaClient } from "@tempo/database";
import "dotenv/config";

const PLAYERS = Number(process.env.PLAYERS ?? 20);
const DURATION_S = Number(process.env.DURATION_S ?? 45);
const URL = process.env.REALTIME_URL ?? "http://localhost:4000";
const prisma = createPrismaClient({ maxConnections: 4 });
const secret = new TextEncoder().encode(process.env.REALTIME_JWT_SECRET);

const stats = { moves: 0, rejected: 0, matched: 0, finished: 0, latencies: [] };

async function makePlayer(i) {
  const username = `load_${Date.now().toString(36)}_${i}`;
  const user = await prisma.user.create({ data: { id: randomUUID(), name: username, email: `${username}@load.local`, emailVerified: true, username, displayUsername: username } });
  const token = await new SignJWT({ username }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setAudience("tempo-realtime").setIssuedAt().setExpirationTime("1h").sign(secret);
  const socket = io(URL, { auth: { token }, transports: ["websocket"] });
  socket.on("server:ping", (ack) => ack());
  const chess = new Chess();
  let gameId = null;
  let color = null;
  const emitAck = (ev, payload) => new Promise((res) => socket.emit(ev, payload, res));
  const tryMove = async () => {
    if (!gameId || chess.turn() !== (color === "white" ? "w" : "b") || chess.isGameOver()) return;
    const moves = chess.moves({ verbose: true });
    const m = moves[Math.floor(Math.random() * moves.length)];
    const uci = `${m.from}${m.to}${m.promotion ?? ""}`;
    const t0 = Date.now();
    const r = await emitAck("game:move:submit", { gameId, uci, expectedPly: chess.history().length, actionId: randomUUID() });
    stats.latencies.push(Date.now() - t0);
    if (r.ok) stats.moves++;
    else stats.rejected++;
  };
  socket.on("match:found", async (m) => {
    stats.matched++;
    gameId = m.gameId;
    color = m.color;
    chess.reset();
    await emitAck("game:join", { gameId });
    setTimeout(tryMove, 50 + Math.random() * 200);
  });
  socket.on("game:move:accepted", (p) => {
    if (p.gameId !== gameId) return;
    if (chess.history().length < p.ply) chess.move({ from: p.uci.slice(0, 2), to: p.uci.slice(2, 4), promotion: p.uci[4] });
    if (!p.finished) setTimeout(tryMove, 50 + Math.random() * 300);
  });
  socket.on("game:finished", async () => {
    stats.finished++;
    gameId = null;
    setTimeout(() => emitAck("queue:join", { category: "BLITZ", rated: false }), 200);
  });
  await new Promise((res, rej) => {
    socket.once("connect", res);
    socket.once("connect_error", rej);
  });
  await emitAck("queue:join", { category: "BLITZ", rated: false });
  return socket;
}

const t0 = Date.now();
const sockets = await Promise.all(Array.from({ length: PLAYERS }, (_, i) => makePlayer(i)));
console.log(`${PLAYERS} players connected and queued in ${Date.now() - t0} ms`);
await new Promise((r) => setTimeout(r, DURATION_S * 1000));
for (const s of sockets) s.disconnect();
const sorted = stats.latencies.sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
console.log(JSON.stringify({ players: PLAYERS, seconds: DURATION_S, matched: stats.matched, finished: stats.finished, moves: stats.moves, rejected: stats.rejected, movesPerSecond: Math.round(stats.moves / DURATION_S), ackLatencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: sorted.at(-1) ?? 0 } }, null, 2));
await prisma.$disconnect();
process.exit(0);

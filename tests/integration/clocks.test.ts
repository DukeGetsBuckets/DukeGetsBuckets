import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { actionId, connect, createTestUser, emitAck, sleep, testPrisma, waitFor, type ClientSocket } from "../helpers/realtime";

const REPO = path.resolve(import.meta.dirname, "../..");

describe("clocks, timeouts and restart recovery", () => {
  const prisma = testPrisma();
  const sockets: ClientSocket[] = [];
  let child: ChildProcess | null = null;
  afterAll(() => {
    sockets.forEach((s) => s.disconnect());
    child?.kill("SIGTERM");
  });

  it("enforces a bullet timeout on the server and a flagged move is rejected", async () => {
    const a = await createTestUser("clk_a");
    const b = await createTestUser("clk_b");
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    sockets.push(sa, sb);
    const ch = await emitAck(sa, "challenge:create", { recipientId: b.id, category: "BULLET", rated: true, color: "WHITE" });
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    const acc = await emitAck(sb, "challenge:accept", { challengeId: ch.challenge.id });
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    const gameId = acc.gameId;
    await emitAck(sa, "game:join", { gameId });
    await emitAck(sb, "game:join", { gameId });
    expect((await emitAck(sa, "game:move:submit", { gameId, uci: "e2e4", expectedPly: 0, actionId: actionId() })).ok).toBe(true);
    const r2 = await emitAck(sb, "game:move:submit", { gameId, uci: "e7e5", expectedPly: 1, actionId: actionId() });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.clock.running).toBe(true);
      expect(r2.clock.active).toBe("white");
      expect(r2.clock.whiteMs).toBeLessThanOrEqual(60_000);
    }
    // Clock syncs arrive while running.
    const sync = await waitFor(sa, "game:clock:sync", undefined, 10_000);
    expect(sync.clock.whiteMs).toBeLessThan(60_000);
    // Let white flag (60 s) and confirm the server ends the game by timeout for black.
    const finished = await waitFor(sa, "game:finished", undefined, 75_000);
    expect(finished.result).toBe("BLACK_WINS");
    expect(finished.reason).toBe("TIMEOUT");
    expect(finished.clock.whiteMs).toBe(0);
    const late = await emitAck(sa, "game:move:submit", { gameId, uci: "g1f3", expectedPly: 2, actionId: actionId() });
    expect(late.ok).toBe(false);
    const row = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    expect(row.status).toBe("FINISHED");
    expect(row.ratingSettled).toBe(true);
  }, 100_000);

  it("an active game survives a realtime service restart with its clocks", async () => {
    // Spin up a private realtime instance on another port for this test.
    const PORT = 4017;
    const env = { ...process.env, REALTIME_PORT: String(PORT), LOG_LEVEL: "warn", NODE_ENV: "test" };
    const start = () =>
      new Promise<ChildProcess>((resolve, reject) => {
        const p = spawn("pnpm", ["exec", "tsx", "src/index.ts"], { cwd: path.join(REPO, "apps/realtime"), env, stdio: ["ignore", "pipe", "pipe"] });
        p.stderr?.on("data", (d) => process.stderr.write(`[rt:${PORT}] ${d}`));
        const t0 = Date.now();
        const poll = async () => {
          try {
            const r = await fetch(`http://localhost:${PORT}/health`);
            if (r.ok) return resolve(p);
          } catch {
            /* not yet */
          }
          if (Date.now() - t0 > 30_000) return reject(new Error("realtime did not start"));
          setTimeout(poll, 500);
        };
        void poll();
      });
    child = await start();
    const url = `http://localhost:${PORT}`;
    const a = await createTestUser("rst_a");
    const b = await createTestUser("rst_b");
    const io = await import("socket.io-client");
    const open = (token: string) =>
      new Promise<ClientSocket>((res, rej) => {
        const s = io.io(url, { auth: { token }, transports: ["websocket"], forceNew: true }) as unknown as ClientSocket;
        s.once("connect", () => res(s));
        s.once("connect_error", rej);
        s.on("server:ping", (ack) => ack());
      });
    let sa = await open(a.token);
    let sb = await open(b.token);
    const ch = await emitAck(sa, "challenge:create", { recipientId: b.id, category: "RAPID", rated: false, color: "WHITE" });
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    const acc = await emitAck(sb, "challenge:accept", { challengeId: ch.challenge.id });
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    const gameId = acc.gameId;
    await emitAck(sa, "game:join", { gameId });
    await emitAck(sb, "game:join", { gameId });
    expect((await emitAck(sa, "game:move:submit", { gameId, uci: "d2d4", expectedPly: 0, actionId: actionId() })).ok).toBe(true);
    expect((await emitAck(sb, "game:move:submit", { gameId, uci: "d7d5", expectedPly: 1, actionId: actionId() })).ok).toBe(true);
    await sleep(1500);
    const before = await emitAck(sa, "game:join", { gameId });
    expect(before.ok).toBe(true);
    // Kill and restart.
    child.kill("SIGTERM");
    await sleep(1500);
    sa.disconnect();
    sb.disconnect();
    child = await start();
    sa = await open(a.token);
    sb = await open(b.token);
    sockets.push(sa, sb);
    const after = await emitAck(sa, "game:join", { gameId });
    expect(after.ok).toBe(true);
    if (!after.ok || !before.ok) return;
    expect(after.snapshot.status).toBe("ACTIVE");
    expect(after.snapshot.moves.map((m) => m.san)).toEqual(["d4", "d5"]);
    expect(after.snapshot.clock.running).toBe(true);
    // Downtime is not charged: white's remaining time is at most what it was before the restart.
    expect(after.snapshot.clock.whiteMs).toBeLessThanOrEqual(before.snapshot.clock.whiteMs + 50);
    expect(after.snapshot.clock.whiteMs).toBeGreaterThan(before.snapshot.clock.whiteMs - 5000);
    // Play continues on the restarted instance.
    expect((await emitAck(sa, "game:move:submit", { gameId, uci: "c2c4", expectedPly: 2, actionId: actionId() })).ok).toBe(true);
    await emitAck(sb, "game:resign", { gameId });
    const row = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    expect(row.status).toBe("FINISHED");
    child.kill("SIGTERM");
    child = null;
  }, 120_000);
});

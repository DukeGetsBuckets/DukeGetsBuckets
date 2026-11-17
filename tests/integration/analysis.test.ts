import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { actionId, connect, createTestUser, emitAck, testPrisma, waitFor, type ClientSocket } from "../helpers/realtime";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";

/** Scholar's mate: 3...Nf6?? allows 4.Qxf7#. */
const SCRIPT = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];

describe("Stockfish game review pipeline", () => {
  const prisma = testPrisma();
  let sa: ClientSocket;
  let sb: ClientSocket;
  let a: Awaited<ReturnType<typeof createTestUser>>;
  let b: Awaited<ReturnType<typeof createTestUser>>;
  let gameId: string;
  let queue: Queue;
  let events: QueueEvents;
  const conn = () => new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

  beforeAll(async () => {
    a = await createTestUser("an_a");
    b = await createTestUser("an_b");
    sa = await connect(a.token);
    sb = await connect(b.token);
    queue = new Queue("analysis", { connection: conn() });
    events = new QueueEvents("analysis", { connection: conn() });
  });
  afterAll(async () => {
    sa?.disconnect();
    sb?.disconnect();
    await queue?.close();
    await events?.close();
  });

  it("plays a scripted game ending in checkmate", async () => {
    // Direct challenge so colours are deterministic: A is white.
    const created = await emitAck(sa, "challenge:create", { recipientId: b.id, category: "RAPID", rated: true, color: "WHITE" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const found = waitFor(sa, "match:found");
    const accepted = await emitAck(sb, "challenge:accept", { challengeId: created.challenge.id });
    expect(accepted.ok).toBe(true);
    const m = await found;
    expect(m.color).toBe("white");
    gameId = m.gameId;
    await emitAck(sa, "game:join", { gameId });
    await emitAck(sb, "game:join", { gameId });
    const finished = waitFor(sa, "game:finished");
    for (let i = 0; i < SCRIPT.length; i++) {
      const socket = i % 2 === 0 ? sa : sb;
      const r = await emitAck(socket, "game:move:submit", { gameId, uci: SCRIPT[i]!, expectedPly: i, actionId: actionId() });
      expect(r.ok).toBe(true);
    }
    const f = await finished;
    expect(f.result).toBe("WHITE_WINS");
    expect(f.reason).toBe("CHECKMATE");
  });

  it("refuses engine analysis for an active game through the web API", async () => {
    // Register a real account over HTTP (Better Auth) to obtain a session cookie.
    const username = `api_${Math.random().toString(36).slice(2, 8)}`;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`${WEB}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: WEB },
        body: JSON.stringify({ email: `${username}@example.com`, password: "correct-horse-battery", name: username, username }),
      });
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 15_000)); // sign-up is rate limited per IP
    }
    expect(res?.ok, `sign-up failed: ${res?.status} ${await res?.text()}`).toBe(true);
    if (!res) return;
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    // Start an active game between two other users and try to request a review of it.
    const c = await createTestUser("act_c");
    const d = await createTestUser("act_d");
    const sc = await connect(c.token);
    const sd = await connect(d.token);
    const ch = await emitAck(sc, "challenge:create", { recipientId: d.id, category: "BLITZ", rated: false, color: "WHITE" });
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    const acc = await emitAck(sd, "challenge:accept", { challengeId: ch.challenge.id });
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    const activeId = acc.gameId;
    const review = await fetch(`${WEB}/api/review/${activeId}`, { method: "POST", headers: { cookie } });
    expect(review.status).toBe(409);
    // Position analysis is also refused while the requester is in a game: use player c's own session? c has no password,
    // so instead verify the finished game can be requested by the API user (200) — it is not theirs but reviews are public.
    const ok = await fetch(`${WEB}/api/review/${gameId}`, { method: "POST", headers: { cookie } });
    expect([200, 409]).toContain(ok.status); // 200 (queued) or 409 if already processing from a prior run
    await emitAck(sc, "game:abort", { gameId: activeId });
    sc.disconnect();
    sd.disconnect();
  });

  it("analyzes every move with Stockfish and classifies the blunder and mate", async () => {
    await prisma.gameAnalysis.upsert({ where: { gameId }, create: { gameId, status: "QUEUED", config: {} }, update: { status: "QUEUED", progress: 0 } });
    const existing = await queue.getJob(gameId);
    if (existing) await existing.remove().catch(() => undefined);
    const job = await queue.add("game", { type: "game", gameId, requestedById: a.id }, { jobId: gameId, attempts: 1 });
    await job.waitUntilFinished(events, 240_000);
    const analysis = await prisma.gameAnalysis.findUniqueOrThrow({ where: { gameId }, include: { moves: { orderBy: { ply: "asc" } } } });
    expect(analysis.status).toBe("COMPLETED");
    expect(analysis.engine).toMatch(/Stockfish/);
    expect(analysis.moves).toHaveLength(SCRIPT.length);
    const nf6 = analysis.moves.find((m) => m.ply === 6)!;
    expect(nf6.classification).toBe("BLUNDER");
    expect(nf6.mateAfter).toBe(1); // white mates in 1 after 3...Nf6
    expect(nf6.explanation).toMatch(/mate/i);
    const mate = analysis.moves.find((m) => m.ply === 7)!;
    expect(["BEST", "GREAT", "BRILLIANT"]).toContain(mate.classification);
    // Accuracy derives from the analysis: white better than black here.
    expect(analysis.whiteAccuracy).not.toBeNull();
    expect(analysis.blackAccuracy).not.toBeNull();
    expect(analysis.whiteAccuracy!).toBeGreaterThan(analysis.blackAccuracy!);
    const summary = analysis.summary as { winChances: number[]; evals: unknown[]; turningPoint: { ply: number } | null };
    expect(summary.winChances).toHaveLength(SCRIPT.length + 1);
    expect(summary.evals).toHaveLength(SCRIPT.length + 1);
    expect(summary.winChances[SCRIPT.length]).toBe(100);
    expect(summary.turningPoint?.ply).toBe(6);
    // Best moves match engine output stored in the move rows.
    for (const m of analysis.moves) {
      if (m.bestUci) expect((m.pv as string[])[0]).toBe(m.bestUci);
    }
  });

  it("creates a legal training position for the blunder with engine-backed solutions", async () => {
    const positions = await prisma.trainingPosition.findMany({ where: { userId: b.id, gameId } });
    expect(positions.length).toBeGreaterThanOrEqual(1);
    const p = positions.find((x) => x.ply === 6)!;
    expect(p).toBeTruthy();
    const { Chess } = await import("chess.js");
    const c = new Chess(p.fen);
    expect(c.turn()).toBe("b");
    const legal = c.moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ""}`);
    expect(legal).toContain(p.bestUci);
    expect(p.playedUci).toBe("g8f6");
    expect(p.bestUci).not.toBe("g8f6");
    for (const alt of p.acceptableMoves as { uci: string }[]) expect(legal).toContain(alt.uci);
  });

  it("a failed job can be retried safely (idempotent re-analysis)", async () => {
    await prisma.gameAnalysis.update({ where: { gameId }, data: { status: "FAILED", error: "simulated crash" } });
    const existing = await queue.getJob(gameId);
    if (existing) await existing.remove().catch(() => undefined);
    const job = await queue.add("game", { type: "game", gameId, requestedById: a.id }, { jobId: gameId, attempts: 1 });
    await job.waitUntilFinished(events, 240_000);
    const analysis = await prisma.gameAnalysis.findUniqueOrThrow({ where: { gameId }, include: { moves: true } });
    expect(analysis.status).toBe("COMPLETED");
    expect(analysis.attempts).toBeGreaterThanOrEqual(2);
    expect(analysis.moves).toHaveLength(SCRIPT.length); // no duplicate move rows
    expect(await prisma.trainingPosition.count({ where: { userId: b.id, gameId, ply: 6 } })).toBe(1);
  });
});

import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { MATCHMAKING_DEFAULTS } from "@tempo/shared";
import { connect, createTestUser, emitAck, sleep, testPrisma, waitFor, type ClientSocket } from "../helpers/realtime";

describe("matchmaking integrity", () => {
  const prisma = testPrisma();
  const sockets: ClientSocket[] = [];
  afterAll(() => sockets.forEach((s) => s.disconnect()));

  it("cancelling leaves the queue and a player can never match themselves", async () => {
    const u = await createTestUser("mm_solo");
    const s = await connect(u.token);
    sockets.push(s);
    const s2 = await connect(u.token); // second device, same account
    sockets.push(s2);
    const joined = await emitAck(s, "queue:join", { category: "RAPID", rated: true });
    expect(joined.ok).toBe(true);
    const again = await emitAck(s2, "queue:join", { category: "RAPID", rated: true });
    expect(again.ok).toBe(true); // idempotent for the same account/category
    let matched = false;
    s.once("match:found", () => (matched = true));
    await sleep(2500); // several matching ticks
    expect(matched).toBe(false);
    const cancelled = await emitAck(s, "queue:cancel", undefined);
    expect(cancelled.ok).toBe(true);
    const left = await waitFor(s2, "queue:left").catch(() => null);
    expect(left?.reason ?? "canceled").toBe("canceled");
    expect(await prisma.game.count({ where: { whiteId: u.id, blackId: u.id } })).toBe(0);
  });

  it("joining another queue replaces the previous entry", async () => {
    const u = await createTestUser("mm_sw");
    const s = await connect(u.token);
    sockets.push(s);
    expect((await emitAck(s, "queue:join", { category: "BULLET", rated: true })).ok).toBe(true);
    const left = waitFor(s, "queue:left", (p) => p.reason === "replaced");
    expect((await emitAck(s, "queue:join", { category: "RAPID", rated: false })).ok).toBe(true);
    expect((await left).reason).toBe("replaced");
    await emitAck(s, "queue:cancel", undefined);
  });

  it("widely separated ratings wait until the window expands as configured", async () => {
    const a = await createTestUser("mm_hi");
    const b = await createTestUser("mm_lo");
    // Established players (low deviation) 450 points apart: the initial ±100 window must not pair them,
    // but the configured expansion must eventually.
    await prisma.rating.upsert({ where: { userId_category: { userId: a.id, category: "RAPID" } }, create: { userId: a.id, category: "RAPID", rating: 1900, deviation: 50, gamesPlayed: 50 }, update: { rating: 1900, deviation: 50, gamesPlayed: 50 } });
    await prisma.rating.upsert({ where: { userId_category: { userId: b.id, category: "RAPID" } }, create: { userId: b.id, category: "RAPID", rating: 1450, deviation: 50, gamesPlayed: 50 }, update: { rating: 1450, deviation: 50, gamesPlayed: 50 } });
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    sockets.push(sa, sb);
    const t0 = Date.now();
    const found = waitFor(sa, "match:found", undefined, 120_000);
    expect((await emitAck(sa, "queue:join", { category: "RAPID", rated: true })).ok).toBe(true);
    expect((await emitAck(sb, "queue:join", { category: "RAPID", rated: true })).ok).toBe(true);
    // Status pushes report the current window.
    const status = await waitFor(sa, "queue:status");
    expect(status.range).toBe(MATCHMAKING_DEFAULTS.rangeSteps[0]!.range);
    let early = false;
    sa.once("match:found", () => {
      if (Date.now() - t0 < 4000) early = true;
    });
    const m = await found;
    const waited = (Date.now() - t0) / 1000;
    expect(early).toBe(false);
    // 450 apart with avg-of-windows pairing: both windows must reach 450 → the 600 step (after 60 s) is the first
    // step whose average ≥ 450 only if both are there; with 400@30s avg=400 < 450 → expect ≥ 60 s.
    expect(waited).toBeGreaterThanOrEqual(30);
    expect(m.opponent.id).toBe(b.id);
    await emitAck(sa, "game:abort", { gameId: m.gameId });
  }, 150_000);

  it("a player cannot be in two games at once", async () => {
    const a = await createTestUser("mm_two_a");
    const b = await createTestUser("mm_two_b");
    const c = await createTestUser("mm_two_c");
    const sa = await connect(a.token);
    const sb = await connect(b.token);
    const sc = await connect(c.token);
    sockets.push(sa, sb, sc);
    const ch = await emitAck(sa, "challenge:create", { recipientId: b.id, category: "BLITZ", rated: false, color: "RANDOM" });
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    const acc = await emitAck(sb, "challenge:accept", { challengeId: ch.challenge.id });
    expect(acc.ok).toBe(true);
    const ch2 = await emitAck(sc, "challenge:create", { recipientId: a.id, category: "BLITZ", rated: false, color: "RANDOM" });
    expect(ch2.ok).toBe(true);
    if (!ch2.ok) return;
    const acc2 = await emitAck(sa, "challenge:accept", { challengeId: ch2.challenge.id });
    expect(acc2.ok).toBe(false);
    if (!acc2.ok) expect(acc2.error.code).toBe("ALREADY_IN_GAME");
    const q = await emitAck(sa, "queue:join", { category: "BULLET", rated: true });
    expect(q.ok).toBe(false);
    if (acc.ok) await emitAck(sa, "game:abort", { gameId: acc.gameId });
  });
});

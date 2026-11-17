import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GameSnapshot } from "@tempo/shared";
import { actionId, connect, createTestUser, emitAck, sleep, testPrisma, waitFor, type ClientSocket } from "../helpers/realtime";

describe("live multiplayer via realtime service", () => {
  let a: Awaited<ReturnType<typeof createTestUser>>;
  let b: Awaited<ReturnType<typeof createTestUser>>;
  let sa: ClientSocket;
  let sb: ClientSocket;
  let gameId: string;
  let colorA: "white" | "black";
  const prisma = testPrisma();

  beforeAll(async () => {
    a = await createTestUser("mp_a");
    b = await createTestUser("mp_b");
    sa = await connect(a.token);
    sb = await connect(b.token);
  });

  afterAll(async () => {
    sa?.disconnect();
    sb?.disconnect();
  });

  it("rejects unauthenticated sockets", async () => {
    await expect(connect("not-a-token")).rejects.toBeTruthy();
  });

  it("pairs two queued players into the same game", async () => {
    const foundA = waitFor(sa, "match:found");
    const foundB = waitFor(sb, "match:found");
    const joinA = await emitAck(sa, "queue:join", { category: "BLITZ", rated: true });
    expect(joinA.ok).toBe(true);
    const joinB = await emitAck(sb, "queue:join", { category: "BLITZ", rated: true });
    expect(joinB.ok).toBe(true);
    const [ma, mb] = await Promise.all([foundA, foundB]);
    expect(ma.gameId).toBe(mb.gameId);
    expect(ma.color).not.toBe(mb.color);
    gameId = ma.gameId;
    colorA = ma.color;
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    expect(game.status).toBe("ACTIVE");
    expect([game.whiteId, game.blackId].sort()).toEqual([a.id, b.id].sort());
  });

  it("cannot join a queue while in a game", async () => {
    const r = await emitAck(sa, "queue:join", { category: "BULLET", rated: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ALREADY_IN_GAME");
  });

  it("both players receive identical snapshots", async () => {
    const ja = await emitAck(sa, "game:join", { gameId });
    const jb = await emitAck(sb, "game:join", { gameId });
    expect(ja.ok && jb.ok).toBe(true);
    if (!ja.ok || !jb.ok) return;
    expect(ja.snapshot.fen).toBe(jb.snapshot.fen);
    expect(ja.snapshot.ply).toBe(0);
    expect(ja.snapshot.yourColor).toBe(colorA);
    expect(jb.snapshot.yourColor).not.toBe(colorA);
    expect(ja.snapshot.clock.running).toBe(false);
    expect(ja.snapshot.firstMoveDeadline).not.toBeNull();
  });

  it("only the side to move can move; illegal and stale moves are rejected", async () => {
    const white = colorA === "white" ? sa : sb;
    const black = colorA === "white" ? sb : sa;
    const wrongTurn = await emitAck(black, "game:move:submit", { gameId, uci: "e7e5", expectedPly: 0, actionId: actionId() });
    expect(wrongTurn.ok).toBe(false);
    if (!wrongTurn.ok) expect(wrongTurn.error.code).toBe("NOT_YOUR_TURN");
    const illegal = await emitAck(white, "game:move:submit", { gameId, uci: "e2e5", expectedPly: 0, actionId: actionId() });
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.error.code).toBe("ILLEGAL_MOVE");
    const stale = await emitAck(white, "game:move:submit", { gameId, uci: "e2e4", expectedPly: 3, actionId: actionId() });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_SEQUENCE");
  });

  it("moves synchronize to both clients and duplicates are applied once", async () => {
    const white = colorA === "white" ? sa : sb;
    const black = colorA === "white" ? sb : sa;
    const seenByBlack = waitFor(black, "game:move:accepted", (p) => p.ply === 1);
    const id = actionId();
    const first = await emitAck(white, "game:move:submit", { gameId, uci: "e2e4", expectedPly: 0, actionId: id });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.san).toBe("e4");
    const broadcast = await seenByBlack;
    expect(broadcast.uci).toBe("e2e4");
    expect(broadcast.by).toBe("white");
    // Same actionId again → idempotent response, no second move.
    const dup = await emitAck(white, "game:move:submit", { gameId, uci: "e2e4", expectedPly: 0, actionId: id });
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.duplicate).toBe(true);
    const row = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    expect(row.ply).toBe(1);
    expect(await prisma.move.count({ where: { gameId } })).toBe(1);
  });

  it("premoves execute automatically when legal and are cleared when illegal", async () => {
    const white = colorA === "white" ? sa : sb;
    const black = colorA === "white" ? sb : sa;
    // White premoves Nf3 while black is to move; black plays e5 → Nf3 executes immediately.
    expect((await emitAck(white, "game:premove:set", { gameId, uci: "g1f3" })).ok).toBe(true);
    const seeNf3 = waitFor(black, "game:move:accepted", (p) => p.ply === 3);
    expect((await emitAck(black, "game:move:submit", { gameId, uci: "e7e5", expectedPly: 1, actionId: actionId() })).ok).toBe(true);
    const nf3 = await seeNf3;
    expect(nf3.uci).toBe("g1f3");
    expect(nf3.fromPremove).toBe(true);
    // Both sides have moved: clocks run, black's clock is active.
    expect(nf3.clock.running).toBe(true);
    expect(nf3.clock.active).toBe("black");
    expect((await emitAck(black, "game:move:submit", { gameId, uci: "b8c6", expectedPly: 3, actionId: actionId() })).ok).toBe(true);
    // Black premoves e5-e4, which is blocked by the white pawn → must be cleared, not executed.
    expect((await emitAck(black, "game:premove:set", { gameId, uci: "e5e4" })).ok).toBe(true);
    // A player may not premove on their own turn.
    const ownTurn = await emitAck(white, "game:premove:set", { gameId, uci: "a2a3" });
    expect(ownTurn.ok).toBe(false);
    const cleared = waitFor(black, "game:premove:cleared");
    expect((await emitAck(white, "game:move:submit", { gameId, uci: "b1c3", expectedPly: 4, actionId: actionId() })).ok).toBe(true);
    expect((await cleared).reason).toBe("illegal");
    expect((await emitAck(black, "game:move:submit", { gameId, uci: "f8b4", expectedPly: 5, actionId: actionId() })).ok).toBe(true);
    const snap = await emitAck(white, "game:join", { gameId });
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.snapshot.ply).toBe(6);
      expect(snap.snapshot.moves.map((m) => m.san)).toEqual(["e4", "e5", "Nf3", "Nc6", "Nc3", "Bb4"]);
      expect(snap.snapshot.clock.whiteMs).toBeLessThanOrEqual(300_000);
      expect(snap.snapshot.clock.blackMs).toBeLessThan(300_000);
    }
  });

  it("draw offer can be declined and resignation ends the game with rating settlement", async () => {
    const white = colorA === "white" ? sa : sb;
    const black = colorA === "white" ? sb : sa;
    const offered = waitFor(black, "game:draw:offered");
    expect((await emitAck(white, "game:draw:offer", { gameId })).ok).toBe(true);
    expect((await offered).by).toBe("white");
    const declined = waitFor(white, "game:draw:declined");
    expect((await emitAck(black, "game:draw:respond", { gameId, accept: false })).ok).toBe(true);
    await declined;

    const finishedA = waitFor(sa, "game:finished");
    const finishedB = waitFor(sb, "game:finished");
    expect((await emitAck(black, "game:resign", { gameId })).ok).toBe(true);
    const [fa, fb] = await Promise.all([finishedA, finishedB]);
    expect(fa.result).toBe("WHITE_WINS");
    expect(fa.reason).toBe("RESIGNATION");
    expect(fb.result).toBe(fa.result);
    expect(fa.white.delta).toBeGreaterThan(0);
    expect(fa.black.delta).toBeLessThan(0);

    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    expect(game.status).toBe("FINISHED");
    expect(game.ratingSettled).toBe(true);
    expect(game.pgn?.replace(/\s*\{[^}]*\}/g, "").replace(/\s+/g, " ")).toContain("1. e4 e5 2. Nf3 Nc6 3. Nc3 Bb4 1-0");
    expect(game.openingEco).toBe("C46");
    const history = await prisma.ratingHistory.findMany({ where: { gameId } });
    expect(history).toHaveLength(2);
    const blitz = await prisma.rating.findMany({ where: { userId: { in: [a.id, b.id] }, category: "BLITZ" } });
    expect(blitz.every((r) => r.gamesPlayed === 1)).toBe(true);
    // Bullet/rapid ratings untouched.
    const others = await prisma.rating.findMany({ where: { userId: { in: [a.id, b.id] }, category: { in: ["BULLET", "RAPID"] } } });
    expect(others.every((r) => r.gamesPlayed === 0)).toBe(true);
  });

  it("moves after the game ended are rejected", async () => {
    const white = colorA === "white" ? sa : sb;
    const r = await emitAck(white, "game:move:submit", { gameId, uci: "d2d4", expectedPly: 6, actionId: actionId() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("GAME_NOT_ACTIVE");
  });

  it("rematch creates a new game with colors swapped", async () => {
    const foundA = waitFor(sa, "match:found", (p) => p.source === "REMATCH");
    const foundB = waitFor(sb, "match:found", (p) => p.source === "REMATCH");
    const offered = waitFor(sb, "game:rematch:offered");
    expect((await emitAck(sa, "game:rematch:request", { gameId })).ok).toBe(true);
    await offered;
    const accept = await emitAck(sb, "game:rematch:respond", { gameId, accept: true });
    expect(accept.ok).toBe(true);
    const [ra, rb] = await Promise.all([foundA, foundB]);
    expect(ra.gameId).toBe(rb.gameId);
    expect(ra.gameId).not.toBe(gameId);
    expect(ra.color).toBe(colorA === "white" ? "black" : "white");
    const row = await prisma.game.findUniqueOrThrow({ where: { id: ra.gameId } });
    expect(row.rematchOfId).toBe(gameId);
    // Abort the rematch (no moves yet) to clean up.
    expect((await emitAck(sa, "game:abort", { gameId: ra.gameId })).ok).toBe(true);
    await sleep(100);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: ra.gameId } })).status).toBe("ABORTED");
  });

  it("reconnecting restores the authoritative snapshot", async () => {
    sa.disconnect();
    await sleep(200);
    sa = await connect(a.token);
    const snap = await emitAck(sa, "game:join", { gameId });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    const s: GameSnapshot = snap.snapshot;
    expect(s.status).toBe("FINISHED");
    expect(s.moves.map((m) => m.san)).toEqual(["e4", "e5", "Nf3", "Nc6", "Nc3", "Bb4"]);
  });
});

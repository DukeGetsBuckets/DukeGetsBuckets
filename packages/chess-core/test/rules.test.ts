import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import {
  START_FEN,
  adjudicate,
  applyUci,
  hasMatingMaterial,
  isPromotionMove,
  legalUciMoves,
  repetitionCount,
  replayUci,
  timeoutOutcome,
  uciToSan,
  capturedPieces,
} from "../src/rules";

describe("legal move validation", () => {
  it("rejects illegal moves and never throws", () => {
    const c = new Chess();
    expect(applyUci(c, "e2e5")).toBeNull();
    expect(applyUci(c, "e7e5")).toBeNull(); // not white's piece
    expect(applyUci(c, "zz99")).toBeNull();
    expect(c.fen()).toBe(START_FEN);
  });

  it("accepts legal moves and reports SAN", () => {
    const c = new Chess();
    const m = applyUci(c, "e2e4");
    expect(m?.san).toBe("e4");
    expect(m?.fenAfter).toContain(" b KQkq - 0 1");
  });

  it("only the side to move can move", () => {
    const c = new Chess();
    applyUci(c, "e2e4");
    expect(applyUci(c, "d2d4")).toBeNull();
    expect(applyUci(c, "e7e5")).not.toBeNull();
  });

  it("castling is allowed only when legal (no passing through check)", () => {
    // White king e1, rook h1, black rook on f8 covers f1 → O-O illegal.
    const c = new Chess("5rk1/8/8/8/8/8/8/4K2R w K - 0 1");
    expect(applyUci(c, "e1g1")).toBeNull();
    // Without the attacker it is legal.
    const d = new Chess("6k1/8/8/8/8/8/8/4K2R w K - 0 1");
    const m = applyUci(d, "e1g1");
    expect(m?.san).toBe("O-O");
    expect(m?.castle).toBe(true);
  });

  it("castling rights are lost after the king moves", () => {
    const c = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    applyUci(c, "e1e2");
    applyUci(c, "e8e7");
    applyUci(c, "e2e1");
    applyUci(c, "e7e8");
    expect(applyUci(c, "e1g1")).toBeNull();
  });

  it("en passant works correctly", () => {
    const c = replayUci(["e2e4", "a7a6", "e4e5", "d7d5"]);
    const m = applyUci(c, "e5d6");
    expect(m?.enPassant).toBe(true);
    expect(m?.capture).toBe(true);
    expect(c.get("d5")).toBeFalsy();
  });

  it("en passant is only available immediately", () => {
    const c = replayUci(["e2e4", "a7a6", "e4e5", "d7d5", "a2a3", "a6a5"]);
    expect(applyUci(c, "e5d6")).toBeNull();
  });

  it("promotion requires and validates a piece", () => {
    const c = new Chess("8/P7/8/8/8/8/8/K6k w - - 0 1");
    expect(isPromotionMove(c, "a7", "a8")).toBe(true);
    const legal = legalUciMoves(c, "a7");
    expect(legal.sort()).toEqual(["a7a8b", "a7a8n", "a7a8q", "a7a8r"]);
    const m = applyUci(c, "a7a8q");
    expect(m?.promotion).toBe(true);
    expect(m?.san).toBe("a8=Q+");
  });

  it("check prevents illegal king movement and forces resolution", () => {
    // Black king e8 in check from a rook on e1; black must deal with it.
    const c = new Chess("4k3/8/8/8/8/8/8/4RK2 b - - 0 1");
    expect(applyUci(c, "e8e7")).toBeNull(); // still on the e-file
    expect(applyUci(c, "e8d8")).not.toBeNull();
  });

  it("converts UCI to SAN without mutating", () => {
    expect(uciToSan(START_FEN, "g1f3")).toBe("Nf3");
    expect(uciToSan(START_FEN, "g1f4")).toBeNull();
  });
});

describe("game endings", () => {
  it("detects checkmate (fool's mate)", () => {
    const c = replayUci(["f2f3", "e7e5", "g2g4", "d8h4"]);
    const a = adjudicate(c);
    expect(a).toMatchObject({ over: true, result: "BLACK_WINS", reason: "CHECKMATE" });
  });

  it("detects stalemate as a draw", () => {
    const c = new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
    expect(adjudicate(c)).toMatchObject({ over: true, result: "DRAW", reason: "STALEMATE" });
  });

  it("detects insufficient material", () => {
    const c = new Chess("8/8/8/8/8/4k3/8/3K2N1 w - - 0 1");
    expect(adjudicate(c)).toMatchObject({ over: true, result: "DRAW", reason: "INSUFFICIENT_MATERIAL" });
  });

  it("threefold repetition is claimable, fivefold is automatic", () => {
    const c = new Chess();
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    // 1 occurrence at start; each shuffle cycle adds one more.
    for (const m of shuffle) applyUci(c, m);
    for (const m of shuffle) applyUci(c, m);
    expect(repetitionCount(c)).toBe(3);
    expect(adjudicate(c).over).toBe(false);
    expect(adjudicate(c).claimable).toContain("THREEFOLD_REPETITION");
    for (const m of shuffle) applyUci(c, m);
    for (const m of shuffle) applyUci(c, m);
    expect(repetitionCount(c)).toBe(5);
    expect(adjudicate(c)).toMatchObject({ over: true, result: "DRAW", reason: "FIVEFOLD_REPETITION" });
  });

  it("fifty-move rule is claimable and 75-move rule is automatic", () => {
    const fifty = new Chess("8/8/8/4k3/8/8/4K3/R7 w - - 100 80");
    expect(adjudicate(fifty).claimable).toContain("FIFTY_MOVE_RULE");
    expect(adjudicate(fifty).over).toBe(false);
    const seventyFive = new Chess("8/8/8/4k3/8/8/4K3/R7 w - - 150 100");
    expect(adjudicate(seventyFive)).toMatchObject({ over: true, result: "DRAW", reason: "SEVENTY_FIVE_MOVE_RULE" });
  });
});

describe("timeouts and mating material", () => {
  it("lone king, king+minor and same-coloured bishops cannot mate", () => {
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/8/8/4K3 w - - 0 1"), "w")).toBe(false);
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/8/8/4KB2 w - - 0 1"), "w")).toBe(false);
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/8/8/4KN2 w - - 0 1"), "w")).toBe(false);
    // Bishops on c1 and e3 are both dark squares.
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/4B3/8/2B1K3 w - - 0 1"), "w")).toBe(false);
  });

  it("pawns, rooks, queens, two knights or opposite bishops can mate", () => {
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/8/P7/4K3 w - - 0 1"), "w")).toBe(true);
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/8/8/R3K3 w - - 0 1"), "w")).toBe(true);
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/8/8/4KNN1 w - - 0 1"), "w")).toBe(true);
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1"), "w")).toBe(true);
    expect(hasMatingMaterial(new Chess("8/8/8/4k3/8/8/8/3BKN2 w - - 0 1"), "w")).toBe(true);
  });

  it("flagging against a bare king is a draw, otherwise a loss", () => {
    const bare = new Chess("8/8/8/4k3/8/8/8/4K2Q b - - 0 1");
    expect(timeoutOutcome(bare, "w")).toEqual({ result: "DRAW", reason: "TIMEOUT_VS_INSUFFICIENT_MATERIAL" });
    expect(timeoutOutcome(bare, "b")).toEqual({ result: "WHITE_WINS", reason: "TIMEOUT" });
  });

  it("counts captured pieces from the position", () => {
    const c = replayUci(["e2e4", "d7d5", "e4d5", "d8d5"]);
    const cap = capturedPieces(c);
    expect(cap.byWhite.p).toBe(1);
    expect(cap.byBlack.p).toBe(1);
  });
});

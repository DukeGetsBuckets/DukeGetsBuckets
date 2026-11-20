import { describe, expect, it } from "vitest";
import { parseBestMove, parseEloOption, parseInfoLine, toWhitePov } from "../lib/engine/uci";
import { rankedLines, scoreValue, type EngineLine } from "../lib/engine/StockfishEngine";
import { buildBotThought, describeStanding, formatEvalWhite, judgeMove, moveIdeas, pvToText, reactToMove } from "../lib/bot/thoughts";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("UCI parsing", () => {
  it("parses a multipv info line", () => {
    const info = parseInfoLine("info depth 14 seldepth 20 multipv 2 score cp -35 nodes 123456 nps 456789 hashfull 12 tbhits 0 time 270 pv e7e5 g1f3 b8c6");
    expect(info).toEqual({ depth: 14, seldepth: 20, multipv: 2, score: { cp: -35, mate: null }, bound: null, nodes: 123456, nps: 456789, timeMs: 270, pv: ["e7e5", "g1f3", "b8c6"] });
  });
  it("parses mate scores and bounds", () => {
    expect(parseInfoLine("info depth 9 multipv 1 score mate -3 nodes 10 pv e1e2")?.score).toEqual({ cp: null, mate: -3 });
    expect(parseInfoLine("info depth 9 multipv 1 score cp 50 lowerbound nodes 10 pv e2e4")?.bound).toBe("lower");
  });
  it("ignores lines without a score or pv", () => {
    expect(parseInfoLine("info string NNUE evaluation using nn-xyz.nnue")).toBeNull();
    expect(parseInfoLine("info depth 10 currmove e2e4 currmovenumber 1")).toBeNull();
    expect(parseInfoLine("readyok")).toBeNull();
  });
  it("parses bestmove", () => {
    expect(parseBestMove("bestmove e2e4 ponder e7e5")).toEqual({ best: "e2e4", ponder: "e7e5" });
    expect(parseBestMove("bestmove e7e8q")).toEqual({ best: "e7e8q", ponder: null });
    expect(parseBestMove("bestmove (none)")).toEqual({ best: null, ponder: null });
  });
  it("reads the UCI_Elo range", () => {
    expect(parseEloOption("option name UCI_Elo type spin default 1320 min 1320 max 3190")).toEqual({ min: 1320, max: 3190 });
    expect(parseEloOption("option name Hash type spin default 16 min 1 max 33554432")).toBeNull();
  });
  it("converts side-to-move scores to White's point of view", () => {
    expect(toWhitePov({ cp: 40, mate: null }, "w")).toEqual({ cp: 40, mate: null });
    expect(toWhitePov({ cp: 40, mate: null }, "b")).toEqual({ cp: -40, mate: null });
    expect(toWhitePov({ cp: null, mate: 2 }, "b")).toEqual({ cp: null, mate: -2 });
  });
});

describe("evaluation text", () => {
  it("formats White-POV evaluations", () => {
    expect(formatEvalWhite({ cp: 35, mate: null })).toBe("+0.35");
    expect(formatEvalWhite({ cp: -120, mate: null })).toBe("−1.20");
    expect(formatEvalWhite({ cp: null, mate: -2 })).toBe("−M2");
    expect(formatEvalWhite({ cp: 0, mate: null })).toBe("0.00");
  });
  it("describes the standing from either side", () => {
    expect(describeStanding({ cp: 10, mate: null }, "w").text).toBe("The position is about equal.");
    expect(describeStanding({ cp: 140, mate: null }, "w")).toEqual({ tone: "ahead", text: "You're ahead by about a pawn." });
    expect(describeStanding({ cp: 140, mate: null }, "b")).toEqual({ tone: "behind", text: "You're behind by about a pawn." });
    expect(describeStanding({ cp: -60, mate: null }, "b", "I").text).toBe("I'm slightly better (about 0.6 of a pawn).");
    expect(describeStanding({ cp: null, mate: 3 }, "b").text).toBe("You're getting checkmated: mate in 3 is coming.");
    expect(describeStanding({ cp: null, mate: -4 }, "b").text).toBe("You can force checkmate in 4.");
  });
  it("numbers principal variations", () => {
    expect(pvToText(START, ["e2e4", "e7e5", "g1f3"])).toBe("1.e4 e5 2.Nf3");
    const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    expect(pvToText(afterE4, ["c7c5", "g1f3", "d7d6"])).toBe("1…c5 2.Nf3 d6");
    expect(pvToText(START, ["e2e5"])).toBe(""); // illegal moves stop the line
  });
});

describe("move ideas", () => {
  it("recognises development and central pawns in the opening", () => {
    expect(moveIdeas(START, "g1f3")).toContain("Develops the knight toward the center.");
    expect(moveIdeas(START, "e2e4")).toContain("Claims space in the center with a pawn.");
  });
  it("recognises a free capture", () => {
    // Black knight on e5 is undefended and attacked by the f3 knight.
    const fen = "rnbqkb1r/pppppppp/8/4n3/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 3";
    expect(moveIdeas(fen, "f3e5")).toContain("Wins the knight on e5 for free.");
  });
  it("recognises a knight fork with check", () => {
    // Nc7+ forks the king on e8 and the rook on a8.
    const fen = "r3k3/8/8/3N4/8/8/8/4K3 w - - 0 30";
    const ideas = moveIdeas(fen, "d5c7");
    expect(ideas.some((i) => i.startsWith("Check, and at the same time attacks the") && i.includes("rook on a8"))).toBe(true);
  });
  it("recognises castling and checkmate", () => {
    const castle = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    expect(moveIdeas(castle, "e1g1")[0]).toMatch(/^Castles/);
    const mate = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1";
    expect(moveIdeas(mate, "a1a8")).toEqual(["Checkmate."]);
  });
  it("recognises rescuing an attacked piece", () => {
    // White bishop on g5 attacked by the h6 pawn.
    const fen = "rnbqkb1r/pppp1pp1/5n1p/4p1B1/4P3/8/PPPP1PPP/RN1QKBNR w KQkq - 0 4";
    expect(moveIdeas(fen, "g5h4")).toContain("Moves the bishop out of danger (it was attacked on g5).");
  });
});

describe("judging the player's move", () => {
  it("uses the review thresholds", () => {
    expect(judgeMove({ cp: 30, mate: null }, { cp: 30, mate: null }, "w", true).verdict).toBe("BEST");
    expect(judgeMove({ cp: 30, mate: null }, { cp: 15, mate: null }, "w", false).verdict).toBe("EXCELLENT");
    expect(judgeMove({ cp: 30, mate: null }, { cp: -150, mate: null }, "w", false).verdict).toBe("MISTAKE");
    expect(judgeMove({ cp: 30, mate: null }, { cp: -600, mate: null }, "w", false).verdict).toBe("BLUNDER");
    expect(judgeMove({ cp: 0, mate: null }, { cp: null, mate: 2 }, "b", false).verdict).toBe("BLUNDER");
  });
  it("explains a blunder with the punishing reply", () => {
    // 1.e4 e5 2.Qh5 Nc6 3.Bc4 — Black blunders with 3…Nf6?? allowing Qxf7#.
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3";
    const r = reactToMove({ fenBefore: fen, playedUci: "g8f6", expectedUci: "g7g6", bestWhite: { cp: 20, mate: null }, afterWhite: { cp: null, mate: 1 }, replyUci: "h5f7" });
    expect(r?.verdict).toBe("BLUNDER");
    expect(r?.playedLabel).toBe("3…Nf6");
    expect(r?.text).toBe("I was expecting g6. Nf6 is a blunder. I can take the pawn with Qxf7#.");
  });
  it("praises the expected move", () => {
    const r = reactToMove({ fenBefore: START, playedUci: "e2e4", expectedUci: "e2e4", bestWhite: { cp: 30, mate: null }, afterWhite: { cp: 30, mate: null }, replyUci: null });
    expect(r?.verdict).toBe("BEST");
    expect(r?.text).toBe("e4 is exactly the move I expected. Well played.");
  });
});

describe("bot thought card", () => {
  const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const lines = [
    { uci: "c7c5", pv: ["c7c5", "g1f3", "d7d6"], score: { cp: -25, mate: null } },
    { uci: "e7e5", pv: ["e7e5", "g1f3"], score: { cp: -30, mate: null } },
    { uci: "e7e6", pv: ["e7e6", "d2d4"], score: { cp: -40, mate: null } },
  ];
  it("records candidates in White's point of view and the chosen rank", () => {
    const t = buildBotThought({ id: "x", ply: 2, fenBefore: fen, chosenUci: "e7e5", lines, depth: 15, nodes: 1000, elapsedMs: 1500, elo: 2000, reaction: null })!;
    expect(t.label).toBe("1…e5");
    expect(t.candidates.map((c) => [c.san, formatEvalWhite(c.evalWhite)])).toEqual([
      ["c5", "+0.25"],
      ["e5", "+0.30"],
      ["e6", "+0.40"],
    ]);
    expect(t.chosenRank).toBe(2);
    expect(t.note).toBe("Playing at about 2000, I went with e5 instead of my top choice c5 (+0.25).");
    expect(t.plan).toBe("1…e5 2.Nf3");
    expect(t.ideas).toContain("Claims space in the center with a pawn.");
    expect(t.standing).toBe("I'm slightly worse (about 0.3 of a pawn).");
  });
  it("flags an only move", () => {
    const forced = [
      { uci: "c7c5", pv: ["c7c5"], score: { cp: 100, mate: null } },
      { uci: "e7e5", pv: ["e7e5"], score: { cp: -200, mate: null } },
    ];
    const t = buildBotThought({ id: "y", ply: 2, fenBefore: fen, chosenUci: "c7c5", lines: forced, depth: 15, nodes: 1, elapsedMs: 1, elo: 2000, reaction: null })!;
    expect(t.chosenRank).toBe(1);
    expect(t.note).toBe("This was the only good move: everything else was at least 3 pawns worse.");
  });
});

describe("candidate ranking", () => {
  const line = (uci: string, depth: number, cp: number | null, mate: number | null = null): EngineLine => ({ multipv: 0, uci, pv: [uci], score: { cp, mate }, depth });
  const group = (...ls: EngineLine[]) => {
    const m = new Map<number, Map<string, EngineLine>>();
    for (const l of ls) {
      if (!m.has(l.depth)) m.set(l.depth, new Map());
      m.get(l.depth)!.set(l.uci, l);
    }
    return m;
  };
  it("uses the deepest complete depth when the search stopped mid-iteration, best first", () => {
    // Depth 17 complete (4 lines); depth 18 only re-searched c7c5 before the time ran out.
    const m = group(line("e7e5", 17, -22), line("c7c5", 17, -20), line("b8c6", 17, -39), line("c7c6", 17, -44), line("c7c5", 18, -34));
    expect(rankedLines(m, 4).map((l) => [l.multipv, l.uci, l.score.cp])).toEqual([
      [1, "c7c5", -20],
      [2, "e7e5", -22],
      [3, "b8c6", -39],
      [4, "c7c6", -44],
    ]);
  });
  it("takes a fully reported deeper iteration", () => {
    const m = group(line("e2e4", 10, 30), line("d2d4", 10, 25), line("d2d4", 11, 35), line("e2e4", 11, 28));
    expect(rankedLines(m, 2).map((l) => l.uci)).toEqual(["d2d4", "e2e4"]);
  });
  it("handles positions with fewer legal moves than MultiPV and caps the count", () => {
    expect(rankedLines(group(line("e1e2", 20, -50)), 4).map((l) => l.uci)).toEqual(["e1e2"]);
    const five = group(line("a", 9, 1), line("b", 9, 2), line("c", 9, 3), line("d", 9, 4), line("e", 9, 5));
    expect(rankedLines(five, 4).map((l) => l.uci)).toEqual(["e", "d", "c", "b"]);
  });
  it("orders mates correctly", () => {
    expect(scoreValue({ cp: null, mate: 2 })).toBeGreaterThan(scoreValue({ cp: null, mate: 5 }));
    expect(scoreValue({ cp: null, mate: 5 })).toBeGreaterThan(scoreValue({ cp: 900, mate: null }));
    expect(scoreValue({ cp: -900, mate: null })).toBeGreaterThan(scoreValue({ cp: null, mate: -5 }));
    expect(scoreValue({ cp: null, mate: -5 })).toBeGreaterThan(scoreValue({ cp: null, mate: -1 }));
  });
});

import { describe, expect, it } from "vitest";
import { identifyOpening, isBookPosition, openingForPosition, searchOpenings } from "../src/openings";
import { START_FEN, replayUci } from "../src/rules";

describe("opening identification", () => {
  it("identifies the Italian Game", () => {
    const r = identifyOpening(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]);
    expect(r?.opening.name).toMatch(/^Italian Game/);
    expect(r?.opening.eco).toBe("C50");
  });

  it("identifies the Sicilian and Queen's Gambit", () => {
    expect(identifyOpening(["e2e4", "c7c5"])?.opening.name).toMatch(/^Sicilian Defense/);
    expect(identifyOpening(["d2d4", "d7d5", "c2c4"])?.opening.name).toMatch(/^Queen's Gambit/);
  });

  it("recognises transpositions by position, not move order", () => {
    // Reach the Queen's Gambit position via c4 first.
    const r = identifyOpening(["c2c4", "d7d5", "d2d4"]);
    expect(r?.opening.name).toMatch(/^Queen's Gambit/);
  });

  it("does not misidentify an unknown continuation as a different opening", () => {
    const r = identifyOpening(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "a7a6"]);
    // deepest known position is the Italian Game after Bc4; a6 is off-book but the Italian label remains.
    expect(r?.opening.eco).toBe("C50");
    expect(r?.ply).toBe(5);
  });

  it("book detection and search work", () => {
    expect(isBookPosition(START_FEN)).toBe(false);
    expect(isBookPosition(replayUci(["e2e4"]).fen())).toBe(true);
    expect(openingForPosition(replayUci(["e2e4", "c7c5"]).fen())?.eco).toBe("B20");
    expect(searchOpenings("london").length).toBeGreaterThan(0);
  });
});

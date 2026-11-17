import { describe, expect, it } from "vitest";
import { averageCentipawnLoss, classifyMove, gameAccuracy, moveAccuracy, winChance, winChanceFromCp } from "../src/analysis";

const cp = (n: number) => ({ cp: n, mate: null });
const mate = (n: number) => ({ cp: null, mate: n });

describe("win chance and accuracy", () => {
  it("maps evaluations to calibrated win chances", () => {
    expect(winChanceFromCp(0)).toBeCloseTo(50, 6);
    expect(winChanceFromCp(100)).toBeGreaterThan(55);
    expect(winChanceFromCp(-100)).toBeLessThan(45);
    expect(winChance(mate(3))).toBe(100);
    expect(winChance(mate(-3))).toBe(0);
  });

  it("perfect moves score ~100, big drops score low", () => {
    expect(moveAccuracy(50, 50)).toBeCloseTo(100, 0);
    expect(moveAccuracy(50, 20)).toBeLessThan(30);
  });

  it("derives per-side game accuracy and ACPL from evaluations", () => {
    // Plies: W,B,W,B,W,B. White's 2nd move (index 2) drops 51→25 (white POV). Black is near-perfect.
    const wc = [50, 49, 51, 25, 27, 26, 27];
    const acc = gameAccuracy({ winChances: wc });
    expect(acc.white).not.toBeNull();
    expect(acc.black).not.toBeNull();
    expect(acc.black!).toBeGreaterThan(acc.white!);
    expect(acc.black!).toBeLessThanOrEqual(100);
    expect(averageCentipawnLoss([0, 10, 5, 300, 0, 20], "b")).toBeCloseTo(110, 1);
  });
});

describe("move classification", () => {
  const base = {
    secondBestAfter: null,
    legalMoveCount: 30,
    isBook: false,
    sacrificedMaterial: 0,
    mover: "w" as const,
  };

  it("labels the engine move as Best and tiny deviations as Excellent/Good", () => {
    expect(classifyMove({ ...base, before: cp(20), after: cp(20), bestAfter: cp(20), playedIsBest: true }).classification).toBe("BEST");
    expect(classifyMove({ ...base, before: cp(20), after: cp(10), bestAfter: cp(20), playedIsBest: false }).classification).toBe("EXCELLENT");
    expect(classifyMove({ ...base, before: cp(20), after: cp(-25), bestAfter: cp(20), playedIsBest: false }).classification).toBe("GOOD");
  });

  it("grades losses of winning chances into inaccuracy, mistake and blunder", () => {
    expect(classifyMove({ ...base, before: cp(0), after: cp(-110), bestAfter: cp(0), playedIsBest: false }).classification).toBe("INACCURACY");
    expect(classifyMove({ ...base, before: cp(0), after: cp(-230), bestAfter: cp(0), playedIsBest: false }).classification).toBe("MISTAKE");
    expect(classifyMove({ ...base, before: cp(0), after: cp(-600), bestAfter: cp(0), playedIsBest: false }).classification).toBe("BLUNDER");
  });

  it("allowing a forced mate is a blunder; missing one is never better than an inaccuracy", () => {
    expect(classifyMove({ ...base, before: cp(50), after: mate(-2), bestAfter: cp(50), playedIsBest: false }).classification).toBe("BLUNDER");
    expect(classifyMove({ ...base, before: mate(3), after: cp(900), bestAfter: mate(2), playedIsBest: false }).classification).toBe("INACCURACY");
    expect(classifyMove({ ...base, before: mate(3), after: cp(100), bestAfter: mate(2), playedIsBest: false }).classification).toBe("MISTAKE");
  });

  it("forced and book moves are labelled as such", () => {
    expect(classifyMove({ ...base, legalMoveCount: 1, before: cp(0), after: cp(-500), bestAfter: cp(-500), playedIsBest: true }).classification).toBe("FORCED");
    expect(classifyMove({ ...base, isBook: true, before: cp(0), after: cp(0), bestAfter: cp(0), playedIsBest: true }).classification).toBe("BOOK");
  });

  it("a sacrifice is Brilliant only when sound and critical; otherwise Great or Best", () => {
    const critical = { ...base, before: cp(30), after: cp(60), bestAfter: cp(60), secondBestAfter: cp(-200), playedIsBest: true };
    expect(classifyMove({ ...critical, sacrificedMaterial: 3 }).classification).toBe("BRILLIANT");
    expect(classifyMove({ ...critical, sacrificedMaterial: 0 }).classification).toBe("GREAT");
    // Unsound sacrifice that loses: never brilliant.
    expect(classifyMove({ ...base, before: cp(30), after: cp(-400), bestAfter: cp(60), secondBestAfter: cp(50), playedIsBest: false, sacrificedMaterial: 3 }).classification).toBe("BLUNDER");
    // Sacrifice when already crushing: just Best.
    expect(classifyMove({ ...critical, before: cp(900), after: cp(950), bestAfter: cp(950), sacrificedMaterial: 3 }).classification).toBe("BEST");
  });

  it("black's perspective is handled symmetrically", () => {
    expect(classifyMove({ ...base, mover: "b", before: cp(0), after: cp(600), bestAfter: cp(0), playedIsBest: false }).classification).toBe("BLUNDER");
    expect(classifyMove({ ...base, mover: "b", before: cp(0), after: cp(-20), bestAfter: cp(-20), playedIsBest: true }).classification).toBe("BEST");
  });
});

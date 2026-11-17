import { describe, expect, it } from "vitest";
import { expectedScore, inflateForInactivity, isProvisional, rateGame, updateRating } from "../src/glicko2";

describe("Glicko-2", () => {
  it("reproduces the worked example from Glickman's paper", () => {
    const player = { rating: 1500, deviation: 200, volatility: 0.06 };
    const result = updateRating(
      player,
      [
        { opponent: { rating: 1400, deviation: 30, volatility: 0.06 }, score: 1 },
        { opponent: { rating: 1550, deviation: 100, volatility: 0.06 }, score: 0 },
        { opponent: { rating: 1700, deviation: 300, volatility: 0.06 }, score: 0 },
      ],
      { tau: 0.5, minDeviation: 0, maxDeviation: 1000 },
    );
    expect(result.rating).toBeCloseTo(1464.06, 1);
    expect(result.deviation).toBeCloseTo(151.52, 1);
    expect(result.volatility).toBeCloseTo(0.05999, 4);
  });

  it("winner gains, loser loses, symmetric for equal players", () => {
    const a = { rating: 1500, deviation: 100, volatility: 0.06 };
    const b = { rating: 1500, deviation: 100, volatility: 0.06 };
    const { white, black } = rateGame(a, b, "WHITE_WINS");
    expect(white.rating).toBeGreaterThan(1500);
    expect(black.rating).toBeLessThan(1500);
    expect(white.rating - 1500).toBeCloseTo(1500 - black.rating, 6);
    expect(white.deviation).toBeLessThan(100);
  });

  it("draw moves ratings toward each other, and equal players stay put", () => {
    const equal = rateGame({ rating: 1500, deviation: 80, volatility: 0.06 }, { rating: 1500, deviation: 80, volatility: 0.06 }, "DRAW");
    expect(equal.white.rating).toBeCloseTo(1500, 6);
    const uneven = rateGame({ rating: 1700, deviation: 80, volatility: 0.06 }, { rating: 1300, deviation: 80, volatility: 0.06 }, "DRAW");
    expect(uneven.white.rating).toBeLessThan(1700);
    expect(uneven.black.rating).toBeGreaterThan(1300);
  });

  it("new (high-RD) players move faster than established players", () => {
    const newbie = rateGame({ rating: 1500, deviation: 350, volatility: 0.06 }, { rating: 1500, deviation: 60, volatility: 0.06 }, "WHITE_WINS");
    expect(newbie.white.rating - 1500).toBeGreaterThan(1500 - newbie.black.rating);
  });

  it("uncertainty grows with inactivity and marks provisional status", () => {
    const r = { rating: 1500, deviation: 60, volatility: 0.06 };
    const inflated = inflateForInactivity(r, 30);
    expect(inflated.deviation).toBeGreaterThan(60);
    expect(isProvisional(350)).toBe(true);
    expect(isProvisional(60)).toBe(false);
  });

  it("expected score is 0.5 for equal ratings and > 0.5 for the stronger player", () => {
    expect(expectedScore({ rating: 1500, deviation: 50, volatility: 0.06 }, { rating: 1500, deviation: 50, volatility: 0.06 })).toBeCloseTo(0.5, 6);
    expect(expectedScore({ rating: 1700, deviation: 50, volatility: 0.06 }, { rating: 1500, deviation: 50, volatility: 0.06 })).toBeGreaterThan(0.7);
  });
});

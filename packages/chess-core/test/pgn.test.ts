import { describe, expect, it } from "vitest";
import { buildPgn, parsePgn } from "../src/pgn";

describe("PGN", () => {
  it("builds and round-trips a PGN with clocks", () => {
    const pgn = buildPgn({
      white: "alice",
      black: "bob",
      result: "1-0",
      whiteElo: 1500,
      blackElo: 1480,
      timeControl: "300",
      sans: ["e4", "e5", "Nf3", "Nc6", "Bb5"],
      clocksMs: [300000, 299000, 298000, 297000, 296000],
      date: new Date("2026-01-02T00:00:00Z"),
    });
    expect(pgn).toContain('[White "alice"]');
    expect(pgn).toContain('[Date "2026.01.02"]');
    expect(pgn).toContain("1. e4 { [%clk 0:05:00] }");
    const parsed = parsePgn(pgn);
    expect(parsed.sans).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    expect(parsed.ucis).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]);
    expect(parsed.fens.length).toBe(6);
  });

  it("rejects invalid PGN", () => {
    expect(() => parsePgn("1. e4 e5 2. Qh5xx")).toThrow();
  });
});

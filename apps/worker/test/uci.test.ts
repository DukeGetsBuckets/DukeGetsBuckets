import { describe, expect, it } from "vitest";
import { parseInfo } from "../src/engine/uci";

describe("UCI info parsing", () => {
  it("parses cp scores, depth, multipv and pv", () => {
    const l = parseInfo("info depth 18 seldepth 25 multipv 1 score cp 34 nodes 123456 nps 1000000 time 120 pv e2e4 e7e5 g1f3");
    expect(l).toEqual({ multipv: 1, cp: 34, mate: null, depth: 18, pv: ["e2e4", "e7e5", "g1f3"], nodes: 123456 });
  });
  it("parses mate scores and bound markers", () => {
    const l = parseInfo("info depth 20 multipv 2 score mate -3 lowerbound nodes 10 pv d8h4");
    expect(l).toMatchObject({ multipv: 2, cp: null, mate: -3, depth: 20, pv: ["d8h4"] });
  });
  it("ignores lines without a score", () => {
    expect(parseInfo("info depth 5 currmove e2e4 currmovenumber 1")).toBeNull();
  });
});

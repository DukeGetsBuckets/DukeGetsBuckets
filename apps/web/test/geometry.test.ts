import { describe, expect, it } from "vitest";
import { isPromotionGeometry, parseFenPieces, pointToSquare, premoveDests, squareToXY, xyToSquare } from "../components/board/geometry";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("board geometry", () => {
  it("maps squares to grid coordinates in both orientations", () => {
    expect(squareToXY("a1", "white")).toEqual({ x: 0, y: 7 });
    expect(squareToXY("h8", "white")).toEqual({ x: 7, y: 0 });
    expect(squareToXY("a1", "black")).toEqual({ x: 7, y: 0 });
    expect(xyToSquare(0, 7, "white")).toBe("a1");
    expect(xyToSquare(0, 0, "black")).toBe("h1");
  });

  it("maps pointer positions to squares", () => {
    expect(pointToSquare(10, 390, 400, "white")).toBe("a1");
    expect(pointToSquare(395, 5, 400, "white")).toBe("h8");
    expect(pointToSquare(-1, 5, 400, "white")).toBeNull();
  });

  it("parses FEN placement", () => {
    const pieces = parseFenPieces(START);
    expect(pieces).toHaveLength(32);
    expect(pieces.find((p) => p.square === "e1")).toMatchObject({ color: "w", type: "k" });
    expect(pieces.find((p) => p.square === "d8")).toMatchObject({ color: "b", type: "q" });
  });

  it("computes premove destinations geometrically, excluding own pieces", () => {
    expect(premoveDests(START, "e2").sort()).toEqual(["d3", "e3", "e4", "f3"]);
    expect(premoveDests(START, "g1").sort()).toEqual(["f3", "h3"]); // e2 is own pawn
    const knight = premoveDests("8/8/8/3N4/8/8/8/K6k w - - 0 1", "d5");
    expect(knight).toHaveLength(8);
    const king = premoveDests("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1");
    expect(king).toContain("g1");
    expect(king).toContain("c1");
    expect(king).not.toContain("a1");
  });

  it("detects promotion geometry", () => {
    expect(isPromotionGeometry("8/P7/8/8/8/8/8/K6k w - - 0 1", "a7", "a8")).toBe(true);
    expect(isPromotionGeometry(START, "e2", "e4")).toBe(false);
  });
});

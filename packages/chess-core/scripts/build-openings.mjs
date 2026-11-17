// Converts the lichess-org/chess-openings TSV dataset (CC0) into a JSON module with EPD position keys
// so openings can be recognised by position (transpositions) rather than only by move order.
import fs from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";

const dataDir = path.resolve(import.meta.dirname, "../data");
const out = path.resolve(import.meta.dirname, "../src/openings-data.json");
const rows = [];
for (const file of ["a", "b", "c", "d", "e"]) {
  const text = fs.readFileSync(path.join(dataDir, `${file}.tsv`), "utf8");
  const lines = text.split("\n").slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [eco, name, pgn] = line.split("\t");
    if (!eco || !name || !pgn) continue;
    const chess = new Chess();
    const sans = pgn.replace(/\d+\.\s*/g, "").trim().split(/\s+/);
    let ok = true;
    for (const san of sans) {
      try {
        chess.move(san);
      } catch {
        ok = false;
        break;
      }
    }
    if (!ok) {
      console.warn("skip (illegal):", eco, name, pgn);
      continue;
    }
    const epd = chess.fen().split(" ").slice(0, 4).join(" ");
    rows.push([eco, name, sans.join(" "), epd, sans.length]);
  }
}
fs.writeFileSync(out, JSON.stringify(rows));
console.log(`wrote ${rows.length} openings to ${path.relative(process.cwd(), out)}`);

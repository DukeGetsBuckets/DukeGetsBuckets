// Copies the in-browser Stockfish build (stockfish.js, GPL-3.0) into public/engine so Next.js serves it
// as a static asset. Runs before `next dev` and `next build`; the copied files are not committed.
import { copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = realpathSync(join(webDir, "node_modules", "stockfish"));
const outDir = join(webDir, "public", "engine");
mkdirSync(outDir, { recursive: true });

const files = [
  ["bin/stockfish-19-lite-single.js", "stockfish-19-lite-single.js"],
  ["bin/stockfish-19-lite-single.wasm", "stockfish-19-lite-single.wasm"],
  ["Copying.txt", "COPYING.txt"],
];
for (const [from, to] of files) {
  copyFileSync(join(pkgDir, from), join(outDir, to));
}
const kb = Math.round(statSync(join(outDir, "stockfish-19-lite-single.wasm")).size / 1024);
console.log(`engine: copied stockfish 19 lite (single-threaded, ${kb} KiB wasm) to public/engine`);

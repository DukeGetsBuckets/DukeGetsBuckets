// Minifies src/bookmarklet.js into a javascript: URL body that the worker
// serves. Runs automatically before `wrangler dev` / `wrangler deploy`.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

const result = await build({
  entryPoints: ["src/bookmarklet.js"],
  bundle: false,
  minify: true,
  write: false,
  target: ["safari15"],
  legalComments: "none",
  format: "iife",
});
let code = result.outputFiles[0].text.trim();
// Characters that break javascript: URLs when pasted into a bookmark.
for (const bad of ["%", "#", "\n"]) {
  if (code.includes(bad)) throw new Error(`bookmarklet contains '${bad}' which breaks javascript: URLs`);
}
mkdirSync("src/generated", { recursive: true });
writeFileSync("src/generated/bookmarklet.min.js.txt", code);
console.log(`bookmarklet: ${code.length} bytes`);

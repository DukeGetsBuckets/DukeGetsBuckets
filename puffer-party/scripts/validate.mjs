// Usage: node scripts/validate.mjs [questions/part-a.json ...]
// With no arguments, validates every questions/*.json file.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keyOf } from "../src/match.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(join(root, "questions")).filter((f) => f.endsWith(".json")).sort().map((f) => join(root, "questions", f));

let problems = 0;
let total = 0;
const seenIds = new Map();
for (const file of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`${file}: invalid JSON: ${err.message}`);
    problems++;
    continue;
  }
  for (const q of data) {
    total++;
    const tag = `${file} [${q.id}]`;
    if (!q.id || !q.prompt || !Array.isArray(q.answers)) {
      console.log(`${tag}: needs id, prompt and answers`);
      problems++;
      continue;
    }
    if (seenIds.has(q.id)) {
      console.log(`${tag}: duplicate id (also in ${seenIds.get(q.id)})`);
      problems++;
    }
    seenIds.set(q.id, file);
    const n = q.answers.length;
    if (n < 40 || n > 140) {
      console.log(`${tag}: has ${n} answers (needs 40-140)`);
      problems++;
    }
    const owner = new Map();
    q.answers.forEach((raw, i) => {
      const names = raw.split("|").map((s) => s.trim()).filter(Boolean);
      if (!names.length) {
        console.log(`${tag}: empty answer at position ${i}`);
        problems++;
      }
      for (const name of names) {
        const k = keyOf(name);
        if (!k) continue;
        if (owner.has(k) && owner.get(k) !== i) {
          console.log(`${tag}: "${name}" collides with "${q.answers[owner.get(k)].split("|")[0]}"`);
          problems++;
        }
        owner.set(k, i);
      }
    });
    console.log(`${tag}: ${n} answers`);
  }
}
console.log(`\n${total} questions checked, ${problems} problem(s)`);
process.exit(problems ? 1 : 0);

#!/usr/bin/env node
// Seeds a LOCAL dev server with demo accounts, generated photos and burns.
//   npm run dev               (in one terminal)
//   node scripts/seed-local.mjs [http://localhost:5173]
// Refuses to run against anything but localhost. Prints the demo passwords.

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const base = process.argv[2] ?? "http://localhost:5173";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error("seed-local only runs against a local dev server.");
  process.exit(1);
}

// ── tiny PNG encoder for procedural "photos" ──
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const hue = (seed * 67) % 360;
  const cx = w * (0.3 + ((seed * 13) % 40) / 100);
  const cy = h * (0.35 + ((seed * 7) % 30) / 100);
  const r = Math.min(w, h) * 0.28;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      const d = Math.hypot(x - cx, y - cy);
      const inCircle = d < r;
      const shade = inCircle ? 0.85 - (d / r) * 0.35 : 0.18 + t * 0.35;
      const tint = (hue + (inCircle ? 180 : 0)) * (Math.PI / 180);
      const px = (y * (w * 3 + 1)) + 1 + x * 3;
      raw[px] = Math.min(255, 255 * shade * (0.75 + 0.25 * Math.cos(tint)));
      raw[px + 1] = Math.min(255, 255 * shade * (0.75 + 0.25 * Math.cos(tint - 2.1)));
      raw[px + 2] = Math.min(255, 255 * shade * (0.75 + 0.25 * Math.cos(tint + 2.1)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ── API client ──
async function call(path, { method = "POST", body, cookie } = {}) {
  const headers = { "x-bb2-csrf": "1" };
  if (cookie) headers.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error ?? ""}`);
  return { data, cookie: setCookie?.split(";")[0] };
}

const names = ["demo_sawyer", "demo_torch", "demo_ember", "demo_ash"];
const captions = ["rate my new haircut", "first time grilling, be nice", "my fit for the wedding", null];
const burns = [
  "This haircut has a restraining order against combs.",
  "Looks like the photo was taken by a hostage.",
  "Bro dressed for a job interview at a haunted house.",
  "The lighting is doing its best and it's still not enough.",
  "10/10 photo, 2/10 decisions.",
];

const accounts = [];
for (const username of names) {
  const password = randomBytes(9).toString("base64url");
  let session;
  try {
    ({ cookie: session } = await call("/api/auth/signup", { body: { username, password, confirmPassword: password, agree: true } }));
  } catch (err) {
    console.log(`skip ${username}: ${err.message}`);
    continue;
  }
  accounts.push({ username, password, session });
}

let seed = 1;
const posts = [];
for (const [i, acct] of accounts.entries()) {
  const form = new FormData();
  const [w, h] = [[900, 1200], [1200, 800], [1000, 1000], [800, 1400]][i % 4];
  form.append("image", new Blob([png(w, h, seed++)], { type: "image/png" }), "demo.png");
  form.append("consent", "yes");
  if (captions[i]) form.append("caption", captions[i]);
  const { data } = await call("/api/posts", { body: form, cookie: acct.session });
  posts.push(data.post.id);
}
for (const [i, postId] of posts.entries()) {
  for (let j = 0; j < 3 && accounts.length > 1; j++) {
    const acct = accounts[(i + j + 1) % accounts.length];
    await call(`/api/posts/${postId}/comments`, { body: { body: burns[(i + j) % burns.length] }, cookie: acct.session }).catch(() => {});
  }
}

console.log(`Seeded ${accounts.length} accounts and ${posts.length} photos on ${base}\n`);
for (const a of accounts) console.log(`  ${a.username.padEnd(18)} ${a.password}`);
console.log("\nMake one an admin:\n  npx wrangler d1 execute sawyer-burner --local --command \"UPDATE users SET role='admin' WHERE username='demo_sawyer'\"");
if (process.env.SEED_SESSIONS_OUT) writeFileSync(process.env.SEED_SESSIONS_OUT, JSON.stringify(accounts, null, 2));

#!/usr/bin/env node
// Entry point of the all-in-one Cloudflare Containers demo image.
//
// Boots and supervises: PostgreSQL, Redis, the realtime service, the analysis worker (Stockfish),
// the Next.js app and nginx (the only listener on port 8080, started last so the port doubles as a
// readiness signal). The database lives on the container's ephemeral disk, so it is restored from the
// latest snapshot kept by the Worker's Durable Object on boot and uploaded again whenever it changes.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";

// Recent output of every process is kept in memory and shipped to the Worker (see shipLogs) so
// failures inside the container can be diagnosed; the platform exposes no container logs to the CLI.
const BOOT_ID = Math.random().toString(36).slice(2, 10);
const RING_MAX_BYTES = 120_000;
const ring = [];
let ringBytes = 0;
let ringVersion = 0;
let shippedVersion = -1;
function capture(text) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    const entry = `${new Date().toISOString()} ${line.slice(0, 800)}`;
    ring.push(entry);
    ringBytes += entry.length + 1;
    while (ringBytes > RING_MAX_BYTES && ring.length > 1) ringBytes -= ring.shift().length + 1;
  }
  ringVersion++;
}
const log = (...args) => {
  const line = ["[supervisor]", ...args].join(" ");
  console.log(line);
  capture(line);
};

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
if (!PUBLIC_URL) die("PUBLIC_URL is required");
for (const key of ["BETTER_AUTH_SECRET", "REALTIME_JWT_SECRET"]) {
  if (!process.env[key]) die(`${key} is required`);
}
const PUBLIC_HOST = new URL(PUBLIC_URL).host;
const SNAPSHOT_TOKEN = process.env.SNAPSHOT_TOKEN ?? "";
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 60_000);
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;

// A snapshot is only valid if it is a complete pg_dump of the app database: the schema is present and
// pg_dump wrote its completion footer. (A dump taken while PostgreSQL is going down can be empty.)
const DUMP_MARKERS = ['CREATE TABLE public."User"', "-- PostgreSQL database dump complete"];
const isCompleteDump = (sql) => DUMP_MARKERS.every((m) => sql.includes(m));

const PGBIN = "/usr/lib/postgresql/16/bin";
const PGDATA = "/var/lib/tempo/pg";
const PSQL = ["-h", "127.0.0.1", "-p", "5432", "-U", "postgres"];

let shuttingDown = false;
let dbReady = false;
let snapshotsEnabled = Boolean(SNAPSHOT_TOKEN);
let snapshotting = false;
let lastStamp = null;
const managed = new Map();

function die(message) {
  console.error("[supervisor] FATAL", message);
  process.exit(1);
}

async function shipLogs() {
  if (!SNAPSHOT_TOKEN || ringVersion === shippedVersion) return;
  const version = ringVersion;
  try {
    const res = await fetch(`${PUBLIC_URL}/__tempo/logs`, {
      method: "POST",
      headers: { "x-tempo-snapshot-token": SNAPSHOT_TOKEN, "x-tempo-boot": BOOT_ID, "content-type": "text/plain" },
      body: ring.join("\n"),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) shippedVersion = version;
  } catch {
    /* best effort */
  }
}

const idOf = (flag, user) => Number(execFileSync("id", [flag, user]).toString().trim());

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed (${res.status ?? res.signal})`);
}

async function waitFor(label, check, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      /* not ready yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${label} did not become ready in ${timeoutMs} ms`);
    await sleep(400);
  }
}

// ───────────────────────── process management ─────────────────────────

function launch(entry) {
  const proc = spawn(entry.cmd, entry.args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: entry.opts.cwd,
    env: entry.opts.env ?? process.env,
    uid: entry.opts.uid,
    gid: entry.opts.gid,
    // Own session for PostgreSQL: a stop signal sent to the whole container's process group must not
    // shut it down before the supervisor has taken its final snapshot.
    detached: entry.opts.detached === true,
  });
  entry.proc = proc;
  for (const [stream, sink] of [[proc.stdout, process.stdout], [proc.stderr, process.stderr]]) {
    let partial = "";
    stream.on("data", (chunk) => {
      sink.write(chunk);
      const lines = (partial + chunk.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      capture(lines.map((l) => `[${entry.name}] ${l}`).join("\n"));
    });
  }
  proc.on("error", (err) => log(`${entry.name} failed to spawn: ${err.message}`));
  proc.on("exit", (code, signal) => {
    entry.proc = null;
    if (shuttingDown || entry.stopping) return;
    log(`${entry.name} exited (code=${code} signal=${signal})`);
    if (entry.opts.critical) return void shutdown(1, `${entry.name} died`);
    const now = Date.now();
    entry.starts = entry.starts.filter((t) => now - t < 120_000);
    entry.starts.push(now);
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(entry.starts.length - 1, 4));
    log(`${entry.name} restarting in ${delay} ms`);
    setTimeout(() => {
      if (!shuttingDown) launch(entry);
    }, delay);
  });
}

function manage(name, cmd, args, opts = {}) {
  const entry = { name, cmd, args, opts, proc: null, starts: [Date.now()], stopping: false };
  managed.set(name, entry);
  launch(entry);
}

async function stop(name, signal = "SIGTERM", graceMs = 10_000) {
  const entry = managed.get(name);
  if (!entry?.proc) return;
  entry.stopping = true;
  const proc = entry.proc;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill(signal);
  const timer = setTimeout(() => proc.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

async function shutdown(code = 0, reason = "signal") {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down: ${reason}`);
  await shipLogs();
  await stop("nginx", "SIGQUIT", 5000);
  await Promise.all(["web", "realtime", "worker"].map((name) => stop(name, "SIGTERM", 10_000)));
  if (dbReady && snapshotsEnabled) {
    snapshotting = false;
    await snapshotIfChanged(true).catch((err) => log("final snapshot failed:", err.message));
  }
  await stop("redis", "SIGTERM", 5000);
  await stop("postgres", "SIGINT", 15_000);
  log("exiting");
  await shipLogs();
  process.exit(code);
}

// ───────────────────────── database + snapshots ─────────────────────────

const psqlScalar = (sql) => {
  const res = spawnSync(`${PGBIN}/psql`, [...PSQL, "-d", "tempo", "-Atc", sql], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
};

function applyMigrations() {
  const dir = "/app/migrations";
  const names = fs.readdirSync(dir).filter((n) => fs.statSync(`${dir}/${n}`).isDirectory()).sort();
  for (const name of names) {
    log(`applying migration ${name}`);
    run(`${PGBIN}/psql`, [...PSQL, "-d", "tempo", "-v", "ON_ERROR_STOP=1", "-q", "-f", `${dir}/${name}/migration.sql`]);
  }
}

async function fetchSnapshot(gen) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${PUBLIC_URL}/__tempo/snapshot?gen=${gen}`, {
        headers: { "x-tempo-snapshot-token": SNAPSHOT_TOKEN },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404) return { status: "none" };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const expected = res.headers.get("x-snapshot-sha256");
      const actual = createHash("sha256").update(body).digest("hex");
      if (expected && expected !== actual) throw new Error("checksum mismatch");
      return { status: "ok", body, savedAt: res.headers.get("x-snapshot-saved-at") };
    } catch (err) {
      log(`snapshot fetch (${gen}) attempt ${attempt} failed: ${err.message}`);
      await sleep(2000);
    }
  }
  return { status: "error" };
}

function recreateDatabase() {
  run(`${PGBIN}/psql`, [...PSQL, "-d", "postgres", "-c", "DROP DATABASE IF EXISTS tempo WITH (FORCE)"]);
  run(`${PGBIN}/psql`, [...PSQL, "-d", "postgres", "-c", "CREATE DATABASE tempo"]);
}

function restoreFrom(buffer) {
  let sql;
  try {
    sql = gunzipSync(buffer);
  } catch {
    log("snapshot is not valid gzip");
    return false;
  }
  if (!isCompleteDump(sql.toString("utf8"))) {
    log(`snapshot is not a complete database dump (${sql.length} bytes uncompressed); skipping it`);
    return false;
  }
  fs.writeFileSync("/tmp/snapshot.sql", sql);
  const res = spawnSync(`${PGBIN}/psql`, [...PSQL, "-d", "tempo", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q", "-f", "/tmp/snapshot.sql"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  fs.rmSync("/tmp/snapshot.sql", { force: true });
  return res.status === 0 && psqlScalar(`SELECT to_regclass('public."User"') IS NOT NULL`) === "t";
}

async function initialiseDatabase() {
  run(`${PGBIN}/psql`, [...PSQL, "-d", "postgres", "-c", "CREATE DATABASE tempo"]);
  if (snapshotsEnabled) {
    let outcome = "none";
    for (const gen of ["latest", "prev"]) {
      const snap = await fetchSnapshot(gen);
      if (snap.status === "none") {
        outcome = gen === "latest" ? "none" : outcome;
        break;
      }
      if (snap.status === "ok" && restoreFrom(snap.body)) {
        log(`restored ${gen} database snapshot (${snap.body.length} bytes, saved ${snap.savedAt ? new Date(Number(snap.savedAt)).toISOString() : "?"})`);
        return;
      }
      log(`could not restore ${gen} snapshot`);
      recreateDatabase();
      outcome = "failed";
    }
    if (outcome === "failed") {
      // Never overwrite a snapshot we could not read: run on an empty database without uploading.
      snapshotsEnabled = false;
      log("WARNING: stored snapshots could not be restored; running on a fresh database with snapshot uploads disabled");
    }
  }
  applyMigrations();
}

/**
 * Dumps the database and gzips it in-process. Success requires pg_dump's own exit status (its "close"
 * event fires after all output has been read) *and* a complete dump; an earlier version judged success by
 * the gzip process alone and once uploaded an empty dump taken while PostgreSQL was shutting down.
 */
function dumpToBuffer() {
  return new Promise((resolve, reject) => {
    const dump = spawn(`${PGBIN}/pg_dump`, [...PSQL, "-d", "tempo", "--no-owner", "--no-privileges", "--no-comments"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    dump.stdout.on("data", (chunk) => chunks.push(chunk));
    dump.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    dump.on("error", reject);
    dump.on("close", (code, signal) => {
      if (code !== 0) return reject(new Error(`pg_dump failed (${code ?? signal}): ${stderr.trim().slice(0, 300)}`));
      const sql = Buffer.concat(chunks);
      if (!isCompleteDump(sql.toString("utf8"))) return reject(new Error(`pg_dump output is incomplete (${sql.length} bytes); not uploading`));
      resolve(gzipSync(sql, { level: 6 }));
    });
  });
}

async function snapshotIfChanged(force = false) {
  if (!snapshotsEnabled || !dbReady || snapshotting) return;
  const stamp = psqlScalar("SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text FROM pg_stat_user_tables");
  if (!force && stamp != null && stamp === lastStamp) return;
  snapshotting = true;
  try {
    const body = await dumpToBuffer();
    if (body.length > MAX_SNAPSHOT_BYTES) throw new Error(`snapshot too large (${body.length} bytes)`);
    const sha = createHash("sha256").update(body).digest("hex");
    const res = await fetch(`${PUBLIC_URL}/__tempo/snapshot`, {
      method: "POST",
      headers: { "x-tempo-snapshot-token": SNAPSHOT_TOKEN, "x-snapshot-sha256": sha, "content-type": "application/gzip" },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${await res.text()}`);
    lastStamp = stamp;
    log(`snapshot uploaded (${body.length} bytes)`);
  } finally {
    snapshotting = false;
  }
}

async function snapshotLoop() {
  while (!shuttingDown) {
    await sleep(SNAPSHOT_INTERVAL_MS);
    if (shuttingDown) break;
    await snapshotIfChanged().catch((err) => log("snapshot failed:", err.message));
  }
}

// ───────────────────────── boot sequence ─────────────────────────

async function main() {
  setInterval(() => void shipLogs(), 5000).unref();
  process.on("SIGTERM", () => void shutdown(0, "SIGTERM"));
  process.on("SIGINT", () => void shutdown(0, "SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error(err);
    void shutdown(1, "uncaught exception");
  });

  const pgUid = idOf("-u", "postgres");
  const pgGid = idOf("-g", "postgres");
  const redisUid = idOf("-u", "redis");
  const redisGid = idOf("-g", "redis");

  log(`starting; boot ${BOOT_ID}; public url ${PUBLIC_URL}; snapshots ${snapshotsEnabled ? "on" : "off"}`);
  const cpu = spawnSync("sh", ["-c", "nproc; grep -m1 'model name' /proc/cpuinfo; grep -m1 -o 'avx2\\|bmi2\\|popcnt' /proc/cpuinfo | head -3 | tr '\\n' ' '; free -m | sed -n 2p; df -h /tmp | tail -1"], { encoding: "utf8" });
  log(`host: ${cpu.stdout.replace(/\n/g, " | ")}`);
  fs.rmSync(PGDATA, { recursive: true, force: true });
  fs.mkdirSync("/var/lib/tempo", { recursive: true });
  fs.chmodSync("/var/lib/tempo", 0o755); // the postgres user must be able to traverse the parent directory
  fs.mkdirSync(PGDATA, { mode: 0o700 });
  fs.chownSync(PGDATA, pgUid, pgGid);
  run(`${PGBIN}/initdb`, ["-D", PGDATA, "-A", "trust", "-E", "UTF8", "--locale=C.UTF-8", "-U", "postgres"], { uid: pgUid, gid: pgGid });
  manage(
    "postgres",
    `${PGBIN}/postgres`,
    ["-D", PGDATA, "-c", "listen_addresses=127.0.0.1", "-c", "port=5432", "-c", "unix_socket_directories=/tmp", "-c", "max_connections=80", "-c", "shared_buffers=192MB", "-c", "log_min_messages=warning"],
    { uid: pgUid, gid: pgGid, critical: true, detached: true },
  );
  manage(
    "redis",
    "/usr/bin/redis-server",
    ["--bind", "127.0.0.1", "--port", "6379", "--save", "", "--appendonly", "no", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction", "--dir", "/tmp"],
    { uid: redisUid, gid: redisGid, critical: true },
  );
  await waitFor("postgres", () => spawnSync(`${PGBIN}/pg_isready`, ["-h", "127.0.0.1", "-p", "5432", "-U", "postgres"]).status === 0, 60_000);
  await waitFor("redis", () => spawnSync("redis-cli", ["-h", "127.0.0.1", "ping"], { encoding: "utf8" }).stdout?.trim() === "PONG", 30_000);

  await initialiseDatabase();
  dbReady = true;
  lastStamp = psqlScalar("SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text FROM pg_stat_user_tables");

  const appEnv = {
    PATH: process.env.PATH,
    HOME: "/tmp",
    NODE_ENV: "production",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/tempo?schema=public",
    DATABASE_POOL_MAX: "8",
    REDIS_URL: "redis://127.0.0.1:6379",
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    REALTIME_JWT_SECRET: process.env.REALTIME_JWT_SECRET,
    BETTER_AUTH_URL: PUBLIC_URL,
    NEXT_PUBLIC_WEB_URL: PUBLIC_URL,
    NEXT_PUBLIC_REALTIME_URL: PUBLIC_URL,
    REALTIME_PUBLIC_URL: PUBLIC_URL,
    ALLOWED_ORIGINS: PUBLIC_URL,
    AUTH_IP_HEADERS: "cf-connecting-ip,x-forwarded-for",
    AUTH_SIGNUP_RATE_LIMIT: process.env.AUTH_SIGNUP_RATE_LIMIT ?? "10",
    REQUIRE_EMAIL_VERIFICATION: "false",
    REALTIME_PORT: "4000",
    STOCKFISH_PATH: "/usr/games/stockfish",
    STOCKFISH_THREADS: "1",
    STOCKFISH_HASH_MB: "64",
    ANALYSIS_DEPTH: process.env.ANALYSIS_DEPTH ?? "14",
    ANALYSIS_MULTIPV: "2",
    WORKER_CONCURRENCY: "1",
    WORKER_HEALTH_PORT: "4100",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  };
  manage("realtime", "node", ["/app/realtime/dist/index.js"], { cwd: "/app/realtime", env: appEnv });
  manage("worker", "node", ["/app/worker/dist/index.js"], { cwd: "/app/worker", env: appEnv });
  manage("web", "node", ["/app/web/apps/web/server.js"], { cwd: "/app/web/apps/web", env: { ...appEnv, PORT: "3000", HOSTNAME: "127.0.0.1" } });

  const ok = async (url) => (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  // Not fatal: if a service is slow or failing, keep going so the container stays reachable and its
  // logs can be read; the supervisor keeps restarting failed services.
  for (const [label, url, timeout] of [["realtime", "http://127.0.0.1:4000/health", 90_000], ["worker", "http://127.0.0.1:4100/", 90_000], ["web", "http://127.0.0.1:3000/login", 120_000]]) {
    await waitFor(label, () => ok(url), timeout).catch((err) => log(`WARNING: ${err.message}`));
  }

  const conf = fs.readFileSync("/app/nginx.conf.template", "utf8").replaceAll("__PUBLIC_HOST__", PUBLIC_HOST);
  fs.writeFileSync("/tmp/nginx.conf", conf);
  manage("nginx", "nginx", ["-c", "/tmp/nginx.conf", "-g", "daemon off;"]);
  log("ready: listening on :8080");
  void snapshotLoop();
}

main().catch((err) => {
  console.error("[supervisor] boot failed:", err);
  void shutdown(1, "boot failure");
});

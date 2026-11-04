// D1 schema bootstrap + small typed query helpers.
// The schema is created lazily once per isolate (cached promise). The same statements
// live in worker/schema.sql for reference / manual migrations.

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL,
    is_guest INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT,
    friend_code TEXT NOT NULL UNIQUE,
    school_id TEXT,
    xp INTEGER NOT NULL DEFAULT 0,
    coins INTEGER NOT NULL DEFAULT 0,
    car TEXT NOT NULL,
    stats TEXT NOT NULL,
    unlocked TEXT NOT NULL DEFAULT '[]',
    achievements TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_players_account_name ON players(name_lower) WHERE is_guest = 0`,
  `CREATE INDEX IF NOT EXISTS idx_players_school ON players(school_id)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id)`,

  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    time_ms INTEGER NOT NULL,
    achieved_at INTEGER NOT NULL,
    day_key TEXT NOT NULL,
    week_key TEXT NOT NULL,
    mode TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_track_day ON runs(track_id, day_key, time_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_track_week ON runs(track_id, week_key, time_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_player_track ON runs(player_id, track_id, achieved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_player_day ON runs(player_id, day_key)`,

  `CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    time_ms INTEGER NOT NULL,
    splits TEXT NOT NULL,
    car TEXT NOT NULL,
    replay BLOB,
    respawns INTEGER NOT NULL DEFAULT 0,
    top_speed REAL NOT NULL DEFAULT 0,
    mode TEXT NOT NULL,
    achieved_at INTEGER NOT NULL,
    UNIQUE (track_id, player_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_records_track_time ON records(track_id, time_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_records_player ON records(player_id)`,

  `CREATE TABLE IF NOT EXISTS friends (
    player_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, friend_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id)`,

  `CREATE TABLE IF NOT EXISTS schools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    track_id TEXT,
    from_player_id TEXT,
    created_at INTEGER NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_player ON notifications(player_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    theme TEXT NOT NULL,
    author_id TEXT NOT NULL,
    placements TEXT NOT NULL,
    pieces INTEGER NOT NULL,
    length_m REAL NOT NULL,
    likes INTEGER NOT NULL DEFAULT 0,
    plays INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 0,
    author_time_ms INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_published ON tracks(published, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_author ON tracks(author_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS track_likes (
    track_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (track_id, player_id)
  )`,

  `CREATE TABLE IF NOT EXISTS daily_results (
    day_key TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    winner_id TEXT,
    processed_at INTEGER NOT NULL
  )`,
];

let schemaReady: Promise<void> | null = null;

/** Creates all tables/indexes once per isolate (idempotent, cached promise). */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s))).then(() => undefined).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/* ---------- row types ---------- */

export interface PlayerRow {
  id: string; name: string; name_lower: string; is_guest: number; password_hash: string | null; friend_code: string;
  school_id: string | null; xp: number; coins: number; car: string; stats: string; unlocked: string; achievements: string;
  created_at: number; last_seen: number;
}
export interface SessionRow { token_hash: string; player_id: string; created_at: number; expires_at: number }
export interface RunRow { id: string; track_id: string; player_id: string; time_ms: number; achieved_at: number; day_key: string; week_key: string; mode: string }
export interface RecordRow {
  id: string; track_id: string; player_id: string; time_ms: number; splits: string; car: string; replay: unknown;
  respawns: number; top_speed: number; mode: string; achieved_at: number;
}
export interface SchoolRow { id: string; name: string; name_lower: string; code: string; created_by: string; created_at: number }
export interface NotificationRow {
  id: string; player_id: string; kind: string; text: string; track_id: string | null; from_player_id: string | null; created_at: number; is_read: number;
}
export interface TrackRow {
  id: string; code: string; name: string; description: string; theme: string; author_id: string; placements: string; pieces: number;
  length_m: number; likes: number; plays: number; published: number; author_time_ms: number | null; created_at: number; updated_at: number;
}
export interface DailyResultRow { day_key: string; track_id: string; winner_id: string | null; processed_at: number }

/* ---------- query helpers (always bound params, never interpolated user data) ---------- */

export function one<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export async function count(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Runs several statements in one transaction (chunked to stay under D1 batch limits). */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < statements.length; i += CHUNK) await db.batch(statements.slice(i, i + CHUNK));
}

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** D1 returns BLOBs as ArrayBuffer (older runtimes used number[]); normalize to bytes. */
export function blobToBytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}

export function isUniqueViolation(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

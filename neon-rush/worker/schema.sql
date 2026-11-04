-- NEON RUSH D1 schema (reference copy of worker/db.ts SCHEMA_STATEMENTS).
-- The Worker creates these lazily with CREATE TABLE IF NOT EXISTS; apply manually with
--   wrangler d1 execute neon-rush-db --file worker/schema.sql
-- when you prefer explicit migrations.

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  is_guest INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,                       -- "pbkdf2:<iterations>:<salt hex>:<hash hex>" (accounts only)
  friend_code TEXT NOT NULL UNIQUE,         -- 6 chars, unambiguous alphabet
  school_id TEXT,
  xp INTEGER NOT NULL DEFAULT 0,
  coins INTEGER NOT NULL DEFAULT 0,
  car TEXT NOT NULL,                        -- JSON CarConfig
  stats TEXT NOT NULL,                      -- JSON PlayerStats
  unlocked TEXT NOT NULL DEFAULT '[]',      -- JSON string[] cosmetic ids
  achievements TEXT NOT NULL DEFAULT '[]',  -- JSON AchievementState[]
  created_at INTEGER NOT NULL,              -- epoch ms
  last_seen INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_account_name ON players(name_lower) WHERE is_guest = 0;
CREATE INDEX IF NOT EXISTS idx_players_school ON players(school_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,              -- SHA-256 hex of the bearer token
  player_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL               -- 180 days after creation
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);

-- Every accepted finish.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  achieved_at INTEGER NOT NULL,
  day_key TEXT NOT NULL,                    -- YYYY-MM-DD (UTC)
  week_key TEXT NOT NULL,                   -- YYYY-Www
  mode TEXT NOT NULL                        -- solo | daily | live | ghost
);
CREATE INDEX IF NOT EXISTS idx_runs_track_day ON runs(track_id, day_key, time_ms);
CREATE INDEX IF NOT EXISTS idx_runs_track_week ON runs(track_id, week_key, time_ms);
CREATE INDEX IF NOT EXISTS idx_runs_player_track ON runs(player_id, track_id, achieved_at);
CREATE INDEX IF NOT EXISTS idx_runs_player_day ON runs(player_id, day_key);

-- Best time per player per track (with replay).
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,                      -- id of the run that set this record
  track_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  splits TEXT NOT NULL,                     -- JSON number[]
  car TEXT NOT NULL,                        -- JSON CarConfig used for the run
  replay BLOB,                              -- encoded replay (shared/game/replay.ts), <= 600 KB
  respawns INTEGER NOT NULL DEFAULT 0,
  top_speed REAL NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  achieved_at INTEGER NOT NULL,
  UNIQUE (track_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_records_track_time ON records(track_id, time_ms);
CREATE INDEX IF NOT EXISTS idx_records_player ON records(player_id);

-- One-way follows; friends leaderboards / rivalries use the union of both directions.
CREATE TABLE IF NOT EXISTS friends (
  player_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id);

CREATE TABLE IF NOT EXISTS schools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,                -- 6-char join code
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,                  -- recipient
  kind TEXT NOT NULL,                       -- NotificationKind
  text TEXT NOT NULL,
  track_id TEXT,
  from_player_id TEXT,
  created_at INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_player ON notifications(player_id, created_at DESC);

-- Community tracks (drafts + published).
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                -- 6-char share code
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL,
  author_id TEXT NOT NULL,
  placements TEXT NOT NULL,                 -- JSON Placement[]
  pieces INTEGER NOT NULL,
  length_m REAL NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  author_time_ms INTEGER,                   -- validated author run (required to publish)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_published ON tracks(published, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_author ON tracks(author_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS track_likes (
  track_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, player_id)
);

-- Marks a finished daily challenge as processed (winner achievement + result notifications sent).
CREATE TABLE IF NOT EXISTS daily_results (
  day_key TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  winner_id TEXT,
  processed_at INTEGER NOT NULL
);

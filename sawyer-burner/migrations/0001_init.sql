-- Sawyer Burner — initial schema
-- All timestamps are Unix epoch milliseconds (INTEGER).
-- All primary keys are random, unguessable, URL-safe strings generated in the Worker.

-- ───────────────────────────── users ─────────────────────────────
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- stored lowercase; NOCASE is belt-and-braces
  password_hash     TEXT NOT NULL,                          -- pbkdf2_sha256$<iter>$<salt>$<hash>
  role              TEXT NOT NULL DEFAULT 'user'   CHECK (role   IN ('user', 'admin')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  reports_received  INTEGER NOT NULL DEFAULT 0,             -- lifetime count, survives content expiry
  created_at        INTEGER NOT NULL
);

-- ───────────────────────────── sessions ─────────────────────────────
-- The cookie holds a random 256-bit token; only its SHA-256 hash is stored here.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,                           -- sha256(token), hex
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ───────────────────────────── posts ─────────────────────────────
CREATE TABLE posts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_key     TEXT NOT NULL UNIQUE,                       -- R2 object key, server generated
  mime_type     TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL,
  caption       TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),  -- hidden = pulled pending review
  report_count  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL                            -- always created_at + 24h
);
CREATE INDEX idx_posts_feed    ON posts(status, expires_at);
CREATE INDEX idx_posts_expires ON posts(expires_at);
CREATE INDEX idx_posts_user    ON posts(user_id, created_at);

-- ───────────────────────────── comments ("burns") ─────────────────────────────
CREATE TABLE comments (
  id            TEXT PRIMARY KEY,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  report_count  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_comments_post ON comments(post_id, created_at);
CREATE INDEX idx_comments_user ON comments(user_id, created_at);
CREATE INDEX idx_comments_created ON comments(created_at);

-- ───────────────────────────── 🔥 reactions ─────────────────────────────
CREATE TABLE comment_reactions (
  id            TEXT PRIMARY KEY,
  comment_id    TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  UNIQUE (comment_id, user_id)                              -- one 🔥 per user per burn
);
CREATE INDEX idx_reactions_user ON comment_reactions(user_id);

-- ───────────────────────────── reports ─────────────────────────────
-- target_id is polymorphic (post or comment) so it has no FK; rows are deleted
-- explicitly whenever the target content is deleted or expires.
CREATE TABLE reports (
  id                TEXT PRIMARY KEY,
  reporter_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type       TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id         TEXT NOT NULL,
  target_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason            TEXT NOT NULL CHECK (reason IN (
                      'harassment', 'non_consensual', 'personal_info', 'threats',
                      'sexual_content', 'spam', 'its_me', 'other')),
  details           TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  UNIQUE (reporter_user_id, target_type, target_id)        -- one report per user per item
);
CREATE INDEX idx_reports_target ON reports(target_type, target_id);
CREATE INDEX idx_reports_status ON reports(status, created_at);

-- ───────────────────────────── feed fairness ─────────────────────────────
-- Which active posts a user has already seen, so the shuffled queue can
-- surface unseen photos first. Rows die with the post.
CREATE TABLE post_views (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id   TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  seen_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
) WITHOUT ROWID;
CREATE INDEX idx_post_views_post ON post_views(post_id);

-- ───────────────────────────── rate limiting ─────────────────────────────
-- Fixed-window counters. Keys contain HMAC'd IPs or user ids, never raw IPs.
CREATE TABLE rate_limits (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_rate_limits_reset ON rate_limits(reset_at);

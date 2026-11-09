-- Moderation evidence for REPORTED content + admin password resets.
--
-- Only burns/photos that received at least one report are recorded here when they leave
-- the site (24h expiry, deleted by author, removed by admin, account deleted). Everything
-- that was never reported is deleted completely, as before. Photo IMAGES are always
-- deleted from R2; for reported photos only the record (caption, times, reports) is kept.
-- Usernames are snapshotted so records survive account deletion.

CREATE TABLE burn_archive (
  id                   TEXT PRIMARY KEY,          -- original comment id
  post_id              TEXT NOT NULL,
  author_id            TEXT,                      -- no FK: the record outlives the account
  author_username      TEXT NOT NULL,
  photo_owner_username TEXT,
  body                 TEXT NOT NULL,
  fire_count           INTEGER NOT NULL DEFAULT 0,
  reports_json         TEXT NOT NULL DEFAULT '[]', -- [{reason, details, reporter, at}]
  created_at           INTEGER NOT NULL,
  deleted_at           INTEGER NOT NULL,
  deletion_reason      TEXT NOT NULL CHECK (deletion_reason IN (
                         'expired', 'photo_deleted', 'deleted_by_author',
                         'deleted_by_photo_owner', 'removed_by_admin', 'account_deleted'))
);
CREATE INDEX idx_burn_archive_author  ON burn_archive(author_id, created_at);
CREATE INDEX idx_burn_archive_uname   ON burn_archive(author_username);
CREATE INDEX idx_burn_archive_deleted ON burn_archive(deleted_at);

CREATE TABLE post_archive (
  id               TEXT PRIMARY KEY,              -- original post id
  owner_id         TEXT,
  owner_username   TEXT NOT NULL,
  caption          TEXT,
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  comment_count    INTEGER NOT NULL DEFAULT 0,
  reports_json     TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER NOT NULL,
  deletion_reason  TEXT NOT NULL CHECK (deletion_reason IN (
                     'expired', 'deleted_by_owner', 'removed_by_admin', 'account_deleted'))
);
CREATE INDEX idx_post_archive_owner  ON post_archive(owner_id, created_at);
CREATE INDEX idx_post_archive_uname  ON post_archive(owner_username);

-- Set when an admin issues a temporary password; the user must pick a new one on next login.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

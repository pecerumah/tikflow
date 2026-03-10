-- ============================================================
-- TikFlow — Database Schema (Cloudflare D1 / SQLite)
-- Cara pakai: wrangler d1 execute tikflow-db --file=schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;

-- ── USERS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'user',  -- superadmin | user
  active         INTEGER NOT NULL DEFAULT 1,
  r2_config      TEXT,   -- JSON: {endpoint, accessKey, secretKey, bucket, publicDomain, verified}
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── TIKTOK ACCOUNTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tiktok_accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id          TEXT    NOT NULL UNIQUE,
  display_name     TEXT    NOT NULL,
  handle           TEXT,
  avatar_url       TEXT,
  followers        INTEGER DEFAULT 0,
  likes_count      INTEGER DEFAULT 0,
  video_count      INTEGER DEFAULT 0,
  access_token     TEXT    NOT NULL,
  refresh_token    TEXT    NOT NULL,
  token_expires_at INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'connected', -- connected | expired | disconnected
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Many-to-many: akun TikTok ↔ user
CREATE TABLE IF NOT EXISTS account_users (
  account_id INTEGER NOT NULL REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, user_id)
);

-- ── VIDEO FILES ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key      TEXT    NOT NULL,
  r2_url      TEXT    NOT NULL,
  file_size   INTEGER DEFAULT 0,  -- bytes
  duration    INTEGER DEFAULT 0,  -- detik
  uploaded_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── POSTS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  caption         TEXT    NOT NULL,
  video_file_id   INTEGER REFERENCES video_files(id) ON DELETE SET NULL,
  r2_key          TEXT,
  r2_url          TEXT,
  music_title     TEXT,
  music_id        TEXT,   -- TikTok music ID
  hashtags        TEXT    NOT NULL DEFAULT '[]',   -- JSON array ["fyp","viral"]
  affiliates      TEXT    NOT NULL DEFAULT '[]',   -- JSON array [{id,name,commission,emoji}]
  scheduled_at    TEXT,   -- "YYYY-MM-DD HH:MM" WIB
  published_at    TEXT,
  status          TEXT    NOT NULL DEFAULT 'draft', -- draft|scheduled|processing|posted|partial|failed
  error_message   TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Post → TikTok Accounts (many-to-many)
CREATE TABLE IF NOT EXISTS post_accounts (
  post_id           INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  account_id        INTEGER NOT NULL REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
  tiktok_publish_id TEXT,
  tiktok_video_id   TEXT,
  posted_at         TEXT,
  PRIMARY KEY (post_id, account_id)
);

-- ── ANALYTICS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_analytics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  account_id      INTEGER NOT NULL REFERENCES tiktok_accounts(id) ON DELETE CASCADE,
  tiktok_video_id TEXT,
  views           INTEGER DEFAULT 0,
  likes           INTEGER DEFAULT 0,
  comments        INTEGER DEFAULT 0,
  shares          INTEGER DEFAULT 0,
  product_clicks  INTEGER DEFAULT 0,  -- klik keranjang VT
  fetched_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── AUDIT LOG ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  detail      TEXT,  -- JSON
  ip_address  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_posts_status       ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled    ON posts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_created_by   ON posts(created_by);
CREATE INDEX IF NOT EXISTS idx_pa_post_id         ON post_accounts(post_id);
CREATE INDEX IF NOT EXISTS idx_pa_account_id      ON post_accounts(account_id);
CREATE INDEX IF NOT EXISTS idx_tt_status          ON tiktok_accounts(status);
CREATE INDEX IF NOT EXISTS idx_tt_expires         ON tiktok_accounts(token_expires_at);
CREATE INDEX IF NOT EXISTS idx_video_user         ON video_files(user_id);

-- ── SEED: Super Admin Default ─────────────────────────────────
-- password: admin123  →  SHA256 base64
INSERT OR IGNORE INTO users (name, email, password_hash, role, active)
VALUES (
  'Super Admin',
  'admin@tikflow.app',
  'jZae727K08KaOmKSgOaGzww/XVqGr/PKEgIMkjrcbJI=',
  'superadmin',
  1
);

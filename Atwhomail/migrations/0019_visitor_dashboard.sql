-- 0019_visitor_dashboard.sql — 訪客 Dashboard：地區／語系、最近活動、AllChat 等級投影
--
-- 只新增欄位／表／索引；不刪除、不改既有資料。
-- 既有訪客的 country_code／language／last_seen_at 會是 NULL，UI 顯示「未知」；
-- 下一次登入／註冊後逐步補齊。

ALTER TABLE users ADD COLUMN country_code TEXT;
ALTER TABLE users ADD COLUMN language TEXT;
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE users ADD COLUMN last_country_code TEXT;

CREATE INDEX IF NOT EXISTS idx_users_role_status_created
  ON users(role, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_role_created
  ON users(role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_country
  ON users(country_code);
CREATE INDEX IF NOT EXISTS idx_users_language
  ON users(language);
CREATE INDEX IF NOT EXISTS idx_users_last_seen
  ON users(last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_reg_audit_user_time
  ON registration_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reg_audit_event_time
  ON registration_audit(event, created_at DESC);

-- AllChat 是等級的 source of truth；這張表只是 Mail 的唯讀投影。
CREATE TABLE IF NOT EXISTS allchat_level_projection (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level             TEXT NOT NULL,
  scope             TEXT,
  status            TEXT NOT NULL DEFAULT 'normal',
  source_version    INTEGER NOT NULL DEFAULT 0,
  source_updated_at INTEGER,
  synced_at         INTEGER NOT NULL,
  sync_state        TEXT NOT NULL DEFAULT 'synced'
);

CREATE INDEX IF NOT EXISTS idx_level_projection_level
  ON allchat_level_projection(level, status);

CREATE TABLE IF NOT EXISTS integration_sync_state (
  integration    TEXT PRIMARY KEY,
  cursor         TEXT,
  last_synced_at INTEGER,
  last_error     TEXT
);

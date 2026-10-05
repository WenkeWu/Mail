-- AtWhoMail Backup Agent 0001_local — 本機 PostgreSQL 鏡像 schema（09 文件 §4）
--
-- 原則：
--  - 與 D1 同構（id 相同），只多兩個備份用欄位：
--      backup_synced_at（本機寫入時間）
--      is_deleted（D1 soft delete 的鏡像）
--  - 時間欄位一律 BIGINT（epoch ms；PG INTEGER 為 32-bit 會溢位）
--  - 不設 FK：鏡像資料可能分批到達（先 attachments 後 messages），本地不強制順序

CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY,
  username            TEXT NOT NULL,
  display_name        TEXT,
  password_hash       TEXT NOT NULL,
  status              TEXT NOT NULL,
  password_changed_at BIGINT NOT NULL DEFAULT 0,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  backup_synced_at    BIGINT NOT NULL,
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS email_addresses (
  id                  INTEGER PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  local_part          TEXT NOT NULL,
  domain              TEXT NOT NULL,
  email               TEXT NOT NULL,
  password_hash       TEXT,
  status              TEXT NOT NULL,
  password_changed_at BIGINT NOT NULL DEFAULT 0,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  deleted_at          BIGINT,
  backup_synced_at    BIGINT NOT NULL,
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_addr_user ON email_addresses(user_id);

CREATE TABLE IF NOT EXISTS email_aliases (
  id                      INTEGER PRIMARY KEY,
  alias_address           TEXT NOT NULL,
  target_email_address_id INTEGER NOT NULL,
  status                  TEXT NOT NULL,
  created_at              BIGINT NOT NULL,
  updated_at              BIGINT NOT NULL,
  backup_synced_at        BIGINT NOT NULL,
  is_deleted              BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_alias_target ON email_aliases(target_email_address_id);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  address_id    INTEGER NOT NULL,
  folder        TEXT NOT NULL,
  message_id    TEXT,
  from_address  TEXT NOT NULL,
  to_address    TEXT NOT NULL DEFAULT '[]',
  cc            TEXT NOT NULL DEFAULT '[]',
  subject       TEXT,
  text_preview  TEXT,
  received_at   BIGINT NOT NULL,
  read_at       BIGINT,
  send_status   TEXT,
  raw_r2_key    TEXT NOT NULL,
  html_r2_key   TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  deleted_at    BIGINT,
  backup_synced_at BIGINT NOT NULL,
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_msg_updated ON messages(updated_at);
CREATE INDEX IF NOT EXISTS idx_msg_owner_folder_time ON messages(owner_user_id, folder, received_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  filename        TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  content_type    TEXT,
  size_bytes      BIGINT NOT NULL,
  r2_key          TEXT NOT NULL,
  sha256          TEXT,
  disposition     TEXT NOT NULL DEFAULT 'attachment',
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  backup_synced_at BIGINT NOT NULL,
  is_deleted      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_att_msg ON attachments(message_id);

-- 增量游標：每張表各自的水位（09 文件 §2.1 / §4）
CREATE TABLE IF NOT EXISTS backup_watermark (
  table_name TEXT PRIMARY KEY,
  cursor     BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT
);

-- R2 物件清單（09 文件 §3 / §4）：key → sha256 + size + 本地路徑 + 備份時間
CREATE TABLE IF NOT EXISTS r2_manifest (
  r2_key      TEXT PRIMARY KEY,
  sha256      TEXT,
  size        BIGINT,
  local_path  TEXT,
  backup_time BIGINT
);

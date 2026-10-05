-- AtWhoMail 0001_init — 初始 schema（對應 docs/03-database-schema.md，含 Model C）
-- 時間欄位：INTEGER epoch ms（UTC）

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE email_addresses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  local_part    TEXT NOT NULL,
  domain        TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,          -- NULL = 不能直接登入；有值 = 信箱帳號（Model C）
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled','deleted')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  UNIQUE (local_part, domain)
);
CREATE INDEX idx_addr_user ON email_addresses(user_id) WHERE deleted_at IS NULL;

CREATE TABLE email_aliases (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_address            TEXT NOT NULL UNIQUE,
  target_email_address_id  INTEGER NOT NULL REFERENCES email_addresses(id),
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','disabled')),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX idx_alias_target ON email_aliases(target_email_address_id);

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  address_id    INTEGER NOT NULL REFERENCES email_addresses(id),  -- 收信=收件地址；寄信=From 地址
  folder        TEXT NOT NULL DEFAULT 'inbox'
                CHECK (folder IN ('inbox','sent','archive','trash','spam')),
  message_id    TEXT,
  from_address  TEXT NOT NULL,
  to_address    TEXT NOT NULL DEFAULT '[]',   -- JSON 陣列
  cc            TEXT NOT NULL DEFAULT '[]',   -- JSON 陣列
  subject       TEXT,
  text_preview  TEXT,
  received_at   INTEGER NOT NULL,
  read_at       INTEGER,
  send_status   TEXT CHECK (send_status IN ('sent','bounced','failed')),
  raw_r2_key    TEXT NOT NULL,
  html_r2_key   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX idx_msg_owner_folder_time
  ON messages(owner_user_id, folder, received_at DESC);
CREATE INDEX idx_msg_address_folder_time
  ON messages(address_id, folder, received_at DESC);
CREATE INDEX idx_msg_updated ON messages(updated_at) WHERE deleted_at IS NULL;

CREATE TABLE attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES messages(id),
  filename        TEXT NOT NULL,          -- 原始（供顯示）
  stored_filename TEXT NOT NULL,          -- sanitized（供 R2 key）
  content_type    TEXT,
  size_bytes      INTEGER NOT NULL,
  r2_key          TEXT NOT NULL UNIQUE,
  sha256          TEXT,
  disposition     TEXT NOT NULL DEFAULT 'attachment'
                  CHECK (disposition IN ('attachment','inline')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_att_msg ON attachments(message_id);

-- 0020_service_mail_send.sql — Trace-Flow 等外部系統的「只寄信」service token
--
-- 目的：
--   - 不建立／不共用人類信箱，也不把 owner rescue token 交給外部系統
--   - service token 只綁定一個寄件地址，只能呼叫 POST /api/service/mail/send
--   - 每個 token 可有自己的每小時／每日上限
--   - Idempotency-Key 去重（避免逾時重試重複寄信）
--
-- 只新增表與索引；不改既有資料。

CREATE TABLE IF NOT EXISTS service_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,          -- SHA-256(token)，不存明碼
  address_id    INTEGER NOT NULL REFERENCES email_addresses(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  hourly_limit  INTEGER NOT NULL DEFAULT 60,
  daily_limit   INTEGER NOT NULL DEFAULT 500,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_service_tokens_address
  ON service_tokens(address_id, status);

CREATE TABLE IF NOT EXISTS send_idempotency (
  scope_key       TEXT NOT NULL,               -- addr:<email_addresses.id> 或 svc:<service_tokens.id>
  idem_key        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,               -- SHA-256(正規化請求)，不存內文
  status          TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'done')),
  response_status INTEGER,
  response_json   TEXT,                        -- 只存 messageId/from/to 等回應，不含信件內容
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (scope_key, idem_key)
);

CREATE INDEX IF NOT EXISTS idx_send_idempotency_expires
  ON send_idempotency(expires_at);

-- 0013_oauth_identity.sql — D27：Google OAuth 身分 ＋ 忘記／重設密碼（docs/28 §1）
--
-- 用途：
--   1) `users` 增加 OAuth 身分欄位（provider／provider_sub／contact_email／email_verified）
--   2) `password_resets`：忘記密碼的一次性 token（DB 只存 SHA-256(token + JWT_SECRET)）
--
-- 原則（與 0001–0012 一致）：
--  - 只新增（ALTER TABLE ADD COLUMN／CREATE TABLE／CREATE INDEX），無 DROP／DELETE
--  - 時間欄位一律 INTEGER epoch ms（UTC）
--  - **不得**存放明碼 token；token_hash = SHA-256(token + JWT_SECRET)
--  - `provider` 預設 'local' → 既有資料列行為完全不變（零回歸）
--
-- ⚠️ 0001 的 `users.password_hash` 是 `TEXT NOT NULL`（SQLite 無法以 ALTER 放寬）。
--    純 OAuth 帳號因此以**空字串**代表「未設定密碼」；程式一律以
--    `hasPassword()`（auth.ts）判定 NULL／空字串為未設定，登入時回 400 `NO_PASSWORD_SET`。
--    本次刻意不在 migration 內重建 users 表（DROP／RENAME 屬破壞性操作，且會影響
--    既有外鍵與稽核資料；docs/16 N10 只允許新增）。

ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'local';   -- local | google
ALTER TABLE users ADD COLUMN provider_sub TEXT;                        -- Google `sub`（唯一識別）
ALTER TABLE users ADD COLUMN contact_email TEXT;                       -- Google 驗證過的 Email（小寫）
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- 同一 provider 的 sub 唯一（local 的 provider_sub 為 NULL；SQLite 唯一索引視 NULL 為互異）
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_sub);
CREATE INDEX IF NOT EXISTS idx_users_contact_email ON users(contact_email);

CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,          -- SHA-256(token + JWT_SECRET)
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,              -- 30 分鐘
  consumed_at INTEGER,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

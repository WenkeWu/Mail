-- 0009_email_verifications.sql — D21：Email 驗證碼註冊（docs/21 §3）
--
-- 用途：
--   POST /api/auth/register-request 寄出 6 位數驗證碼
--   POST /api/auth/register-verify  驗碼通過後才建立 users ＋ email_addresses
--
-- 原則（與 0001–0008 一致）：
--  - 只新增（CREATE TABLE / CREATE INDEX），無 ALTER／DROP／DELETE
--  - 時間欄位一律 INTEGER epoch ms（UTC）
--  - code_hash = SHA-256(code + JWT_SECRET)；**不儲存明碼**
--  - 未驗證的 Email 不會建立帳號（users／email_addresses 不存在）
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

CREATE TABLE IF NOT EXISTS email_verifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,              -- 正規化（小寫）
  code_hash     TEXT NOT NULL,              -- SHA-256(code + JWT_SECRET)
  purpose       TEXT NOT NULL DEFAULT 'register',
  attempts      INTEGER NOT NULL DEFAULT 0, -- 上限 5
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,           -- 15 分鐘
  consumed_at   INTEGER,
  ip            TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email, created_at);

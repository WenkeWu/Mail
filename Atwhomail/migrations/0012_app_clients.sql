-- 0012_app_clients.sql — D26：App Clients ＋ 一次性授權碼（docs/27 §3）
--
-- 用途：
--   1) `app_clients`：其他 App（例如 mycrm）的客戶端註冊資料；`secret_hash` 只存雜湊
--   2) `auth_codes`：app-login 產生的 60 秒一次性 code（DB 只存雜湊）
--
-- 原則（與 0001–0011 一致）：
--  - 只新增（CREATE TABLE／CREATE INDEX），無 DROP／DELETE／ALTER
--  - 時間欄位一律 INTEGER epoch ms（UTC）
--  - **不得**存放明碼 secret／code；secret_hash = SHA-256(secret + JWT_SECRET)
--  - `redirect_uris` 為 JSON 陣列，授權時「完全相符」比對（防開放轉址）
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

CREATE TABLE IF NOT EXISTS app_clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL UNIQUE,        -- 例如 'mycrm'（^[a-z][a-z0-9-]{1,31}$）
  name          TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,               -- SHA-256(secret + JWT_SECRET)
  redirect_uris TEXT NOT NULL,               -- JSON array（完全相符比對）
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash    TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  app_id       TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,             -- 60 秒
  consumed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_exp ON auth_codes(expires_at);

-- 0011_domain_check.sql — D20：註冊 ID 與二級網域同名偵測（docs/20）
--
-- 用途：
--   1) `domain_checks`：DoH 查詢結果快取（hit=1 → 90 天；hit=0 → 7 天）
--   2) `id_blocklist`：owner 可維護的人工封鎖 ID（商標但無網域等）
--
-- 原則（與 0001–0010 一致）：
--  - 只新增（CREATE TABLE），無 ALTER／DROP／DELETE
--  - 時間欄位一律 INTEGER epoch ms（UTC）
--  - 不回溯檢查既有地址；只套用新的註冊／配發（owner 2026-11-04 決策）
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

CREATE TABLE IF NOT EXISTS domain_checks (
  label      TEXT PRIMARY KEY,   -- 正規化後的 ID（小寫）
  hit        INTEGER NOT NULL,   -- 1 = 有同名二級網域；0 = 無
  tld_hit    TEXT,               -- 命中的 TLD（例如 'com'）
  checked_at INTEGER NOT NULL    -- 查詢時間（epoch ms；TTL 由程式判定）
);

CREATE TABLE IF NOT EXISTS id_blocklist (
  label      TEXT PRIMARY KEY,   -- 正規化後的 ID（小寫）
  reason     TEXT,               -- 人工註記（例：商標）
  created_at INTEGER NOT NULL
);

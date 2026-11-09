-- 0018_warmup_quota_default_20.sql — 系統暖機上限預設改為 20（owner 2026-11-09 定案）
--
-- 背景：D35（migration 0017）新增 `email_addresses.warmup_quota`，預設 5。
-- owner 決定把**系統預設**改為 20 封；每位訪客仍可在訪客管理調整（1–50）。
--
-- 本 migration 只把「仍使用舊預設 5」的地址改為 20：
--   - 已被管理者調整過的值（例如 6、10）**保留不動**
--   - 新地址由程式在 INSERT 時明確寫入 `QUOTA.WARMUP_QUOTA`（20）
--   - SQLite 不支援 ALTER COLUMN DEFAULT，DB 欄位預設仍為 5；
--     應用程式所有建立地址的路徑都已明確帶入 20，不依賴 DB 預設
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

UPDATE email_addresses
SET warmup_quota = 20,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE warmup_quota = 5;

-- 0017_warmup_quota.sql — 訪客暖機期上限可調（D35，owner 2026-11-09 定案）
--
-- 規則：
--   1) `email_addresses.warmup_quota`：每個地址的暖機期上限，預設 **5**
--   2) 暖機期（建立後 24 小時）內的有效上限 = min(daily_send_quota, warmup_quota)
--   3) 管理者可在 mail.atwho.org 的「訪客管理」調整每個訪客的暖機上限（1–50）
--   4) `warmup_exempt=1` 時忽略暖機上限，直接使用每日配額
--   5) 既有地址由 ALTER TABLE 的 DEFAULT 自動回填 5
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

ALTER TABLE email_addresses ADD COLUMN warmup_quota INTEGER NOT NULL DEFAULT 5;

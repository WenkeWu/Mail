-- 0016_visitor_quota_50.sql — 所有訪客每日寄信配額統一為 50（owner 2026-11-07 定案）
--
-- 規則：
--   1) 所有 role='visitor' 的地址（含既有與已停用，不限 deleted_at）一律改為 50
--   2) owner 自己的地址不動
--   3) 新訪客由程式 QUOTA.DEFAULT_VISITOR_DAILY_QUOTA＝50 建立
--   4) 管理頁可調範圍改為 1–50（QUOTA_MAX）
--   5) 訪客嘗試超過每日配額被擋時，寄提醒信到其「備用電子郵件」
--      （users.contact_email；每訪客每日最多一封）
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

UPDATE email_addresses
SET daily_send_quota = 50,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE user_id IN (SELECT id FROM users WHERE role = 'visitor');

-- 0007_warmup_exempt.sql — docs/16 D5：暖機豁免（owner 對個別地址關閉「註冊後 24 小時 5 封」上限）
--
-- 語意（配額判定見 packages/api/src/index.ts 的 POST /api/mail/send）：
--   warmup_exempt = 0（預設）→ 註冊後 WARMUP_HOURS（24）小時內，有效上限 = min(daily_send_quota, WARMUP_QUOTA=5)
--   warmup_exempt = 1        → 不受暖機上限限制，但**仍受 daily_send_quota**（每日上限）與每小時限流約束
--
-- 原則（與 0001–0006 一致）：
--  - 只新增（ALTER TABLE ADD COLUMN），無 DROP／DELETE 等破壞性語句
--  - 既有資料列自動取得 DEFAULT 0 → 行為與本次變更前完全相同（零退化）
--  - 僅由 owner 端點 PATCH /api/users/:id/warmup 修改；稽核寫入 registration_audit
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

ALTER TABLE email_addresses ADD COLUMN warmup_exempt INTEGER NOT NULL DEFAULT 0;

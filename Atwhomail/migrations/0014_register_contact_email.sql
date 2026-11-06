-- 0014_register_contact_email.sql — 修正：Email 驗證碼註冊成功時寫入備用電子郵件（D29）
--
-- 背景：
--   D21 的 register-verify 只把註冊 Email 用於寄驗證碼，**未寫入 `users.contact_email`**
--   → 個人設置頁的「備用電子郵件」對本機註冊帳號顯示「（未提供）」，
--     且「忘記密碼」也無法寄出重設信。
--   程式已修正（register-verify 建立 users 時一併寫入 contact_email／email_verified）；
--   本 migration 只回填**既有**帳號，不改 schema。
--
-- 回填依據：
--   register-verify 以同一個 `ts` 寫入 `email_verifications.consumed_at` 與
--   `users.created_at` → 可用「成功消費的 register 驗證碼時間 == 帳號建立時間」對回註冊 Email。
--   只在**唯一匹配**時回填（避免同毫秒多筆註冊造成誤配）。
--
-- 安全：
--   - 只更新 `contact_email IS NULL` 的帳號（OAuth 帳號已有值，不覆寫）
--   - 不刪除任何資料；冪等（重跑結果相同）
--   - `contact_email` 為 Email 驗證碼註冊時**已驗證過**的信箱
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

UPDATE users
SET contact_email = (
      SELECT lower(v.email)
      FROM email_verifications v
      WHERE v.purpose = 'register'
        AND v.consumed_at = users.created_at
      LIMIT 1
    ),
    email_verified = 1
WHERE contact_email IS NULL
  AND (
    SELECT COUNT(*)
    FROM email_verifications v
    WHERE v.purpose = 'register'
      AND v.consumed_at = users.created_at
  ) = 1;

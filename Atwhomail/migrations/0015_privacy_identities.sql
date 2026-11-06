-- 0015_privacy_identities.sql — D31：三種寄信身分（真實 ID／暱稱別名／Token）
--
-- 定案（owner 2026-11-06）：
--   每個帳號：1 個真實地址（固定）＋ 1 個啟用中的暱稱別名（可變更，舊的立即停用）
--             ＋ 1 個 Token 別名（建立帳號時自動產生，不隨暱稱變更）
--   Token 由隨機字串組成，對方只會看到 Token，仍可直接回信。
--
-- 本 migration 只新增欄位／索引與資料回填，不刪除任何資料：
--   1) `email_aliases.kind`：named（既有可讀別名）／token（系統自動產生）
--   2) 為既有 active 地址回填一個 Token 別名（16 hex，64 bits）
--   3) 每個地址最多一個 token 別名（partial unique index）
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

ALTER TABLE email_aliases ADD COLUMN kind TEXT NOT NULL DEFAULT 'named';

-- 既有 active 地址：若尚無 token 別名，回填一個隨機 token
WITH candidates AS (
  SELECT e.id AS address_id,
         e.created_at AS created_at,
         lower(hex(randomblob(8))) AS local_part
  FROM email_addresses e
  WHERE e.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM email_aliases a
      WHERE a.target_email_address_id = e.id AND a.kind = 'token'
    )
)
INSERT INTO email_aliases (alias_address, target_email_address_id, status, kind, created_at, updated_at)
SELECT c.local_part || '@atwho.org', c.address_id, 'active', 'token', c.created_at, c.created_at
FROM candidates c
WHERE NOT EXISTS (SELECT 1 FROM email_addresses x WHERE x.email = c.local_part || '@atwho.org')
  AND NOT EXISTS (SELECT 1 FROM email_aliases x WHERE x.alias_address = c.local_part || '@atwho.org');

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_aliases_one_token_per_address
  ON email_aliases(target_email_address_id)
  WHERE kind = 'token';

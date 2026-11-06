-- AtWhoMail Backup Agent 0005_local_alias_kind
-- D31（2026-11-06）：email_aliases.kind（named / token）
--
-- 鏡像表必須與 D1 逐欄一致，否則還原時會把 Token 別名誤還原成 named（語意錯誤）。
-- 既有資料列預設 'named'，與 migration 0015 的行為一致。

ALTER TABLE email_aliases ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'named';

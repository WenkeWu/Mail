-- AtWhoMail Backup Agent 0003_local_invites
-- Phase 1（docs/14 §4.6 D10）：鏡像納入 invites；並補上 0006 對 users / email_addresses 的新欄位
--
-- 為什麼要補欄位：鏡像表必須與 D1 逐欄一致，否則還原時會靜默遺失
--   users.role / access_email（訪客身分與稽核）
--   email_addresses.can_send / daily_send_quota / sent_today / quota_reset_at / first_send_at（寄信管制狀態）
--
-- 刻意不建 registration_audit：稽核量大且非信件／身分資料，只存在 D1（docs/13 §7.2）
-- 全部語句皆為 additive（IF NOT EXISTS），不影響既有資料

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_email TEXT;

ALTER TABLE email_addresses ADD COLUMN IF NOT EXISTS can_send INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_addresses ADD COLUMN IF NOT EXISTS daily_send_quota INTEGER NOT NULL DEFAULT 20;
ALTER TABLE email_addresses ADD COLUMN IF NOT EXISTS sent_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_addresses ADD COLUMN IF NOT EXISTS quota_reset_at BIGINT;
ALTER TABLE email_addresses ADD COLUMN IF NOT EXISTS first_send_at BIGINT;

CREATE TABLE IF NOT EXISTS invites (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL,
  created_by   INTEGER NOT NULL,
  max_uses     INTEGER NOT NULL DEFAULT 1,
  used_count   INTEGER NOT NULL DEFAULT 0,
  expires_at   BIGINT,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  backup_synced_at BIGINT NOT NULL,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status, expires_at);

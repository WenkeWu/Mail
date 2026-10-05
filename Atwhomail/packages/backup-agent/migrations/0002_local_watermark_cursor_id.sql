-- AtWhoMail Backup Agent 0002_local_watermark_cursor_id
-- 游標改為 keyset（updated_at + id）：原 cursor BIGINT 只存時間戳，同毫秒多列會漏
ALTER TABLE backup_watermark ADD COLUMN IF NOT EXISTS cursor_id BIGINT NOT NULL DEFAULT 0;

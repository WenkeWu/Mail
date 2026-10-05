-- AtWhoMail 0003_password_changed — 密碼變更時間（08 文件 #44：重設後舊 token 失效）
-- JWT 的 iat 若早於 password_changed_at → 視為失效。

ALTER TABLE users ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_addresses ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0;

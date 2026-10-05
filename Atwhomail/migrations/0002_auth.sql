-- AtWhoMail 0002_auth — 登入嘗試與鎖定（08 文件 §8：密碼錯 5 次 → 鎖定）
-- key = 登入識別（owner: username；mailbox: email）

CREATE TABLE auth_attempts (
  key          TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

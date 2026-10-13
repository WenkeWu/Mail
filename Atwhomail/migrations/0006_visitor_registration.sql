-- 0006_visitor_registration.sql — Phase 1：訪客邀請制註冊（docs/13 v0.2、docs/14 §4.1）
--
-- 設計：訪客憑邀請碼註冊 → 建立 users(role='visitor') ＋ 1 個 email_addresses（可寄信，受配額約束）
-- 原則：
--  - 只新增（ALTER TABLE ADD COLUMN / CREATE TABLE），不得有 DROP / DELETE 等破壞性語句
--  - 時間欄位一律 INTEGER epoch ms（UTC），與 0001–0005 一致
--  - users.status 的既有 CHECK 是 ('active','disabled')：API 的「停權 suspended」對應 DB 的 'disabled'
--    （本檔不改既有 CHECK —— SQLite 改 CHECK 需重建表，屬破壞性操作）
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行）

-- ── 1) 使用者角色與邊緣身分 ─────────────────────────────────────────────
-- role：owner = 你；visitor = 憑邀請碼註冊的訪客（僅能使用自己的地址）
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'
  CHECK (role IN ('owner','visitor'));

-- access_email：Cloudflare Access 帶來的邊緣身分（稽核與比對用，R5）
-- ⚠️ 僅供稽核，**不是**授權依據；授權一律由 D1 的 users/email_addresses 決定
ALTER TABLE users ADD COLUMN access_email TEXT;

-- ── 2) 寄信權限與配額（Phase 1 必要 —— D1 決策「訪客可寄信」的前提條件）────────
ALTER TABLE email_addresses ADD COLUMN can_send INTEGER NOT NULL DEFAULT 1;         -- 0 = 完全不可寄（安全閥 C8）
ALTER TABLE email_addresses ADD COLUMN daily_send_quota INTEGER NOT NULL DEFAULT 20; -- C1 每日上限（預設見程式 QUOTA 常數）
ALTER TABLE email_addresses ADD COLUMN sent_today INTEGER NOT NULL DEFAULT 0;        -- 當日已寄（每日 00:00 UTC 重置）
ALTER TABLE email_addresses ADD COLUMN quota_reset_at INTEGER;                       -- 下次重置時間；NULL = 尚未初始化
ALTER TABLE email_addresses ADD COLUMN first_send_at INTEGER;                        -- 首次寄信時間（暖機期紀錄）

-- ── 3) 邀請碼 ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,             -- 隨機 ≥24 字元（crypto.getRandomValues；不得可預測）
  created_by  INTEGER NOT NULL REFERENCES users(id),
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,                          -- epoch ms；NULL = 不過期
  note        TEXT,                             -- 例：「給小明 2026-10」
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status, expires_at);

-- ── 4) 稽核（註冊／登入失敗／寄信被拒／自動停權）────────────────────────
-- 僅存在 D1，**不納入** 備份鏡像（量大且非信件資料，docs/13 §7.2）
CREATE TABLE IF NOT EXISTS registration_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event        TEXT NOT NULL,   -- register_ok / register_rejected / login_failed /
                                -- send_rejected_quota / send_rejected_rate / send_rejected_notallowed / auto_suspended
  user_id      INTEGER,
  address_id   INTEGER,
  access_email TEXT,
  ip           TEXT,
  user_agent   TEXT,
  detail       TEXT,            -- JSON 字串（不得含邀請碼全碼／密碼／token）
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_audit_time  ON registration_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reg_audit_event ON registration_audit(event, created_at DESC);

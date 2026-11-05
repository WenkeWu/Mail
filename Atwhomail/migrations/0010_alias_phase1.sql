-- 0010_alias_phase1.sql — 別名 Phase 1（D25，docs/25）
--
-- 原則（與 0001–0009 一致）：
--  - 只新增（CREATE TABLE／CREATE INDEX／ALTER TABLE ADD COLUMN），無 DROP／DELETE
--  - 時間欄位一律 INTEGER epoch ms（UTC）
--  - 既有資料列取得安全預設：envelope_to／reply_to 皆為 NULL → 舊信件不受影響
--
-- 別名命名（owner 2026-11-04 定案）：
--   使用者輸入 3–12 個英文字母（儲存小寫），系統附加 3 位流水號（001–999）
--   例：luke → luke001；同名的第二人 → luke002
--   `alias_names` 為每個名字一個原子計數器，避免併發時拿到重複流水號。
--
-- `messages.reply_to` 僅為 Phase 2（反向別名）預留；Phase 1 **不寫入、不啟用**。
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

-- ── 1) 別名名稱計數器（原子遞增）────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alias_names (
  name        TEXT PRIMARY KEY,          -- 小寫 a-z，3–12
  next_serial INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- ── 2) messages：這封信原本寄給哪個別名（UI 顯示「寄給 <別名>」徽章）────────
ALTER TABLE messages ADD COLUMN envelope_to TEXT;

-- ── 3) 預留 Phase 2（反向別名）；Phase 1 不使用 ──────────────────────────────
ALTER TABLE messages ADD COLUMN reply_to TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_envelope_to ON messages(envelope_to);

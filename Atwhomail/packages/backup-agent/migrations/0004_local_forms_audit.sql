-- AtWhoMail Backup Agent 0004_local_forms_audit — D17-1（docs/17 §7.1）
--
-- 補齊備份涵蓋：
--   1) messages 的 8 個新欄位（D1 migration 0008）
--   2) form_templates / form_instances / form_responses（D1 migration 0008）
--   3) registration_audit（0006；D17 起納入，只增不改）
--
-- 原則與 0001–0003 一致：
--  - 全部 additive（IF NOT EXISTS），可重跑
--  - 時間欄位一律 BIGINT（epoch ms）
--  - 不建 FK：鏡像資料可能分批／亂序到達，順序由 restore 腳本控制
--  - 新欄位給「安全預設值」，讓既有備份列在回填前也維持正確語意：
--      origin='external'、kind='normal'、delivery_scope='external'、suspicious_form_claim=0
--    （與 D1 0008 的既有資料預設值一致）

-- ── 0) 一次性回填：messages 新增欄位前，把游標歸零 ────────────────────────────
-- 為什麼需要：增量端點只回傳 updated_at > 游標的列；既有信件不會再被拉一次，
-- 新欄位就會永遠停在 DEFAULT（例如 kind 永遠是 normal，看不到 interactive_form）。
-- 只在「欄位尚未存在」時歸零 → migration 可重跑，且不會每次重跑都全量重拉。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'kind'
  ) THEN
    UPDATE backup_watermark SET cursor = 0, cursor_id = 0 WHERE table_name = 'messages';
  END IF;
END $$;

-- ── 1) messages：分類欄位（0008）──────────────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'external';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_scope TEXT NOT NULL DEFAULT 'external';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS form_instance_id INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS suspicious_form_claim INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_spf TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_dkim TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_dmarc TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_form_instance ON messages(form_instance_id);

-- ── 2) 表單範本（0008）────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_templates (
  id               INTEGER PRIMARY KEY,
  key              TEXT NOT NULL,
  version          INTEGER NOT NULL,
  schema_json      TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  backup_synced_at BIGINT NOT NULL,
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_templates_key_version ON form_templates(key, version);

-- ── 3) 表單實例（0008）────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_instances (
  id                   INTEGER PRIMARY KEY,
  template_id          INTEGER NOT NULL,
  message_id           INTEGER NOT NULL,
  sender_address_id    INTEGER NOT NULL,
  recipient_address_id INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  due_at               BIGINT,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  backup_synced_at     BIGINT NOT NULL,
  is_deleted           BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_form_instances_recipient ON form_instances(recipient_address_id, status);
CREATE INDEX IF NOT EXISTS idx_form_instances_message ON form_instances(message_id);
CREATE INDEX IF NOT EXISTS idx_form_instances_sender ON form_instances(sender_address_id, status);
CREATE INDEX IF NOT EXISTS idx_form_instances_template ON form_instances(template_id);

-- ── 4) 表單回覆（0008）────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_responses (
  id                INTEGER PRIMARY KEY,
  instance_id       INTEGER NOT NULL,
  responder_user_id INTEGER NOT NULL,
  payload_json      TEXT NOT NULL,
  submitted_at      BIGINT NOT NULL,
  backup_synced_at  BIGINT NOT NULL,
  is_deleted        BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_responses_instance ON form_responses(instance_id);

-- ── 5) 註冊／登入稽核（0006；D17 納入）────────────────────────────────────────
CREATE TABLE IF NOT EXISTS registration_audit (
  id               INTEGER PRIMARY KEY,
  event            TEXT NOT NULL,
  user_id          INTEGER,
  address_id       INTEGER,
  access_email     TEXT,
  ip               TEXT,
  user_agent       TEXT,
  detail           TEXT,
  created_at       BIGINT NOT NULL,
  backup_synced_at BIGINT NOT NULL,
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_reg_audit_time ON registration_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reg_audit_event ON registration_audit(event, created_at DESC);

-- 0008_form_mail.sql — 郵件種類與互動式表單（docs/18 P1／P2）
--
-- 原則（與 0001–0007 一致）：
--  - 只新增（ALTER TABLE ADD COLUMN／CREATE TABLE／CREATE INDEX），無 DROP／DELETE
--  - 時間欄位一律 INTEGER epoch ms（UTC）
--  - **既有資料列**一律取得安全預設值：origin='external'、kind='normal'、delivery_scope='external'
--    → 舊信件不會被誤判成內部信或互動式表單
--  - sender_spf／sender_dkim／sender_dmarc **僅供顯示**，永不作為授權依據（docs/18 §5.3、§9）
--
-- 本地套用：pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local
-- 遠端套用：由 owner 執行（實作 agent 不得執行；docs/16 N10）

-- ── 1) messages：分類欄位（由「進入路徑」決定，絕不由郵件內容決定）──────────────
ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'external'
  CHECK (origin IN ('external','internal'));

ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'
  CHECK (kind IN ('normal','interactive_form'));

ALTER TABLE messages ADD COLUMN delivery_scope TEXT NOT NULL DEFAULT 'external'
  CHECK (delivery_scope IN ('internal','external'));

-- 僅 kind='interactive_form' 時有意義；送件備份會指向該次寄送的代表實例（供寄件人管理 UI）
ALTER TABLE messages ADD COLUMN form_instance_id INTEGER;

-- 外部信帶有 X-AtWho-Form 等「表單標記」時設為 1；一律不啟用表單（僅供顯示／稽核）
ALTER TABLE messages ADD COLUMN suspicious_form_claim INTEGER NOT NULL DEFAULT 0;

-- ── 2) 寄件者驗證結果（顯示用；SPF／DKIM／DMARC 通過 ≠ 有權使用表單）──────────
-- 值域：pass／fail／none／unknown；NULL = 未取得（例如內部信或標頭缺失）
ALTER TABLE messages ADD COLUMN sender_spf TEXT;
ALTER TABLE messages ADD COLUMN sender_dkim TEXT;
ALTER TABLE messages ADD COLUMN sender_dmarc TEXT;

CREATE INDEX idx_messages_form_instance ON messages(form_instance_id);

-- ── 3) 表單範本（schema 經白名單驗證後才寫入；外部不可自帶 schema）──────────────
CREATE TABLE form_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  version     INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (key, version)
);

-- ── 4) 表單實例（每個收件人一筆）──────────────────────────────────────────────
CREATE TABLE form_instances (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id          INTEGER NOT NULL REFERENCES form_templates(id),
  message_id           INTEGER NOT NULL REFERENCES messages(id),
  sender_address_id    INTEGER NOT NULL REFERENCES email_addresses(id),
  recipient_address_id INTEGER NOT NULL REFERENCES email_addresses(id),
  status               TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','submitted','revoked','expired')),
  due_at               INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_form_instances_recipient ON form_instances(recipient_address_id, status);
CREATE INDEX idx_form_instances_message   ON form_instances(message_id);
CREATE INDEX idx_form_instances_sender    ON form_instances(sender_address_id, status);
CREATE INDEX idx_form_instances_template  ON form_instances(template_id);

-- ── 5) 回覆（每實例最多一筆；內容永遠當資料，不渲染 HTML）──────────────────────
CREATE TABLE form_responses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id       INTEGER NOT NULL UNIQUE REFERENCES form_instances(id),
  responder_user_id INTEGER NOT NULL REFERENCES users(id),
  payload_json      TEXT NOT NULL,
  submitted_at      INTEGER NOT NULL
);

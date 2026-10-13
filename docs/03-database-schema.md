# 03 — Database Schema（ER Diagram + D1 Tables）

> 對應 PRD §四～§八。所有時間欄位統一 **INTEGER（Unix epoch 毫秒, UTC）**：
> 排序、範圍查詢、備份 cursor 都簡單且無時區 bug。
> 所有 enum 用 TEXT + CHECK 約束。刪除一律 **soft delete**（`deleted_at`）。

## 1. ER Diagram

```mermaid
erDiagram
    USERS ||--o{ EMAIL_ADDRESSES : "擁有"
    USERS ||--o{ MESSAGES : "收/寄"
    EMAIL_ADDRESSES ||--o{ EMAIL_ALIASES : "被指向"
    EMAIL_ADDRESSES ||--o{ MESSAGES : "信箱（Model C scope）"
    MESSAGES ||--o{ ATTACHMENTS : "包含"

    USERS {
        int id PK "AUTOINCREMENT"
        text username UK "登入名稱"
        text display_name
        text password_hash "argon2/bcrypt"
        text status "active|disabled"
        int created_at "epoch ms"
        int updated_at "epoch ms"
    }

    EMAIL_ADDRESSES {
        int id PK "AUTOINCREMENT"
        int user_id FK "擁有者"
        text local_part "小寫"
        text domain "小寫"
        text email UK "local_part@domain"
        text password_hash "可空：NULL = 不可直接登入（Model C）"
        text status "active|disabled|deleted"
        int created_at
        int updated_at
        int deleted_at "soft delete 時間"
    }

    EMAIL_ALIASES {
        int id PK "AUTOINCREMENT"
        text alias_address UK "例如 sales@mydomain.com"
        int target_email_address_id FK "只能指向真實地址"
        text status "active|disabled"
        int created_at
        int updated_at
    }

    MESSAGES {
        int id PK "AUTOINCREMENT"
        int owner_user_id FK
        int address_id FK "所屬信箱地址（Model C scope）"
        text folder "inbox|sent|archive|trash|spam"
        text message_id "原始 Message-ID（可空）"
        text from_address
        text to_address "JSON 陣列"
        text cc "JSON 陣列"
        text subject
        text text_preview "前 500 字"
        int received_at "epoch ms"
        int read_at "null = 未讀"
        text send_status "sent|bounced|failed（寄出用）"
        text raw_r2_key "原始信件物件 key"
        text html_r2_key "sanitized HTML（可空）"
        int created_at
        int updated_at
        int deleted_at
    }

    ATTACHMENTS {
        int id PK "AUTOINCREMENT"
        int message_id FK
        text filename "原始檔名"
        text stored_filename "sanitized 後檔名"
        text content_type
        int size_bytes
        text r2_key UK
        text sha256 "完整性驗證"
        text disposition "attachment|inline"
        int created_at
        int updated_at "供備份 cursor（見 09 文件）"
    }
```

## 2. 建表 SQL（D1 migrations 用）

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE email_addresses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  local_part TEXT NOT NULL,
  domain     TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  password_hash TEXT,          -- NULL = 不能直接登入；有值 = 信箱帳號（Model C）
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','disabled','deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (local_part, domain)
);
CREATE INDEX idx_addr_user ON email_addresses(user_id) WHERE deleted_at IS NULL;

CREATE TABLE email_aliases (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_address            TEXT NOT NULL UNIQUE,
  target_email_address_id  INTEGER NOT NULL REFERENCES email_addresses(id),
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','disabled')),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX idx_alias_target ON email_aliases(target_email_address_id);

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  address_id    INTEGER NOT NULL REFERENCES email_addresses(id),  -- 收信=收件地址；寄信=From 地址
  folder        TEXT NOT NULL DEFAULT 'inbox'
                CHECK (folder IN ('inbox','sent','archive','trash','spam')),
  message_id    TEXT,
  from_address  TEXT NOT NULL,
  to_address    TEXT NOT NULL DEFAULT '[]',   -- JSON 陣列
  cc            TEXT NOT NULL DEFAULT '[]',   -- JSON 陣列
  subject       TEXT,
  text_preview  TEXT,
  received_at   INTEGER NOT NULL,
  read_at       INTEGER,
  send_status   TEXT CHECK (send_status IN ('sent','bounced','failed')),
  raw_r2_key    TEXT NOT NULL,
  html_r2_key   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX idx_msg_owner_folder_time
  ON messages(owner_user_id, folder, received_at DESC);
CREATE INDEX idx_msg_address_folder_time
  ON messages(address_id, folder, received_at DESC);
CREATE INDEX idx_msg_updated ON messages(updated_at) WHERE deleted_at IS NULL;

CREATE TABLE attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES messages(id),
  filename        TEXT NOT NULL,          -- 原始（供顯示）
  stored_filename TEXT NOT NULL,          -- sanitized（供 R2 key）
  content_type    TEXT,
  size_bytes      INTEGER NOT NULL,
  r2_key          TEXT NOT NULL UNIQUE,
  sha256          TEXT,
  disposition     TEXT NOT NULL DEFAULT 'attachment'
                  CHECK (disposition IN ('attachment','inline')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_att_msg ON attachments(message_id);
```

## 3. 設計決策與理由

| 決策 | 理由 |
|---|---|
| `email` 直接存完整字串 + UNIQUE | Worker 收信查詢只需一次等值 lookup（`WHERE email = ?`），配合 index 極快；不需要拆欄比對 |
| 同時保留 `(local_part, domain)` UNIQUE | 資料完整性雙保險 |
| Alias target 只能指向 `email_addresses` | **結構上排除 alias chain → loop 不可能**（PRD §五要求） |
| `messages.to_address / cc` 用 JSON 文字 | MVP 不需正規化多對多收件人；寄信時可用於回顯 |
| `folder` 涵蓋 inbox/sent/archive/trash/spam | PRD §七要求；`trash` + `deleted_at` 實作 soft delete |
| `send_status` 只對寄出信件使用 | bounce（NDR）回來時由收信 Worker 更新對應 sent message（見 02 文件） |
| `updated_at` + `deleted_at` 全部存在 | 供備份 Agent 做 incremental cursor（見 09 文件） |
| `email_addresses.password_hash`（可空） | Model C：有密碼的地址 = 可獨立登入的信箱帳號；NULL = 只能由 owner 管理 |
| `messages.address_id`（信件所屬信箱） | Model C scope 主鍵：信箱帳號登入只看得到該 address 的信；`owner_user_id` 保留供 owner 聚合與備份 |
| 時間用 epoch ms INTEGER | 排序正確、SQLite 友好、備份比對簡單 |

## 4. 未來擴充預留（MVP 不實作）

- `messages` 可加 `conversation_id` / threading（之後再評估）
- Spam 評分欄位（若需要自建過濾）
- 若未來需要「一封寄給多個自己地址的信同時出現在多個 inbox」→ 拆 `message_recipients` 表（現階段每封信歸屬單一 owner）

## 5. Phase 1 追加：訪客註冊（migration `0006_visitor_registration.sql`，2026-10-12）

> 依據 `docs/13` v0.2（邀請制註冊，訪客可寄信）與 `docs/14` §4.1。
> 全部為 **additive**（ALTER TABLE ADD COLUMN／CREATE TABLE），不含破壞性語句。

### 5.1 新增欄位

| 表 | 欄位 | 型別 / 預設 | 說明 |
|---|---|---|---|
| `users` | `role` | TEXT NOT NULL DEFAULT `'owner'`，CHECK(`owner`,`visitor`) | `visitor` = 憑邀請碼註冊的訪客 |
| `users` | `access_email` | TEXT | Cloudflare Access 帶來的邊緣身分（**僅稽核**，非授權依據，R5） |
| `email_addresses` | `can_send` | INTEGER NOT NULL DEFAULT 1 | 0 = 完全不可寄（安全閥 C8，改一個欄位即秒級生效） |
| `email_addresses` | `daily_send_quota` | INTEGER NOT NULL DEFAULT 20 | 每日寄信上限（C1；預設值單一來源＝程式 `QUOTA` 常數） |
| `email_addresses` | `sent_today` | INTEGER NOT NULL DEFAULT 0 | 當日已寄封數（每日 00:00 UTC 重置） |
| `email_addresses` | `quota_reset_at` | INTEGER | 下次重置時間（epoch ms）；NULL = 尚未初始化 |
| `email_addresses` | `first_send_at` | INTEGER | 首次寄信時間（暖機期紀錄） |

### 5.2 新增表

```sql
CREATE TABLE invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,   -- 隨機 ≥24 字元（crypto.getRandomValues）
  created_by  INTEGER NOT NULL REFERENCES users(id),
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,                -- NULL = 不過期
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_invites_status ON invites(status, expires_at);

CREATE TABLE registration_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event        TEXT NOT NULL,   -- register_ok / register_rejected / login_failed /
                                -- send_rejected_quota / send_rejected_rate / send_rejected_notallowed / auto_suspended
  user_id      INTEGER,
  address_id   INTEGER,
  access_email TEXT,
  ip           TEXT,
  user_agent   TEXT,
  detail       TEXT,            -- JSON（不得含邀請碼全碼／密碼／token）
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_reg_audit_time  ON registration_audit(created_at DESC);
CREATE INDEX idx_reg_audit_event ON registration_audit(event, created_at DESC);
```

### 5.3 設計決策

| 決策 | 理由 |
|---|---|
| 邀請碼扣次數用**原子 UPDATE**（`WHERE used_count < max_uses`，看 `meta.changes`） | 併發下最後一次不會被用兩次（docs/13 §8.3 第 4 點） |
| 撤銷邀請碼為 **soft（`status='revoked'`）** | 與全系統 soft delete 一致，保留追責軌跡 |
| `users.status` 的「停權」以既有 `'disabled'` 表示 | 0001 的 CHECK 只允許 `active`/`disabled`；改 CHECK 需重建表（破壞性）→ API 詞彙 `suspended` 對映 DB `disabled` |
| 配額欄位放在 `email_addresses` 而非 `users` | 配額是「地址」的屬性（owner 一個 user 有多個地址），且原子扣額以地址為單位 |
| `registration_audit` **不納入備份鏡像** | 量大且非信件／身分資料；D1 遺失時可接受（docs/13 §7.2） |
| `invites` **納入**備份鏡像 | 邀請碼是問責依據；不備份則 D1 還原後所有未用邀請碼消失（`09`、`packages/backup-agent/migrations/0003`） |
